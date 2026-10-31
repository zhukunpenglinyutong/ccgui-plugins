import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  comparePermissionsWithCode,
  fetchWithRetry,
  isKnownPermission,
  validateCommunityList,
  validateEntry,
} from "./validate.mjs";
import { buildBumpedEntry } from "./bump-versions.mjs";

// Behavioral inputs mirrored from plugin-sdk/spec/permissions.json (SDK 0.3.23).
// Exercise the real registration/bump validators, not a second implementation.
const knownPermissions = [
  "storage", "ui:settings-section", "ui:add-menu", "ui:composer-status",
  "ui:panel-tab", "ui:status-bar", "ui:overlay", "ui:command", "ui:markdown",
  "ui:page", "ui:timeline-row", "ui:workspace-menu", "ui:session-menu",
  "ui:file-link-menu", "ui:sidebar-entry", "ui:center-tab", "ui:worktree-badge",
  "ui:conversation-mode", "agent", "theme",
  "i18n", "events", "network:none", "composer:draft", "host:session",
  "host:workspace", "host:workspace:remote", "host:worktree", "host:window",
  "host:models", "usage.read", "limits.read", "session.lifecycle.read", "runtime.events.read",
  "runtime.switch.observe", "prompt.contribute.internal", "workspace.metadata.read",
  "plugin.storage", "assets:bundle", "assets:directory",
];
const ccbPermissions = [
  "storage", "ui:settings-section", "ui:workspace-menu", "i18n", "events",
  "network:none", "session.lifecycle.read", "runtime.events.read",
  "runtime.switch.observe", "prompt.contribute.internal", "workspace.metadata.read",
  "host:workspace", "plugin.storage",
];
const validIds = [
  "ab", "a-", "a.b", "a1-2.b3", "ccgui.client-context-bridge",
  "vendor.plugin2.feature-x", "a".repeat(64), "0a", "0.1", "a-.b-",
  "a." + "b".repeat(62),
];
const invalidIds = [
  "", "a", ".", "..", ".plugin", "plugin.", "a..b", "../plugin", "a/b",
  "a\\b", "Plugin", "-a", "a+b", "a".repeat(65), "a.-b", "a._b", "a.B",
  "a_", "a:b", "a b", " ab", "ab ", "a/../b", "a.%2e%2e.b", "a．b",
  "插件", "éa", "a.é", "a💡", "ab\u2028", "ab\u2029",
  "a." + "b".repeat(63),
  ...Array.from({ length: 33 }, (_, i) => String.fromCharCode(i === 32 ? 127 : i))
    .flatMap((char) => [`${char}ab`, `a${char}b`, `ab${char}`]),
];
const validGrants = [
  "network:127.0.0.1", "network:api.example.com", "network:EXAMPLE.com",
  "network:api.example.com:8443", "network:127.0.0.1:7680-7690",
  "network:host:1-65535", "network:host:1", "network:host:65535",
  "exec:git", "exec:node", "exec:my-cli.v2", "exec:my_cli",
];
const invalidPermissions = [
  "unknown", "ui:unknown", "session.lifecycle.write", "runtime.events.write",
  "runtime.switch.write", "prompt.contribute.external", "workspace.metadata.write",
  "plugin.storage.admin", "assets:unknown", "network:", "network:bad host",
  "network:*.example.com", "network:host:abc", "network:host:99999",
  "network:host:65536", "network:host:0", "network:host:0-80",
  "network:host:90-80", "network:host:1-2-3", "network:host:",
  "network:NONE", "network:none:80", "network:NoNe:1-65535",
  "network:https://example.com", "network:host/path", "network:host\\path",
  "network:host\n", "network:host:80\r", "network:host\0",
  "exec:", "exec:a/b", "exec:../x", "exec:x y", "exec:a\\b",
  "exec:git\n", "exec:git\r", "exec:git\0", "storage\n",
];

function entry(overrides = {}) {
  return {
    id: "sample-plugin",
    repo: "example/sample-plugin",
    tier: "js",
    version: "1.0.2",
    minAppVersion: "1.0.0",
    sdkVersion: ">=0.3.20",
    permissions: ["storage"],
    sha256: { "manifest.json": "a".repeat(64), "main.js": "b".repeat(64) },
    ...overrides,
  };
}

