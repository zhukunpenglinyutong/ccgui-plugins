#!/usr/bin/env node
/**
 * 索引自动更新机器人（cron）：轮询已登记插件的 GitHub latest release，
 * 发现新版本 → 下载产物、重算 SHA256、跑安全预检 → 开「版本登记 PR」。
 *
 * 设计要点：
 * - 每个插件一个 PR（分支 bump/<id>-<version>，只动一个 plugins/<id>.json），
 *   配合 review 工作流的 versionRegistrationOnly 自动合并门槛；
 * - 权限新增在此**不拦截**——PR 照常开，由 validate CI 标记、review 工作流
 *   拒绝自动合并转人工（这是既定的审核入口，不是例外路径）；
 * - 安全预检（黑名单/体积/manifest 一致性/tier 漂移）在此先跑一遍，不合格
 *   的版本直接跳过不开 PR（注定过不了 CI 的 PR 没有审计价值，只有噪音）；
 * - 幂等：同分支 PR 已存在则跳过，cron 反复跑不产生重复 PR。
 *
 * 用法：node scripts/bump-versions.mjs [--dry-run] [--only <id>]
 * 环境：GH_TOKEN（gh CLI 用；--dry-run 不需要 git/gh）
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isKnownPermission,
  compareSemver,
  downloadAsset,
  JS_BLACKLIST,
  CSS_BLACKLIST,
  MAIN_MAX_BYTES,
  mediaFieldProblem,
  normalizeMediaPath,
} from "./validate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS_DIR = path.join(ROOT, "plugins");

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} 失败（${r.status}）：${r.stderr?.trim()}`);
  }
  return r.stdout.trim();
}

/** 经 /releases/latest 的 302 跳转解析最新 tag——不消耗 API 配额、无需 token。 */
export async function latestReleaseTag(repo) {
  const url = `https://github.com/${repo}/releases/latest`;
  let res;
  try {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { error: `网络错误：${err.message}` };
  }
  if (res.status === 404) return { tag: null }; // 仓库无 release
  const loc = res.headers.get("location") ?? "";
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(loc);
  if (!m) return { error: `无法解析 latest release（HTTP ${res.status}）` };
  return { tag: decodeURIComponent(m[1]) };
}

/**
 * 核查候选版本并构建新登记条目。
 * @returns {{ entry?: object, skip?: string, notes: string[] }}
 */
