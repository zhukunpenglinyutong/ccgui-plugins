# ccgui-plugins

CC GUI 桌面应用（desktop-cc-gui）的**社区插件中央索引仓库**。

本仓库不托管插件代码，只登记索引：每个插件是一个独立的 GitHub 仓库，通过
GitHub Releases 分发（Obsidian 社区插件同款模式，零自建服务器）。CC GUI
应用内的插件市场读取本索引，用户可一键搜索、安装、升级、卸载。

## 仓库结构

```
community-plugins.json        # 插件列表（id/repo/name/description/author，按 id 字典序）
plugins/<id>.json             # 每个插件的版本登记：version/tier/permissions/sha256/minAppVersion + 展示素材 icon/screenshots
download-counts.json         # 各插件累计下载量（机器人每 6h 聚合 release 下载数生成，勿手改）
scripts/validate.mjs          # 审核校验器（零依赖 Node ≥ 20）
.github/workflows/validate.yml  # PR 校验 + main 全量复检
.github/workflows/review.yml    # 审核报告自动评论 + 版本登记 PR 自动合并
SPEC-CHANGELOG.md             # 市场规范变更历史
```

## 插件作者：如何上架

### 1. 准备插件仓库

- 从模板仓库创建：`ccgui-plugin-template`（GitHub → Use this template）
- 仓库根必须有 `manifest.json`、`README.md`、`LICENSE`
- 规范全文见 desktop-cc-gui 仓库 `docs/plugin-development-guide.zh-CN.md`

### 2. 发版

```bash
# 升 manifest.json 的 version，然后打与 version 完全一致的 tag（无 v 前缀）
git tag 1.0.0 && git push origin 1.0.0
```

模板自带的 GitHub Action 会自动构建并把 `main.js` / `manifest.json` /
`styles.css` / `checksums.txt` 附加到该 tag 的 Release。

### 3. 首次上架：提 PR 到本仓库

1. Fork 本仓库。
2. `community-plugins.json` 追加一条（保持 id 字典序）：

   ```json
   {"id":"your-plugin","repo":"owner/ccgui-plugin-your-plugin","name":"显示名","description":"一句话描述","author":"owner"}
   ```

3. 新建 `plugins/your-plugin.json`（sha256 抄 Release 附件 `checksums.txt`）：

   ```json
   {
     "id": "your-plugin",
     "repo": "owner/ccgui-plugin-your-plugin",
     "tier": "js",
     "version": "1.0.0",
     "permissions": ["ui:panel-tab", "storage"],
     "sha256": {
       "main.js": "<64 位小写 hex>",
       "manifest.json": "<64 位小写 hex>",
       "styles.css": "<64 位小写 hex>"
     }
   }
   ```

4. 提 PR。CI 会自动：校验 manifest schema、比对 Release tag 与 version、
   下载产物核对 SHA256、扫描 bundle 黑名单与体积、生成审核报告评论在 PR 里。
5. 人工审核通过后合并，即上架。

### 4. 展示素材（可选，不改可以不上）

插件市场里的图标和详情页效果图都由**插件仓库自己托管**，manifest 声明、索引镜像：

```jsonc
// 插件仓库的 manifest.json
"icon": "docs/icon.png",                  // 方形图标，PNG/SVG/WebP/JPG，建议 ≥ 128×128
"screenshots": ["docs/screenshot-1.png"]  // ≤ 5 张，数组顺序 = 展示顺序
```

- 图片放仓库里用相对路径引用（推荐统一放 `docs/`；也接受绝对 https URL）。
- 索引条目的 `icon` / `screenshots` 由机器人登记新版本时从 manifest 镜像而来；
  只改素材、不改版本可以直接提一个只动这两个字段的 PR（同版本素材 PR 不走
  「版本登记自动合并」，转人工审核——素材是用户可见内容）。
- 图片按默认分支（HEAD）读取，**替换同名文件不需要发版**；换路径则随下一次发版进索引。
- 两个字段都可缺省：不填就没有图标（市场用首字母瓷砖）/没有图集。

### 5. 版本更新

**作者只需在插件仓库按第 2 步打 tag 发 Release，其余全自动：**

索引仓机器人（`.github/workflows/update-index.yml`，每小时）会轮询所有已登记
插件的 latest release，发现新版本后自动：下载产物 → 重算 SHA256 → 安全预检
（黑名单/体积/manifest 一致性，不合格直接跳过）→ 开「版本登记 PR」。

- 无权限新增 + CI 通过 → review 工作流**自动合并**，用户随即收到更新提示；
- 权限有新增 → PR 挂起**转人工审核**，老用户升级时会看到权限 diff 确认。

> 维护者注意：机器人开 PR 需要仓库 Secret `INDEX_BOT_TOKEN`（对本仓有
> contents + pull-requests 写权限的 fine-grained PAT）——Actions 默认
> token 创建的 PR 不会触发 CI（GitHub 防递归设计）。未配置时 PR 仍会创建，
> 但需人工 close/reopen 触发校验。

作者也可以不走机器人，手动提「版本登记 PR」（只改 `plugins/<id>.json`），
走同一条 CI + 自动合并通道。

## 硬性规则（CI 强制）

- Release tag 必须**恰好等于** manifest 的 `version`，不带 `v` 前缀
- Release 产物必须由仓库 Action 从源码构建，禁止手工上传本地产物（SHA256 会对不上）
- bundle 体积 ≤ 512KB（警告）/ 2MB（硬上限，gzip 前）
- `id` 一旦上架永不更改；`version` 必须严格单调递增
- 权限最小化：`network:` / `exec:` 授权精确到最小范围，申请用不到的权限会被要求删减
- 展示素材只允许图片扩展名（png/jpg/jpeg/webp/gif/svg/avif）；相对路径不得逃逸仓库，效果图 ≤ 5 张
- bundle 黑名单：`eval(` / `new Function(` / `__TAURI__` / `localStorage` / 远程 `import(` 一律拒绝

## 下架

- 作者主动下架：PR 删除索引条目（用户已装副本不受影响）
- 违规下架：维护者在 `plugins/<id>.json` 标记 `"delisted": true`，市场隐藏且已装用户收到安全提示

## 安全报告

发现插件安全漏洞请通过本仓库 Security Advisory 私密报告，不要开公开 issue。

## 许可

本仓库（索引数据与审核工具）以 [MIT](LICENSE) 发布。各插件仓库的许可证由插件作者自行选择。
