# 插件市场规范变更历史

规范全文见 desktop-cc-gui 仓库 `docs/plugin-development-guide.zh-CN.md`。
本文件只记录规范的演进；每次规范变更（新权限、新字段、规则收紧）在此追加一段。

## v0.5 — 2026-10（SDK 0.3.23 权限：usage.read / limits.read / ui:file-link-menu）

- 基座权限同步宿主 SDK 0.3.23 的 `packages/plugin-sdk/spec/permissions.json`（37 → 40 项）：新增 `usage.read`（读取宿主计算的用量聚合、触发增量刷新 / 重新扫描 / 价格表更新）、`limits.read`（读取 Claude / Codex 订阅限额）与 `ui:file-link-menu`（文件链接右键菜单项）。
- 权限-代码比对补上三组调用点：`ui.registerFileLinkMenuItem`、`usage.query / sources / refresh / rescan / prices / updatePrices`、`limits.get`；否则新能力会被误判成「声明了但没用到」。
- 用 `usage.read` / `limits.read` 的插件必须声明 `minAppVersion` ≥ 1.1.9：索引只做登记与产物核查，版本门禁仍由客户端按 manifest 执行。

## v0.4 — 2026-10（SDK 0.3.20 权限与命名空间 ID）

- 基座权限同步宿主 SDK 0.3.20 的 `packages/plugin-sdk/spec/permissions.json`，共 36 项；首次登记与版本机器人共用同一校验器，不对单个插件设置豁免。
- ID 支持点分命名空间，例如 `ccgui.client-context-bridge`：总长 2–64 个 ASCII 字符，每段为 `[a-z0-9][a-z0-9-]*`；拒绝空段、首尾点、非法段首、路径分隔符、非 ASCII 与控制字符（包括尾随换行）。普通连字符 ID 保持兼容，登记文件名仍须等于 ID。
- `network:none` 仍只是“不申请网络”的声明，不是网络主机授权；`network:none:80` 等伪授权、未知权限和尾随控制字符继续拒绝。
- 校验工作流在远端附件核查前执行 Node 行为回归，覆盖登记与版本更新、权限和 ID 边界、现有条目兼容及黑名单门禁。
- 权限-代码比对不再绑定上下文接收者名字（此前写死 `ctx.`）：打包产物会把 `activate` 的上下文参数压缩成任意标识符，旧启发式对所有压缩 bundle 静默失效，「调用了却没声明」这条错误判定等于没有。改法按 API 名字的歧义程度分两档：名字唯一的注册/方法调用（`ui.register*`、`hooks.*`、`workspace.getMetadata`、`documentStorage.*` 等）按成员路径匹配，与接收者无关；名字通用的 namespace（`models`/`sessions`/`window`/`storage`/`events`/`theme`/`agent`/`i18n`）必须连同 SDK 真实方法名一起匹配，因为裸 `.models.` 会打到 API 响应的数据字段、内部 Map 和特性探测（实测 `d.models.map`、`this.sessions.get`、`typeof e.window.getState`），按裸 namespace 判错会把合规插件拒掉。同时补齐 `workspaces.list`、`composer.setDraft`、`worktrees.*`、`models.*` 等 0.3.20 能力面。`hooks.registerTurnHooks` 的两项权限按入参字段分别门禁，静态分不开，只用于抑制「声明了但没用到」的警告，不作硬性错误。
- 远端核查区分「文件确实缺失」（404）与「连接失败」：传输层错误与 408/429/5xx 退避重试 3 次，404 立即返回不重试。两者都判错（门禁 fail closed），但连接失败的措辞明确标注非作者问题、重跑即可，审核员不应据此要求插件作者补文件。
- 版本机器人保留已人工审核的额外扁平资源集合，并对新版本逐项下载重算 SHA-256；缺少已登记的运行库或许可时不生成更新。新增、移除资源仍走人工索引审核，Release 中未登记的附件不会被自动安装。

## v0.3 — 2026-10（编辑精选：featured.json）

- 新增仓根 `featured.json`：市场页首屏轮播的唯一致据源。数组，顺序 = 优先级，≤ 8 条；字段 `id`（必填，须为已登记 id）、`tagline` / `note`（选填编辑文案）、`image`（选填封面，相对路径按插件仓库解析，规则同 icon/screenshots）。
- 缺省合法：没有这个文件 = 没有精选区（最快的回滚方式）；客户端对校验不通过的行静默丢弃，不渲染装不了的推荐位。
- 封面回退链：`image` → 插件第一张截图（按原比例装帧，不裁切）→ `icon` → 品牌色首字块。
- 校验：`scripts/validate.mjs` 的 `validateFeatured`（id 存在性 / 重复 / 上限 / 文案非空且无控制字符 / 封面路径形状）。
- App 侧渲染、自动播放与暂停约定见 desktop-cc-gui `docs/ui-ux-spec.zh-CN.md` §3「编辑精选轮播」。

## v0.2 — 2026-09（展示素材：icon / screenshots）

- 新增可选字段 `icon`（方形图标，一个）与 `screenshots`（效果图，≤ 5 张），位置：插件仓库 `manifest.json`；首次上架时照样写入 `plugins/<id>.json`。
- 索引镜像：版本机器人登记新版本时把 manifest 里的两个字段写进索引条目；manifest 缺省字段保留索引现值（索引侧可单独提只改素材的 PR）；`"screenshots": []` 显式清空，`icon` 从索引条目删除即移除。同版本只改素材的 PR 允许但**不自动合并**，转人工审核。
- 素材位置：图片放在插件仓库里用相对路径引用（推荐 `docs/`），也接受绝对 https URL；按默认分支 HEAD 读取，换图不锁 Release。
- 校验：只允许图片扩展名（png/jpg/jpeg/webp/gif/svg/avif），路径不得逃逸仓库/反斜杠/控制字符，单条 ≤ 1024 字符，效果图 ≤ 5 张；缺省合法（App 回退首字母瓷砖/不渲染图集）。
- App 侧渲染见 desktop-cc-gui `docs/ui-ux-spec.zh-CN.md` §3「插件素材可选、缺失不占位」。

## v0.1 — 2026-09-12（初始版本）

- 分发模式（Obsidian 同款）：中央索引仓 + 每插件独立 GitHub repo + GitHub Releases 发版，零自建服务器。
- 索引结构：`community-plugins.json`（列表：id/repo/name/description/author，按 id 字典序）+ `plugins/<id>.json`（版本登记：version/tier/permissions/sha256/minAppVersion/sdkVersion/delisted/pubkey）。
- 发版约定：Release tag == manifest.json 的 `version`（无 `v` 前缀）；Release 附件固定 `main.js`（Tier-0 可无）/ `manifest.json` / `styles.css`（可选）/ `checksums.txt`。
- 体积：bundle ≤ 512KB（CI 警告）/ 2MB（硬上限，gzip 前）。
- 安全：索引登记 SHA256 为信任锚；bundle 黑名单扫描（`eval(` / `new Function(` / `__TAURI__` / `localStorage` / 远程 `import(`）；CSS 禁 `@import` 与远程 `url()`。
- 权限白名单以 desktop-cc-gui `packages/plugin-sdk/spec/permissions.json` 为单一事实源（基座 14 项 + `network:`/`exec:` 授权）。
- 流程：首次上架 = 人工审核；版本登记（只改 `plugins/<id>.json`、无权限新增、CI 通过、PR 作者 = 插件仓库所有者）= 机器人自动合并；权限新增 = 转人工。