export async function buildBumpedEntry(id, old, tag, manifest, assets) {
  const notes = [];
  if (manifest.id !== id) return { notes, skip: `manifest.id "${manifest.id}" ≠ 索引 id "${id}"` };
  if (manifest.version !== tag) {
    return { notes, skip: `manifest.version "${manifest.version}" ≠ Release tag "${tag}"（规范：tag == version，无 v 前缀）` };
  }
  if (manifest.tier !== old.tier) {
    return { notes, skip: `tier 从 "${old.tier}" 变为 "${manifest.tier}"——层级变更必须人工上架` };
  }
  const permissions = manifest.permissions ?? [];
  for (const p of permissions) {
    if (typeof p !== "string" || !isKnownPermission(p)) {
      return { notes, skip: `manifest 含未知权限 "${p}"` };
    }
  }

  // 展示素材（SPEC-CHANGELOG v0.2）：manifest 是事实源；本轮 manifest 没写
  // 的字段保留索引现值——素材可以在两次发版之间单独提索引 PR，机器人不该
  // 在下一次版本登记时把它删掉。要删素材就显式写 "screenshots": []。
  const presentation = {};
  for (const field of ["icon", "screenshots"]) {
    if (manifest[field] === undefined) {
      if (old[field] !== undefined) presentation[field] = old[field];
      continue;
    }
    const problem = mediaFieldProblem(field, manifest[field]);
    if (problem) return { notes, skip: `manifest.${problem}（规范 §5.1）` };
    if (field === "icon") {
      presentation.icon = normalizeMediaPath(manifest.icon);
    } else if (manifest.screenshots.length > 0) {
      presentation.screenshots = manifest.screenshots.map((shot) => normalizeMediaPath(shot));
    }
  }

  // 产物下载 + SHA256 + 安全预检
  const sha256 = {};
  const files = ["manifest.json"];
  if (old.tier === "js") files.push("main.js");
  const bufs = {};
  for (const file of files) {
    const r = await downloadAsset(old.repo, tag, file);
    if (r.error) return { notes, skip: `下载 ${file} 失败（${r.error}）` };
    bufs[file] = r.buf;
    sha256[file] = sha256Hex(r.buf);
  }
  if (assets.includes("styles.css")) {
    const r = await downloadAsset(old.repo, tag, "styles.css");
    if (r.error) return { notes, skip: `下载 styles.css 失败（${r.error}）` };
    bufs["styles.css"] = r.buf;
    sha256["styles.css"] = sha256Hex(r.buf);
  } else if (old.sha256["styles.css"]) {
    notes.push("新版本不含 styles.css（旧版本有），登记中将移除");
  }

  const main = bufs["main.js"];
  if (main) {
    if (main.length > MAIN_MAX_BYTES) {
      return { notes, skip: `main.js ${(main.length / 1024 / 1024).toFixed(2)} MB 超过 2MB 硬上限` };
    }
    const text = main.toString("utf8");
    for (const { re, label } of JS_BLACKLIST) {
      if (re.test(text)) return { notes, skip: `main.js 命中黑名单 "${label}"` };
    }
  }
  if (bufs["styles.css"]) {
    const text = bufs["styles.css"].toString("utf8");
    for (const { re, label } of CSS_BLACKLIST) {
      if (re.test(text)) return { notes, skip: `styles.css 命中禁止项 "${label}"` };
    }
  }

  // 重建条目：manifest 是 version/permissions/兼容字段的事实源；
  // delisted/pubkey 是索引侧管理字段，从旧条目保留。
  const entry = {
    id,
    repo: old.repo,
    tier: old.tier,
    version: tag,
    ...(manifest.minAppVersion ? { minAppVersion: manifest.minAppVersion } : {}),
    ...(manifest.sdkVersion ? { sdkVersion: manifest.sdkVersion } : {}),
    permissions,
    sha256,
    ...presentation,
    ...(old.delisted !== undefined ? { delisted: old.delisted } : {}),
    ...(old.pubkey ? { pubkey: old.pubkey } : {}),
  };
  return { entry, notes };
}

/** Release 的附件清单（判断 styles.css 是否存在；API 不可用回退按旧条目推断）。 */
async function listReleaseAssets(repo, tag) {
  const token = process.env.GH_TOKEN;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.assets ?? []).map((a) => a.name);
  } catch {
    return null;
  }
}