function entryErrors(value, fileName = `${value.id}.json`) {
  const errors = [];
  validateEntry(value, fileName, errors, []);
  return errors;
}

function communityErrors(id) {
  const errors = [];
  validateCommunityList([{
    id, repo: "example/sample-plugin", name: "Sample", description: "Sample plugin",
    author: "Example",
  }], errors, []);
  return errors;
}

function releaseFetch(t, candidate, main = "export function activate() {}") {
  const files = {
    "manifest.json": Buffer.from(JSON.stringify(candidate)),
    "main.js": Buffer.from(main),
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async (url) => {
    const prefix = `https://github.com/${candidate.repo}/releases/download/${candidate.version}/`;
    assert.ok(url.startsWith(prefix), `Unexpected release URL: ${url}`);
    const file = url.slice(prefix.length);
    assert.ok(Object.hasOwn(files, file), `Unexpected release asset: ${file}`);
    return new Response(files[file], { status: 200 });
  });
  return { files, fetchMock };
}

function denyFetch(t) {
  return t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Invalid input must be rejected before downloading");
  });
}

test("registration accepts ordinary and namespaced IDs at byte-length boundaries", () => {
  for (const id of validIds) {
    assert.deepEqual(communityErrors(id), [], JSON.stringify(id));
    assert.deepEqual(entryErrors(entry({ id })), [], JSON.stringify(id));
  }
});

test("registration rejects unsafe IDs in both index and entry validation", () => {
  for (const id of [...invalidIds, null, 12, {}, []]) {
    assert.ok(communityErrors(id).some((error) => error.includes(".id")), JSON.stringify(id));
    assert.ok(entryErrors(entry({ id })).some((error) => error.includes(".id")), JSON.stringify(id));
  }
});

test("namespaced IDs still have to match the registry filename", () => {
  const errors = entryErrors(entry({ id: "vendor.plugin" }), "other.plugin.json");
  assert.ok(errors.some((error) => error.includes("与文件名")));
});

test("CCB registers its unchanged ID and all 13 declared permissions", () => {
  const id = "ccgui.client-context-bridge";
  assert.deepEqual(communityErrors(id), []);
  assert.deepEqual(entryErrors(entry({ id, permissions: ccbPermissions })), []);
});

test("all SDK base permissions and valid network/exec grants are accepted", () => {
  for (const permission of [...knownPermissions, ...validGrants]) {
    assert.equal(isKnownPermission(permission), true, permission);
    assert.deepEqual(entryErrors(entry({ permissions: [permission] })), [], permission);
  }
});

test("unknown permissions and malformed network/exec grants remain rejected", () => {
  for (const permission of invalidPermissions) {
    assert.equal(isKnownPermission(permission), false, JSON.stringify(permission));
    assert.ok(entryErrors(entry({ permissions: [permission] }))
      .some((error) => error.includes("permissions")), JSON.stringify(permission));
  }
});

test("usage.read / limits.read / ui:file-link-menu map to their SDK calls", () => {
  const code = "t.usage.query({}); t.limits.get(); t.ui.registerFileLinkMenuItem({});";
  const missing = comparePermissionsWithCode("usage-limits", [], code);
  for (const permission of ["usage.read", "limits.read", "ui:file-link-menu"]) {
    assert.ok(missing.errors.some((error) => error.includes(`"${permission}"`)), permission);
  }
  const ok = comparePermissionsWithCode(
    "usage-limits",
    ["usage.read", "limits.read", "ui:file-link-menu"],
    code,
  );
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);
});

test("permissions must remain an array of strings", () => {
  for (const permissions of ["storage", {}, [null], [12], [{}]]) {
    assert.ok(entryErrors(entry({ permissions })).some((error) => error.includes("permissions")));
  }
});

test("current registry entries retain schema validity", () => {
  const errors = [];
  const warnings = [];
  const community = JSON.parse(readFileSync(new URL("../community-plugins.json", import.meta.url), "utf8"));
  validateCommunityList(community, errors, warnings);
  const directory = new URL("../plugins/", import.meta.url);
  for (const file of readdirSync(directory).filter((file) => file.endsWith(".json"))) {
    const value = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
    validateEntry(value, file, errors, warnings);
  }
  assert.deepEqual(errors, []);
});

