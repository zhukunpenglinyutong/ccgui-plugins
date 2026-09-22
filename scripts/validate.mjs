#!/usr/bin/env node
/**
 * ccgui-plugins 索引仓校验器（PR CI / main 全量复检共用，零依赖，Node ≥ 20）。
 *
 * 校验层级：
 *  1. 结构：community-plugins.json 唯一性/字典序 ↔ plugins/<id>.json 交叉引用
 *  2. 登记条目 schema（id/repo/tier/version/permissions/sha256/minAppVersion/sdkVersion）
 *  3. 远端：下载 GitHub Release 产物（tag 必须 == version，无 v 前缀）→
 *     SHA256 比对、体积上限、黑名单扫描、CSS 静态解析、README/LICENSE 存在性、
 *     Release manifest 与登记条目一致性、权限-代码比对（ctx 调用启发式）
 *  4. PR 模式（--base）：version 单调递增、权限新增标记（新增 → 禁止自动合并）
 *
 * 用法：
 *   node scripts/validate.mjs --all                          # 全量（push to main）
 *   node scripts/validate.mjs --base origin/main             # PR：远端核查只跑变动条目
 *   附加：--report <path>（Markdown 审核报告） --result <path>（机器可读结果）
 *
 * 权限白名单镜像 desktop-cc-gui packages/plugin-sdk/spec/permissions.json
 * （单一事实源）；宿主升级白名单时此处必须同步。
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMUNITY_FILE = "community-plugins.json";
const PLUGINS_DIR = "plugins";

// ---------------------------------------------------------------------------
// 权限白名单（镜像 plugin-sdk/spec/permissions.json；勿在此独断修改）
// ---------------------------------------------------------------------------
const KNOWN_PERMISSIONS = new Set([
  "storage",
  "ui:settings-section",
  "ui:add-menu",
  "ui:composer-status",
  "ui:panel-tab",
  "ui:status-bar",
  "ui:command",
  "ui:session-menu",
  "ui:markdown",
  "ui:page",
  "ui:timeline-row",
  "ui:sidebar-entry",
  "ui:center-tab",
  "agent",
  "theme",
  "i18n",
  "events",
  "network:none",
  "composer:draft",
  "host:session",
  "host:workspace",
  "host:workspace:remote",
]);

/** network: 授权体：<host>（任意端口）/ <host>:<port> / <host>:<a>-<b>（含端点）。 */
const NETWORK_GRANT_RE = /^([A-Za-z0-9.-]+)(?::(\d+)(?:-(\d+))?)?$/;
/** exec: 授权的二进制名：裸名，禁路径分隔符。 */
const EXEC_BIN_RE = /^[A-Za-z0-9._-]+$/;

export function isKnownPermission(p) {
  if (KNOWN_PERMISSIONS.has(p)) return true;
  if (p.startsWith("network:")) {
    const body = p.slice("network:".length);
    if (body.toLowerCase() === "none") return false; // network:none 是基座权限，不是授权
    const m = NETWORK_GRANT_RE.exec(body);
    if (!m) return false;
    if (m[2] === undefined) return true;
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    return from >= 1 && to <= 65535 && from <= to;
  }
  if (p.startsWith("exec:")) return EXEC_BIN_RE.test(p.slice("exec:".length));
  return false;
}

// ---------------------------------------------------------------------------
// semver（规范只允许三段数字，无 pre-release）
// ---------------------------------------------------------------------------
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function parseSemver(v) {
  if (typeof v !== "string" || !SEMVER_RE.test(v)) return null;
  return v.split(".").map(Number);
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// schema 常量
// ---------------------------------------------------------------------------
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SDK_RANGE_RE = /^(\^|~|>=)?\d+\.\d+(\.\d+)?$|^\*$/;
const TIERS = new Set(["declarative", "js"]);
const ENTRY_KEYS = new Set([
  "id", "repo", "tier", "version", "minAppVersion", "sdkVersion",
  "permissions", "sha256", "delisted", "pubkey", "icon", "screenshots",
]);
const COMMUNITY_KEYS = new Set(["id", "repo", "name", "description", "author"]);

/** 展示素材（SPEC-CHANGELOG v0.2）：manifest 声明，机器人镜像进索引。 */
const MAX_SCREENSHOTS = 5;
const MAX_MEDIA_PATH_CHARS = 1024;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif)$/i;

