# 插件市场规范变更历史

规范全文见 desktop-cc-gui 仓库 `docs/plugin-development-guide.zh-CN.md`。
本文件只记录规范的演进；每次规范变更（新权限、新字段、规则收紧）在此追加一段。

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