test("bump preflight accepts CCB permissions and produces a valid registration", async (t) => {
  const old = entry({ id: "ccgui.client-context-bridge", version: "1.0.1", permissions: ccbPermissions });
  const candidate = { ...old, version: "1.0.2" };
  const { files, fetchMock } = releaseFetch(t, candidate);
  const result = await buildBumpedEntry(old.id, old, candidate.version, candidate, Object.keys(files));
  assert.equal(result.skip, undefined);
  assert.deepEqual(result.notes, []);
  assert.equal(result.entry.id, old.id);
  assert.equal(result.entry.version, candidate.version);
  assert.deepEqual(result.entry.permissions, ccbPermissions);
  assert.deepEqual(entryErrors(result.entry), []);
  for (const [file, data] of Object.entries(files)) {
    assert.equal(result.entry.sha256[file], createHash("sha256").update(data).digest("hex"));
  }
  assert.equal(fetchMock.mock.calls.length, 2);
});

test("bump records the Release publication time for future market updates", async (t) => {
  const old = entry({ version: "1.0.1", updatedAt: "2026-10-01T00:00:00Z" });
  const candidate = { ...old, version: "1.0.2" };
  const { files } = releaseFetch(t, candidate);
  const publishedAt = "2026-10-28T01:02:03Z";
  const result = await buildBumpedEntry(old.id, old, candidate.version, candidate,
    Object.keys(files), publishedAt);
  assert.equal(result.skip, undefined);
  assert.equal(result.entry.updatedAt, publishedAt);
  assert.deepEqual(entryErrors(result.entry), []);
});

test("bump refreshes every reviewed runtime asset without installing release archives", async (t) => {
  const old = entry({
    version: "1.0.1",
    sha256: {
      "manifest.json": "a".repeat(64), "main.js": "b".repeat(64),
      "vendor-pixi.min.js": "c".repeat(64), "vendor-pixi.LICENSE": "d".repeat(64),
    },
  });
  const candidate = { ...old, version: "1.0.2" };
  const { files } = releaseFetch(t, candidate);
  files["vendor-pixi.min.js"] = Buffer.from("window.PIXI = { version: 'new-runtime' };");
  files["vendor-pixi.LICENSE"] = Buffer.from("Reviewed third-party license");
  const result = await buildBumpedEntry(old.id, old, candidate.version, candidate,
    [...Object.keys(files), "checksums.txt", "plugin-1.0.2.zip"]);
  assert.equal(result.skip, undefined);
  assert.deepEqual(result.entry.sha256, Object.fromEntries(Object.entries(files)
    .map(([name, bytes]) => [name, createHash("sha256").update(bytes).digest("hex")])));
  assert.deepEqual(entryErrors(result.entry), []);
});

test("bump refuses an update that loses a reviewed runtime asset", async (t) => {
  const old = entry({
    version: "1.0.1",
    sha256: { "manifest.json": "a".repeat(64), "main.js": "b".repeat(64), "vendor-pixi.min.js": "c".repeat(64) },
  });
  const candidate = { ...old, version: "1.0.2" };
  const files = { "manifest.json": JSON.stringify(candidate), "main.js": "export default function activate() {}" };
  t.mock.method(globalThis, "fetch", async (url) => {
    const name = new URL(url).pathname.split("/").at(-1);
    return Object.hasOwn(files, name) ? new Response(files[name]) : new Response(null, { status: 404 });
  });
  const result = await buildBumpedEntry(old.id, old, candidate.version, candidate, Object.keys(files));
  assert.equal(result.entry, undefined);
  assert.match(result.skip, /vendor-pixi\.min\.js/);
});

test("bump preflight shares the complete permission and ID acceptance contract", async (t) => {
  for (const id of validIds) {
    await t.test(id, async (t) => {
      const old = entry({ id, version: "1.0.1" });
      const candidate = entry({ id, permissions: [...knownPermissions, ...validGrants] });
      const { files } = releaseFetch(t, candidate);
      const result = await buildBumpedEntry(id, old, candidate.version, candidate, Object.keys(files));
      assert.equal(result.skip, undefined);
      assert.deepEqual(result.entry.permissions, candidate.permissions);
      assert.deepEqual(entryErrors(result.entry), []);
    });
  }
});