/**
 * 校验一条展示素材路径并归一化：接受仓库内相对路径或绝对 https URL。
 * 拒绝其他 scheme、协议相对/绝对路径、反斜杠、控制字符、`..` 逃逸与
 * 非图片扩展名——与宿主 `resolve_asset_url` 的放行面一致，多一条扩展名
 * 检查（App 遇到非图片只会渲染成破图，在登记入口拦下）。
 * @returns {string|null} 归一化后的路径；null = 不合法。
 */
export function normalizeMediaPath(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_MEDIA_PATH_CHARS) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed.includes("\\")) return null;
  if (!IMAGE_EXT_RE.test(trimmed.split(/[?#]/, 1)[0])) return null;
  if (/^https:\/\//i.test(trimmed)) {
    try {
      return new URL(trimmed).toString();
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//") || trimmed.startsWith("/")) {
    return null;
  }
  if (trimmed.split("/").some((segment) => segment === "..")) return null;
  return trimmed;
}

/** manifest 里的 icon / screenshots 共用的形状校验；返回错误句子或 null。 */
export function mediaFieldProblem(label, value) {
  if (label === "icon") {
    return normalizeMediaPath(value) === null
      ? `icon 不合法（需仓库内相对路径或 https URL，图片扩展名，≤ ${MAX_MEDIA_PATH_CHARS} 字符）`
      : null;
  }
  if (!Array.isArray(value)) return `${label} 必须是字符串数组`;
  if (value.length > MAX_SCREENSHOTS) return `${label} 超过 ${MAX_SCREENSHOTS} 张`;
  for (const shot of value) {
    if (normalizeMediaPath(shot) === null) return `${label} 含不合法路径 ${JSON.stringify(shot)}`;
  }
  return null;
}

/**
 * 去掉展示素材字段后的规范化 JSON：判断「同版本的 PR 是否只在登记素材」。
 * 字段顺序归一化后比较，避免 JSON 键序差异造成误判。
 */
function canonicalEntryWithoutMedia(entry) {
  const copy = {};
  for (const key of Object.keys(entry).sort()) {
    if (key === "icon" || key === "screenshots") continue;
    const value = entry[key];
    copy[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, value[k]]))
        : value;
  }
  return JSON.stringify(copy);
}

export const MAIN_WARN_BYTES = 512 * 1024; // 规范 §4：bundle ≤ 512KB 警告
export const MAIN_MAX_BYTES = 2 * 1024 * 1024; // 规范 §4：2MB 硬上限（gzip 前）
const REPORT_MAX_CHARS = 60_000; // GitHub 评论上限 65536

// bundle 黑名单（规范 §9.1 门禁）
export const JS_BLACKLIST = [
  { re: /\beval\s*\(/, label: "eval(" },
  { re: /new\s+Function\s*\(/, label: "new Function(" },
  { re: /__TAURI__/, label: "__TAURI__" },
  { re: /\blocalStorage\b/, label: "localStorage" },
  { re: /import\s*\(\s*['"`]https?:\/\//, label: "远程 import(" },
];

/**
 * localStorage 例外插件（仓库维护者审核后手动登记，插件作者无法在自己
 * manifest/代码里自行声明豁免）：ctx.storage 是插件私有 KV，物理上读不到
 * 宿主自己的 UI 持久化键（ccgui-next.* 等），部分插件靠读写这些公开约定
 * 键实现「获取当前 tab/会话状态」等能力，没有替代的官方 API。
 *
 * 豁免是整体放行（不逐 key 静态解析）：压缩后的 bundle 里字符串常被拼接/
 * 模板化（如 `prefix + key`），正则无法可靠还原运行时真实访问的 key，
 * 伪装成精确检测反而是假的安全感。真正的把关在登记环节——只有仓库维护者
 * 改这份脚本才能新增豁免，插件作者无法自行在 manifest/代码里声明绕过；
 * 新增前必须人工审过该插件的源码，确认用途确实是访问
 * ALLOWED_LOCALSTORAGE_KEY_PREFIXES 描述的宿主约定键，不是任意读写。
 */
const LOCALSTORAGE_EXEMPT_PLUGIN_IDS = new Set(["model-switcher"]);
/** 豁免插件实际访问的 key 前缀（文档性说明，供审核者核对源码时参考，
 *  不参与自动化判定）：宿主 UI 状态（ccgui-next.*）与插件自身的远程
 *  降级缓存（ccgui.plugin.remote:<pluginId>:*，remote-storage.ts 对
 *  ctx.storage 的封装层，与直接绕过沙箱无关）。 */
const ALLOWED_LOCALSTORAGE_KEY_PREFIXES = ["ccgui-next.", "ccgui.plugin.remote:"];
export const CSS_BLACKLIST = [
  { re: /@import\b/i, label: "@import" },
  { re: /url\(\s*['"]?https?:\/\//i, label: "url(http…)" },
];

// ctx API → 所需权限（权限-代码比对启发式；事实源 plugin-sdk references/api.md）
const CTX_PERMISSION_MAP = [
  { re: /ctx\.ui\.registerSettingsSection\s*\(/, permission: "ui:settings-section" },
  { re: /ctx\.ui\.registerAddMenuRow\s*\(/, permission: "ui:add-menu" },
  { re: /ctx\.ui\.registerComposerSlot\s*\(/, permission: "ui:composer-status" },
  { re: /ctx\.ui\.registerComposerStatusItem\s*\(/, permission: "ui:composer-status" },
  { re: /ctx\.ui\.registerPanelTab\s*\(/, permission: "ui:panel-tab" },
  { re: /ctx\.ui\.registerStatusBarItem\s*\(/, permission: "ui:status-bar" },
  { re: /ctx\.ui\.registerComposerStatusItem\s*\(/, permission: "ui:composer-status" },
  { re: /ctx\.ui\.registerCommand\s*\(/, permission: "ui:command" },
  { re: /ctx\.ui\.registerMarkdownRenderer\s*\(/, permission: "ui:markdown" },
  { re: /ctx\.ui\.registerPage\s*\(/, permission: "ui:page" },
  { re: /ctx\.ui\.registerTimelineRowRenderer\s*\(/, permission: "ui:timeline-row" },
  { re: /ctx\.ui\.registerSidebarNav\s*\(/, permission: "ui:sidebar-entry" },
  { re: /ctx\.ui\.registerCenterTab\s*\(/, permission: "ui:center-tab" },
  { re: /ctx\.ui\.openCenterTab\s*\(/, permission: "ui:center-tab" },
  { re: /ctx\.agent\./, permission: "agent" },
  { re: /ctx\.theme\./, permission: "theme" },
  { re: /ctx\.i18n\./, permission: "i18n" },
  { re: /ctx\.storage\./, permission: "storage" },
  { re: /ctx\.events\./, permission: "events" },
  { re: /ctx\.workspaces\.add\s*\(/, permission: "host:workspace" },
  { re: /ctx\.sessions\./, permission: "host:session" },
];
const BRIDGE_NETWORK_RE = /plugin_http_request/;
const BRIDGE_EXEC_RE = /plugin_exec_(run|spawn)/;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function fmtSize(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

function loadJson(relPath, errors) {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relPath), "utf8"));
  } catch (err) {
    errors.push(`${relPath} 解析失败：${err.message}`);
    return null;
  }
}

function gitShow(base, relPath) {
  const r = spawnSync("git", ["show", `${base}:${relPath}`], {
    cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

function gitChangedFiles(base) {
  const r = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    cwd: ROOT, encoding: "utf8",
  });
  if (r.status !== 0) return null;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** 下载 Release 附件；404 与其他错误分开报。 */
export async function downloadAsset(repo, tag, file) {
  const url = `https://github.com/${repo}/releases/download/${tag}/${file}`;
  let res;
  try {
    res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return { error: `网络错误：${err.message}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
  return { buf: Buffer.from(await res.arrayBuffer()) };
}

async function fetchRaw(repo, ref, file) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}`;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// community-plugins.json 全局校验
// ---------------------------------------------------------------------------
export function validateCommunityList(list, errors, warnings) {
  if (!Array.isArray(list)) {
    errors.push(`${COMMUNITY_FILE} 必须是数组`);
    return;
  }
  const seen = new Set();
  let prev = null;
  for (const [i, item] of list.entries()) {
    const where = `${COMMUNITY_FILE}[${i}]`;
    if (typeof item !== "object" || item === null) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    for (const k of Object.keys(item)) {
      if (!COMMUNITY_KEYS.has(k)) warnings.push(`${where} 含未知字段 "${k}"`);
    }
    for (const k of ["id", "repo", "name", "description", "author"]) {
      if (typeof item[k] !== "string" || !item[k].trim()) errors.push(`${where}.${k} 缺失或不是非空字符串`);
    }
    if (typeof item.id === "string") {
      if (!ID_RE.test(item.id)) errors.push(`${where}.id "${item.id}" 不合法（${ID_RE}）`);
      if (seen.has(item.id)) errors.push(`${where}.id "${item.id}" 重复`);
      seen.add(item.id);
      if (prev !== null && item.id.localeCompare(prev) <= 0) {
        errors.push(`${COMMUNITY_FILE} 未按 id 字典序排列："${prev}" 之后出现 "${item.id}"`);
      }
      prev = item.id;
    }
    if (typeof item.repo === "string" && !REPO_RE.test(item.repo)) {
      errors.push(`${where}.repo "${item.repo}" 不合法（需 owner/repo 形式）`);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// plugins/<id>.json schema 校验
// ---------------------------------------------------------------------------
export function validateEntry(entry, fileName, errors, warnings) {
  const where = `${PLUGINS_DIR}/${fileName}`;
  if (typeof entry !== "object" || entry === null) {
    errors.push(`${where} 必须是对象`);
    return;
  }
  for (const k of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(k)) warnings.push(`${where} 含未知字段 "${k}"`);
  }
  if (typeof entry.id !== "string" || !ID_RE.test(entry.id)) {
    errors.push(`${where}.id 不合法（${ID_RE}）`);
  } else if (entry.id !== fileName.replace(/\.json$/, "")) {
    errors.push(`${where}.id "${entry.id}" 与文件名 "${fileName}" 不一致`);
  }
  if (typeof entry.repo !== "string" || !REPO_RE.test(entry.repo)) {
    errors.push(`${where}.repo 不合法（需 owner/repo 形式）`);
  }
  if (!TIERS.has(entry.tier)) {
    errors.push(`${where}.tier "${entry.tier}" 不合法：只能是 "declarative" 或 "js"`);
  }
  if (!parseSemver(entry.version)) {
    errors.push(`${where}.version "${entry.version}" 不合法：semver 三段数字`);
  }
  if (entry.minAppVersion !== undefined && !parseSemver(entry.minAppVersion)) {
    errors.push(`${where}.minAppVersion "${entry.minAppVersion}" 不合法`);
  }
  if (entry.sdkVersion !== undefined && !SDK_RANGE_RE.test(entry.sdkVersion)) {
    errors.push(`${where}.sdkVersion "${entry.sdkVersion}" 不合法：支持 "*"、精确三段、"^x.y(.z)"、"~x.y.z"、">=x.y.z"`);
  }
  if (entry.delisted !== undefined && typeof entry.delisted !== "boolean") {
    errors.push(`${where}.delisted 必须是布尔值`);
  }
  for (const field of ["icon", "screenshots"]) {
    if (entry[field] === undefined) continue;
    const problem = mediaFieldProblem(field, entry[field]);
    if (problem) errors.push(`${where}.${problem}`);
  }
  const permissions = entry.permissions ?? [];
  if (!Array.isArray(permissions)) {
    errors.push(`${where}.permissions 必须是字符串数组`);
  } else {
    for (const p of permissions) {
      if (typeof p !== "string" || !isKnownPermission(p)) {
        errors.push(`${where}.permissions 含未知权限 "${p}"`);
      }
    }
  }
  const sha = entry.sha256;
  if (typeof sha !== "object" || sha === null) {
    errors.push(`${where}.sha256 缺失（必须登记每个 Release 附件的 SHA256）`);
  } else {
    if (typeof sha["manifest.json"] !== "string" || !SHA256_RE.test(sha["manifest.json"])) {
      errors.push(`${where}.sha256["manifest.json"] 缺失或不合法（64 位小写 hex）`);
    }
    if (entry.tier === "js" && (typeof sha["main.js"] !== "string" || !SHA256_RE.test(sha["main.js"]))) {
      errors.push(`${where}.sha256["main.js"] 缺失或不合法（tier=js 必须有 main.js）`);
    }
    for (const [file, hash] of Object.entries(sha)) {
      if (!["main.js", "manifest.json", "styles.css"].includes(file)) {
        errors.push(`${where}.sha256 含非法附件名 "${file}"（只允许 main.js/manifest.json/styles.css）`);
      } else if (file === "manifest.json" || (file === "main.js" && entry.tier === "js")) {
        continue; // 已在上方必填检查中报过
      } else if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
        errors.push(`${where}.sha256["${file}"] 不合法（64 位小写 hex）`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 远端核查：Release 产物 / SHA256 / 体积 / 黑名单 / manifest 一致性
// ---------------------------------------------------------------------------
async function checkRelease(entry, errors, warnings, report) {
  const { id, repo, version, tier } = entry;
  const tag = version; // 规范 §4：tag 必须 == version，无 v 前缀
  const assets = ["manifest.json"];
  if (tier === "js") assets.push("main.js");
  if (entry.sha256["styles.css"]) assets.push("styles.css");

  const downloaded = {};
  for (const file of assets) {
    const r = await downloadAsset(repo, tag, file);
    if (r.error) {
      errors.push(
        `${id}: 下载 ${file} 失败（${r.error}）：https://github.com/${repo}/releases/download/${tag}/${file}` +
        (r.status === 404 ? ` —— 检查 Release tag 是否恰好等于 version "${version}"（无 v 前缀）且附件已上传` : ""),
      );
      return;
    }
    downloaded[file] = r.buf;
    const hash = sha256Hex(r.buf);
    if (hash !== entry.sha256[file]) {
      errors.push(
        `${id}: ${file} SHA256 不符（索引 ${entry.sha256[file].slice(0, 12)}… ≠ 实际 ${hash.slice(0, 12)}…）` +
        `——产物必须由仓库 release.yml Action 从源码构建，禁止手工替换`,
      );
    }
    report.artifacts.push(`${file} ${fmtSize(r.buf.length)} ${hash === entry.sha256[file] ? "✅" : "❌ sha256"}`);
  }

  // 体积
  const main = downloaded["main.js"];
  if (main) {
    if (main.length > MAIN_MAX_BYTES) {
      errors.push(`${id}: main.js ${fmtSize(main.length)} 超过 2MB 硬上限`);
    } else if (main.length > MAIN_WARN_BYTES) {
      warnings.push(`${id}: main.js ${fmtSize(main.length)} 超过 512KB 警告阈值`);
    }
  }

  // 黑名单扫描
  if (main) {
    const text = main.toString("utf8");
    for (const { re, label } of JS_BLACKLIST) {
      if (!re.test(text)) continue;
      if (label === "localStorage" && LOCALSTORAGE_EXEMPT_PLUGIN_IDS.has(id)) {
        // 整体豁免而非逐 key 静态解析：压缩后的 bundle 里字符串常被拼接/
        // 模板化（如 remote-storage.ts 的 `prefix + key`），正则无法可靠
        // 还原运行时真实访问的 key，伪装成精确检测反而是假的安全感。
        // 豁免登记于 LOCALSTORAGE_EXEMPT_PLUGIN_IDS，只有仓库维护者改脚本
        // 才能新增——插件作者无法自行在 manifest/代码里声明绕过。
        warnings.push(`${id}: main.js 使用 localStorage（已登记豁免——读写宿主 UI 状态公开约定键 ${ALLOWED_LOCALSTORAGE_KEY_PREFIXES.join("/")}*，无替代官方 API，人工审核过，见 scripts/validate.mjs 注释）`);
        continue;
      }
      errors.push(`${id}: main.js 命中黑名单 "${label}"（规范 §9.1 门禁）`);
    }
  }
  const css = downloaded["styles.css"];
  if (css) {
    const text = css.toString("utf8");
    for (const { re, label } of CSS_BLACKLIST) {
      if (re.test(text)) errors.push(`${id}: styles.css 命中禁止项 "${label}"`);
    }
  }

  // Release manifest 与登记条目一致性
  let manifest = null;
  try {
    manifest = JSON.parse(downloaded["manifest.json"].toString("utf8"));
  } catch (err) {
    errors.push(`${id}: Release manifest.json 解析失败：${err.message}`);
    return;
  }
  if (manifest.id !== id) errors.push(`${id}: Release manifest.id "${manifest.id}" ≠ 索引 id`);
  if (manifest.version !== version) {
    errors.push(`${id}: Release manifest.version "${manifest.version}" ≠ 索引 version "${version}"（tag/manifest/索引三者必须一致）`);
  }
  if (manifest.tier !== tier) errors.push(`${id}: Release manifest.tier "${manifest.tier}" ≠ 索引 tier "${tier}"`);
  if (manifest.repo !== undefined && manifest.repo !== repo) {
    errors.push(`${id}: Release manifest.repo "${manifest.repo}" ≠ 索引 repo "${repo}"`);
  }
  if (manifest.repo === undefined) warnings.push(`${id}: Release manifest 缺 repo 字段（规范 §5 要求）`);
  const mp = [...(manifest.permissions ?? [])].sort();
  const ep = [...(entry.permissions ?? [])].sort();
  if (JSON.stringify(mp) !== JSON.stringify(ep)) {
    errors.push(`${id}: 权限清单不一致——manifest [${mp.join(", ")}] ≠ 索引 [${ep.join(", ")}]`);
  }
  if (manifest.minAppVersion !== undefined && manifest.minAppVersion !== entry.minAppVersion) {
    errors.push(`${id}: manifest.minAppVersion "${manifest.minAppVersion}" 与索引 "${entry.minAppVersion}" 不一致`);
  }
  if (typeof manifest.name === "string" && [...manifest.name].length > 30) {
    errors.push(`${id}: manifest.name 超过 30 字符（规范 §5）`);
  }
  if (typeof manifest.description === "string" && [...manifest.description].length > 120) {
    errors.push(`${id}: manifest.description 超过 120 字符（规范 §5）`);
  }
  if (Array.isArray(manifest.keywords) && manifest.keywords.length > 8) {
    errors.push(`${id}: manifest.keywords 超过 8 个（规范 §5）`);
  }
  // 展示素材：索引里的值可能是索引侧单独维护的（只改素材不改版本的 PR），
  // 所以不要求与 Release manifest 相等；但 manifest 里写了就必须合法，
  // 否则下一次版本登记会把坏路径镜像进索引。
  for (const field of ["icon", "screenshots"]) {
    if (manifest[field] === undefined) continue;
    const problem = mediaFieldProblem(field, manifest[field]);
    if (problem) errors.push(`${id}: manifest.${problem}（规范 §5.1）`);
  }

  // 权限-代码比对（启发式，漏声明 = 错误；多声明 = 警告请审核员裁量）
  if (main && Array.isArray(manifest.permissions)) {
    const text = main.toString("utf8");
    const declared = new Set(manifest.permissions);
    for (const { re, permission } of CTX_PERMISSION_MAP) {
      if (re.test(text) && !declared.has(permission)) {
        errors.push(`${id}: 代码使用 ${re.source.replace(/\\/g, "")} 但未声明权限 "${permission}"`);
      }
    }
    if (BRIDGE_NETWORK_RE.test(text) && ![...declared].some((p) => p.startsWith("network:"))) {
      errors.push(`${id}: 代码调用 plugin_http_request 但未声明任何 network: 授权`);
    }
    if (BRIDGE_EXEC_RE.test(text) && ![...declared].some((p) => p.startsWith("exec:"))) {
      errors.push(`${id}: 代码调用 plugin_exec_* 但未声明任何 exec: 授权`);
    }
    const used = new Set(CTX_PERMISSION_MAP.filter(({ re }) => re.test(text)).map((m) => m.permission));
    // host:workspace:remote 是 ctx.workspaces.add 携带 wsl meta 时的升级修饰，
    // 同一调用点，无法靠静态启发式区分；host:workspace 已检出即视为在用。
    if (used.has("host:workspace")) used.add("host:workspace:remote");
    for (const p of declared) {
      if (KNOWN_PERMISSIONS.has(p) && p !== "network:none" && !used.has(p)) {
        warnings.push(`${id}: 声明了权限 "${p}" 但未在代码中检出对应调用（请审核员确认是否多余）`);
      }
    }
  }

  // README / LICENSE（规范 §4 必须）
  const [hasReadme, hasLicense] = await Promise.all([
    fetchRaw(repo, tag, "README.md"),
    fetchRaw(repo, tag, "LICENSE"),
  ]);
  if (!hasReadme) errors.push(`${id}: 仓库根缺 README.md（市场详情页直接渲染它）`);
  if (!hasLicense) errors.push(`${id}: 仓库根缺 LICENSE（规范 §4 必须）`);
  report.readme = hasReadme;
  report.license = hasLicense;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const opt = { all: false, base: null, report: null, result: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--all") opt.all = true;
    else if (argv[i] === "--base") opt.base = argv[++i];
    else if (argv[i] === "--report") opt.report = argv[++i];
    else if (argv[i] === "--result") opt.result = argv[++i];
    else { console.error(`未知参数：${argv[i]}`); process.exit(2); }
  }
  if (!opt.all && !opt.base) {
    console.error("用法：validate.mjs --all | --base <git-ref> [--report p] [--result p]");
    process.exit(2);
  }

  const errors = [];
  const warnings = [];
  const reportSections = [];
  const resultEntries = [];
  const permissionsAdded = [];
  const mediaOnlyEntries = [];

  // 1. 全局结构
  const community = loadJson(COMMUNITY_FILE, errors);
  const communityIds = community ? validateCommunityList(community, errors, warnings) ?? new Set() : new Set();
  const pluginFiles = existsSync(path.join(ROOT, PLUGINS_DIR))
    ? readdirSync(path.join(ROOT, PLUGINS_DIR)).filter((f) => f.endsWith(".json"))
    : [];
  const pluginIds = new Set(pluginFiles.map((f) => f.replace(/\.json$/, "")));
  for (const id of communityIds) {
    if (!pluginIds.has(id)) errors.push(`${COMMUNITY_FILE} 列出了 "${id}" 但缺 ${PLUGINS_DIR}/${id}.json`);
  }
  for (const id of pluginIds) {
    if (!communityIds.has(id)) errors.push(`${PLUGINS_DIR}/${id}.json 存在但未登记进 ${COMMUNITY_FILE}`);
  }

  // 2. 决定远端核查范围
  let changedFiles = null;
  if (opt.base) {
    changedFiles = gitChangedFiles(opt.base);
    if (changedFiles === null) {
      errors.push(`git diff ${opt.base}...HEAD 失败（CI 需 fetch-depth: 0）`);
    }
  }
  const idsToCheck = opt.all
    ? [...pluginIds].sort()
    : [...new Set((changedFiles ?? [])
        .filter((f) => /^plugins\/[^/]+\.json$/.test(f))
        .map((f) => f.replace(/^plugins\//, "").replace(/\.json$/, "")))].sort();

  // 3. 逐条目核查
  for (const id of idsToCheck) {
    const file = `${id}.json`;
    const entry = loadJson(`${PLUGINS_DIR}/${file}`, errors);
    if (!entry) continue;
    validateEntry(entry, file, errors, warnings);
    if (!entry.repo || !entry.version || !entry.tier) continue; // schema 已挂，远端无意义

    const report = { id, version: entry.version, tier: entry.tier, artifacts: [], readme: null, license: null, addedPerms: [] };

    // PR 模式：单调版本 + 权限 diff
    if (opt.base) {
      const baseText = gitShow(opt.base, `${PLUGINS_DIR}/${file}`);
      if (baseText) {
        let baseEntry = null;
        try { baseEntry = JSON.parse(baseText); } catch { /* 旧文件坏也由新校验兜底 */ }
        if (baseEntry) {
          const cmp = compareSemver(entry.version, baseEntry.version);
          const delistOnly = entry.delisted !== baseEntry.delisted && cmp === 0;
          // 同版本上只动 icon/screenshots（索引侧单独登记素材，见
          // SPEC-CHANGELOG v0.2）：允许，但排除在自动合并之外——素材是用户
          // 可见内容，不在「产物 SHA256 已核对」的自动信任范围内。
          const mediaOnly =
            cmp === 0 &&
            canonicalEntryWithoutMedia(entry) === canonicalEntryWithoutMedia(baseEntry);
          if (mediaOnly) mediaOnlyEntries.push(id);
          if (cmp !== null && cmp <= 0 && !delistOnly && !mediaOnly) {
            errors.push(`${id}: version "${entry.version}" 未严格大于已登记版本 "${baseEntry.version}"（规范 §5 单调规则）`);
          }
          if (baseEntry.delisted === true && cmp !== null && cmp > 0) {
            errors.push(`${id}: 已下架（delisted）插件不接受版本登记，请先由维护者恢复`);
          }
          const basePerms = new Set(baseEntry.permissions ?? []);
          for (const p of entry.permissions ?? []) {
            if (!basePerms.has(p)) report.addedPerms.push(p);
          }
        }
      }
    }
    if (report.addedPerms.length) {
      warnings.push(`${id}: 新增权限 ${report.addedPerms.map((p) => `+${p}`).join(" ")} —— 需人工审核，禁止自动合并`);
      permissionsAdded.push(`${id}: ${report.addedPerms.join(", ")}`);
    }

    // 远端核查
    await checkRelease(entry, errors, warnings, report);
    resultEntries.push({ id, repo: entry.repo, version: entry.version });

    // 审核报告段落
    const netPerms = (entry.permissions ?? []).filter((p) => p.startsWith("network:"));
    const execPerms = (entry.permissions ?? []).filter((p) => p.startsWith("exec:"));
    reportSections.push([
      `### \`${id}\` v${entry.version}（${entry.tier}）`,
      ``,
      `- 仓库：[${entry.repo}](https://github.com/${entry.repo}) · Release tag \`${entry.version}\``,
      `- 产物：${report.artifacts.join(" · ") || "（下载失败）"}`,
      `- 权限（${(entry.permissions ?? []).length}）：${(entry.permissions ?? []).join(", ") || "无"}`,
      netPerms.length ? `- 网络域名：${netPerms.map((p) => p.slice(8)).join(", ")}` : null,
      execPerms.length ? `- ⚠️ 进程执行：${execPerms.map((p) => p.slice(5)).join(", ")}（任意代码执行能力，重点审核）` : null,
      report.readme === null ? null : `- README：${report.readme ? "✅" : "❌"} · LICENSE：${report.license ? "✅" : "❌"}`,
      entry.icon || (entry.screenshots ?? []).length
        ? `- 展示素材：${entry.icon ? "icon ✅" : "icon —"} · 效果图 ${(entry.screenshots ?? []).length} 张`
        : null,
      report.addedPerms.length ? `- ⚠️ 相对上一版本新增权限：${report.addedPerms.map((p) => `\`${p}\``).join(" ")}` : null,
      ``,
    ].filter((l) => l !== null).join("\n"));
  }

  // 4. 输出
  const summary = [
    `## 插件索引审核报告`,
    ``,
    `- 模式：${opt.all ? "全量" : `PR（base ${opt.base}）`} · 远端核查 ${idsToCheck.length} 个条目`,
    `- 结果：${errors.length ? `❌ ${errors.length} 个错误` : "✅ 通过"}${warnings.length ? ` · ⚠️ ${warnings.length} 个警告` : ""}`,
    ``,
  ];
  if (errors.length) summary.push(`### ❌ 错误`, ...errors.map((e) => `- ${e}`), ``);
  if (warnings.length) summary.push(`### ⚠️ 警告`, ...warnings.map((w) => `- ${w}`), ``);
  let md = [...summary, ...reportSections].join("\n");
  if (md.length > REPORT_MAX_CHARS) md = `${md.slice(0, REPORT_MAX_CHARS)}\n\n…（报告过长已截断）`;

  const versionRegistrationOnly =
    changedFiles !== null &&
    changedFiles.length === 1 &&
    /^plugins\/[^/]+\.json$/.test(changedFiles[0]) &&
    mediaOnlyEntries.length === 0;
  const result = {
    ok: errors.length === 0,
    errors: errors.length,
    warnings: warnings.length,
    changedFiles,
    versionRegistrationOnly,
    permissionsAdded,
    entries: resultEntries,
  };

  if (opt.report) writeFileSync(opt.report, md);
  if (opt.result) writeFileSync(opt.result, JSON.stringify(result, null, 2));
  console.log(md);
  process.exit(errors.length ? 1 : 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`校验器自身异常：${err.stack ?? err}`);
    process.exit(2);
  });
}