async function planPlugin(id, old) {
  const { tag, error } = await latestReleaseTag(old.repo);
  if (error) return { id, action: "skip", reason: `查询最新 Release 失败：${error}` };
  if (!tag) return { id, action: "skip", reason: "尚无 Release" };
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    return { id, action: "skip", reason: `最新 Release tag "${tag}" 不符合规范（须为 semver 三段、无 v 前缀）` };
  }
  const cmp = compareSemver(tag, old.version);
  if (cmp === null || cmp <= 0) return { id, action: "none", reason: `已是最新（${old.version}）` };

  const r = await downloadAsset(old.repo, tag, "manifest.json");
  if (r.error) return { id, action: "skip", reason: `下载 manifest.json 失败（${r.error}）` };
  let manifest;
  try {
    manifest = JSON.parse(r.buf.toString("utf8"));
  } catch (err) {
    return { id, action: "skip", reason: `manifest.json 解析失败：${err.message}` };
  }

  let assets = await listReleaseAssets(old.repo, tag);
  if (assets === null) {
    // API 不可用：回退为探测下载 styles.css（仅当旧条目登记过或新版本可能有）
    assets = ["manifest.json", "main.js"];
    const probe = await downloadAsset(old.repo, tag, "styles.css");
    if (!probe.error) assets.push("styles.css");
  }

  const { entry, skip, notes } = await buildBumpedEntry(id, old, tag, manifest, assets);
  if (skip) return { id, action: "skip", reason: `${old.version} → ${tag}：${skip}` };

  const oldPerms = new Set(old.permissions ?? []);
  const newPerms = new Set(entry.permissions);
  const added = [...newPerms].filter((p) => !oldPerms.has(p));
  const removed = [...oldPerms].filter((p) => !newPerms.has(p));
  return { id, action: "bump", from: old.version, to: tag, entry, notes, added, removed };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;

  const files = readdirSync(PLUGINS_DIR).filter((f) => f.endsWith(".json")).sort();
  const plans = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, "");
    if (only && id !== only) continue;
    const old = JSON.parse(readFileSync(path.join(PLUGINS_DIR, file), "utf8"));
    if (old.delisted === true) {
      plans.push({ id, action: "skip", reason: "已下架（delisted），不接受版本登记" });
      continue;
    }
    plans.push(await planPlugin(id, old));
  }

  const bumps = plans.filter((p) => p.action === "bump");
  for (const p of plans) {
    if (p.action === "bump") {
      console.log(`⬆ ${p.id}: ${p.from} → ${p.to}${p.added.length ? `（权限新增：${p.added.join(", ")}，将转人工审核）` : ""}`);
    } else if (p.action === "skip") {
      console.log(`⏭ ${p.id}: ${p.reason}`);
    } else {
      console.log(`✓ ${p.id}: ${p.reason}`);
    }
    for (const n of p.notes ?? []) console.log(`   注：${n}`);
  }
  if (dryRun) {
    console.log(`\n[dry-run] 计划开 ${bumps.length} 个版本登记 PR`);
    return;
  }

  for (const p of bumps) {
    const branch = `bump/${p.id}-${p.to}`;
    const existing = run("gh", ["pr", "list", "--head", branch, "--state", "open", "--json", "number", "--jq", "length"]);
    if (existing !== "0") {
      console.log(`⏭ ${p.id}: 分支 ${branch} 已有打开的 PR，跳过`);
      continue;
    }
    const permLines = [
      ...(p.added.length ? [`- ⚠️ 权限新增：${p.added.map((x) => `\`${x}\``).join(" ")}（将转人工审核，不会自动合并）`] : []),
      ...(p.removed.length ? [`- 权限移除：${p.removed.map((x) => `\`${x}\``).join(" ")}`] : []),
      ...(!p.added.length && !p.removed.length ? ["- 权限无变化"] : []),
    ];
    const body = [
      `索引机器人检测到 [\`${p.id}\`](https://github.com/${p.entry.repo}) 发布了新 Release，自动登记版本。`,
      ``,
      `- 版本：\`${p.from}\` → \`${p.to}\``,
      ...permLines,
      `- SHA256 已按 Release 产物重算（见 diff）`,
      ...(p.notes.length ? p.notes.map((n) => `- 注：${n}`) : []),
      ``,
      `CI 校验通过且无权限新增时，review 工作流将自动合并本 PR。`,
    ].join("\n");

    run("git", ["checkout", "-B", branch]);
    writeFileSync(path.join(PLUGINS_DIR, `${p.id}.json`), `${JSON.stringify(p.entry, null, 2)}\n`);
    run("git", ["add", `plugins/${p.id}.json`]);
    run("git", [
      "-c", "user.name=ccgui-index-bot",
      "-c", "user.email=github-actions[bot]@users.noreply.github.com",
      "commit", "-m", `chore: ${p.id} ${p.from} → ${p.to}`,
    ]);
    run("git", ["push", "-u", "origin", branch, "--force-with-lease"]);
    run("gh", ["pr", "create", "--title", `chore: ${p.id} ${p.from} → ${p.to}`, "--body", body, "--head", branch]);
    run("git", ["checkout", "-"]);
    console.log(`✅ ${p.id}: PR 已创建（${branch}）`);
  }
  console.log(`\n完成：${bumps.length} 个版本登记，${plans.filter((p) => p.action === "skip").length} 个跳过`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`机器人异常：${err.stack ?? err}`);
    process.exit(2);
  });
}