test("bump preflight rejects unsafe IDs before fetching artifacts", async (t) => {
  const fetchMock = denyFetch(t);
  for (const id of [...invalidIds, null, 12]) {
    const old = entry({ id, version: "1.0.1" });
    const candidate = entry({ id });
    const result = await buildBumpedEntry(id, old, candidate.version, candidate, []);
    assert.equal(result.entry, undefined, JSON.stringify(id));
    assert.equal(typeof result.skip, "string", JSON.stringify(id));
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("bump preflight rejects unknown and malformed permissions before fetching", async (t) => {
  const fetchMock = denyFetch(t);
  for (const permissions of [
    ...invalidPermissions.map((permission) => [permission]),
    "storage", {}, [null], [12], [{}],
  ]) {
    const old = entry({ version: "1.0.1" });
    const candidate = entry({ permissions });
    const result = await buildBumpedEntry(old.id, old, candidate.version, candidate, []);
    assert.equal(result.entry, undefined, JSON.stringify(permissions));
    assert.equal(typeof result.skip, "string", JSON.stringify(permissions));
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("bump preflight retains manifest identity, version and tier checks", async (t) => {
  const fetchMock = denyFetch(t);
  const old = entry({ id: "vendor.plugin", version: "1.0.1" });
  for (const overrides of [{ id: "other.plugin" }, { version: "1.0.3" }, { tier: "declarative" }]) {
    const candidate = entry({ id: old.id, ...overrides });
    const result = await buildBumpedEntry(old.id, old, "1.0.2", candidate, []);
    assert.equal(result.entry, undefined);
    assert.equal(typeof result.skip, "string");
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});

test("namespaced IDs and new permissions do not bypass the bundle blacklist", async (t) => {
  const old = entry({ id: "ccgui.client-context-bridge", version: "1.0.1" });
  const candidate = entry({ id: old.id, permissions: ccbPermissions });
  const { files } = releaseFetch(t, candidate, "eval('unsafe')");
  const result = await buildBumpedEntry(old.id, old, candidate.version, candidate, Object.keys(files));
  assert.equal(result.entry, undefined);
  assert.equal(typeof result.skip, "string");
});

// --- 权限-代码比对：接收者名字不得参与匹配 -------------------------------
// 打包产物会把 activate 的上下文参数压缩成任意标识符；启发式一旦绑定 `ctx.`
// 就对所有压缩 bundle 失效——「调用了却没声明」这条错误判定会静默放空。
const minifiedBundle = `
  function a(t){t.ui.registerSettingsSection({});t.ui.registerWorkspaceMenuItem({});
  t.i18n.addBundle({});t.storage.get("k");t.events.emit("e");
  t.workspace.getMetadata();t.workspaces.list();t.documentStorage.getLocation();
  t.hooks.registerSessionHooks({});t.hooks.registerRuntimeSwitchHooks({});
  t.hooks.registerTurnHooks({});}
`;

test("permission comparison detects capabilities through minified receivers", () => {
  const { errors, warnings } = comparePermissionsWithCode("ccb", ccbPermissions, minifiedBundle);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("permission comparison flags undeclared capabilities in minified bundles", () => {
  const { errors } = comparePermissionsWithCode("ccb", ["storage"], minifiedBundle);
  const missing = ["ui:settings-section", "ui:workspace-menu", "i18n", "events",
    "workspace.metadata.read", "host:workspace", "plugin.storage",
    "session.lifecycle.read", "runtime.switch.observe"];
  for (const p of missing) {
    assert.ok(errors.some((e) => e.includes(`"${p}"`)), `expected error for ${p}: ${errors.join(" | ")}`);
  }
});

test("permission comparison still reads unminified ctx receivers", () => {
  const source = `export function activate(ctx){ctx.ui.registerCommand({});ctx.theme.injectCss("");}`;
  const { errors } = comparePermissionsWithCode("p", [], source);
  assert.ok(errors.some((e) => e.includes('"ui:command"')));
  assert.ok(errors.some((e) => e.includes('"theme"')));
});

// 通用名字的 namespace 绝不能靠裸 `.ns.` 匹配：下面全是 2026-10-08 在已上架
// 插件产物里实测到的真实形状（model-switcher / token-meter /
// window-model-assistant），裸匹配会把它们全判成「未声明权限」而拒掉 PR。
test("permission comparison does not mistake data fields for host namespaces", () => {
  const dataShapes = `
    const p = Array.isArray(m.models) ? m.models.map(x => x.id) : [];
    const n = d.models.length + k.models.filter(Boolean).length;
    const s = this.sessions.get(id); this.sessions.set(id, s);
    const w = !!e.window && typeof e.window.getState;
    const c = cache.storage.size; obj.events.length;
    const t = node.theme.name; item.agent.label; row.i18n.locale;
  `;
  const { errors } = comparePermissionsWithCode("p", [], dataShapes);
  assert.deepEqual(errors, [], "data members must not be read as SDK calls");
});

test("permission comparison detects host namespaces through their real methods", () => {
  const calls = [
    [`x.models.catalog({})`, "host:models"],
    [`x.models.listEngines()`, "host:models"],
    [`x.sessions.selectSession(1)`, "host:session"],
    [`x.window.getState()`, "host:window"],
    [`x.storage.set("k", 1)`, "storage"],
    [`x.events.on("e", f)`, "events"],
    [`x.theme.setTokens({})`, "theme"],
    [`x.agent.start({})`, "agent"],
    [`x.worktrees.create({})`, "host:worktree"],
    [`x.ui.registerWorktreeBadges({})`, "ui:worktree-badge"],
    [`x.composer.setDraft("")`, "composer:draft"],
  ];
  for (const [source, permission] of calls) {
    const { errors } = comparePermissionsWithCode("p", [], source);
    assert.ok(
      errors.some((e) => e.includes(`"${permission}"`)),
      `${source} should require ${permission}: ${errors.join(" | ")}`,
    );
  }
});

test("permission comparison keeps bridge network and exec gates", () => {
  const net = comparePermissionsWithCode("p", ["storage"], `plugin_http_request({})`);
  assert.ok(net.errors.some((e) => e.includes("network:")));
  const exec = comparePermissionsWithCode("p", ["storage"], `plugin_exec_run({})`);
  assert.ok(exec.errors.some((e) => e.includes("exec:")));
});

test("turn hooks satisfy both field-gated permissions without demanding either", () => {
  const source = `function a(t){t.hooks.registerTurnHooks({});}`;
  const declared = ["runtime.events.read", "prompt.contribute.internal"];
  const { errors, warnings } = comparePermissionsWithCode("p", declared, source);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

// --- 网络重试：传输故障不得与「文件缺失」混为一谈 -------------------------
async function withServer(t, handler) {
  const { createServer } = await import("node:http");
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("fetchWithRetry recovers from a transient failure", async (t) => {
  let hits = 0;
  const base = await withServer(t, (req, res) => {
    hits += 1;
    if (hits === 1) { req.destroy(); return; }
    res.writeHead(200).end("ok");
  });
  const { res, error } = await fetchWithRetry(`${base}/README.md`, { timeoutMs: 5_000, backoffMs: 1 });
  assert.equal(error, undefined);
  assert.equal(res.status, 200);
  assert.equal(hits, 2);
});

test("fetchWithRetry returns 404 immediately without retrying", async (t) => {
  let hits = 0;
  const base = await withServer(t, (_req, res) => {
    hits += 1;
    res.writeHead(404).end("nope");
  });
  const { res, error } = await fetchWithRetry(`${base}/README.md`, { timeoutMs: 5_000, backoffMs: 1 });
  assert.equal(error, undefined);
  assert.equal(res.status, 404);
  assert.equal(hits, 1, "404 is deterministic; retrying it only slows CI down");
});

test("fetchWithRetry reports exhausted retries on persistent 503", async (t) => {
  let hits = 0;
  const base = await withServer(t, (_req, res) => {
    hits += 1;
    res.writeHead(503).end("busy");
  });
  const { res, error } = await fetchWithRetry(`${base}/README.md`, { timeoutMs: 5_000, backoffMs: 1 });
  assert.equal(res, undefined);
  assert.match(error, /503/);
  assert.equal(hits, 3);
});
