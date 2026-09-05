# AgentWiki Sync

AgentWiki Sync 是一个移动端兼容的 Obsidian 插件，通过可预览、可确认的同步中心，将 Vault 映射目录与 AgentWiki Space 双向同步。

## 当前状态

插件核心、事务恢复、Obsidian 原生 UI 和公开 API 客户端已实现，同时支持 Sync v3 引用图片、Sync v2 树同步与 Legacy v1。服务端支持 v3 时自动选择 Sync v3；明确不支持时才依次尝试 v2、v1。已进入 v3 generation 的映射不会自动降级；旧服务端遇到受管图片候选会阻止同步，避免静默漏图。插件依赖已发布的 `@neomei/agentwiki-sync-protocol@0.5.1`。仓库中的自动化兼容和故障注入测试使用公开端口与隔离 fake 服务端驱动真实同步 runtime；这些测试不等同于真实桌面或移动设备验收。

## 协议选择与文件夹

- Sync v3 自动启用：优先探测 `/api/sync/v3/capabilities` 并校验严格能力哈希。引用图片只同步 `pages/` Markdown 实际引用的 PNG、JPEG、WebP 和 GIF；未引用图片不读字节、不进入预览，也不上传或下载。
- Sync v2/v1 兼容：只有 v3 明确不受支持时才探测 v2，v2 也明确不受支持时才回退 Legacy v1。旧协议只处理不含受管图片候选的页面；已有 v3 generation 或发现图片候选时要求升级，不静默降级。
- 文件夹映射：v2 下映射目录内的嵌套文件夹与页面作为统一树同步，文件夹 ID、父级、排序与路径保持一致；空文件夹也会被同步保留。Legacy v1 不包含文件夹语义。
- 确认与恢复：Pull/Push 仍需在预览中确认；图片内容替换、重命名、keep-both 与 detach 都绑定当前预览提案。Blob 传输、Vault 写入、Markdown 写入或 finalize 中断后从 journal 恢复；无法唯一判定时冻结该 Space，不会静默覆盖当前文件。

## 安装与使用

1. 把 `main.js`、`manifest.json`、`styles.css` 放入 Vault 的 `.obsidian/plugins/agentwiki-sync/` 目录，然后在 Obsidian 中启用插件。
2. 在 AgentWiki 网页的「集成 → Obsidian 设备」生成一次性连接码，在插件设置页完成连接。
3. 为可访问的 Space 选择一个互不重叠的 Vault 目录。新映射首次同步时会显式展示绑定与冲突选项。
4. 点击功能区图标、状态栏或命令面板的「打开同步中心」，选择自动合并、使用本地内容或使用服务器内容，并在预览中确认后执行。

同步中断后，下次打开同步中心会先恢复未完成的 Pull/Push 事务；恢复无法唯一判定时会冻结该 Space，不会静默覆盖当前文件。

同步中心可明确切换任意已映射 Space，包括待首次同步和只读 Space。只读 Space 可查看状态并以服务器内容 Pull，不提供 Push 策略。扫描、下载、合并和分批上传会显示进度并可取消；Pull 本地事务开始后和 Push finalize 开始后进入不可中断的原子阶段。

## 开发

要求 Node.js 24 LTS：

```bash
npm ci
npm run check
```

产物为 `main.js`、`manifest.json`、`styles.css`。开发和测试只能使用独立测试 Vault。

## 安全边界

- 插件只在用户连接、打开/刷新同步中心或确认同步时联网。
- Push 必须先确认预览，远端 head 领先时被阻止。
- credential 与连接码只进入 Obsidian Secret Storage，不进入 Vault 或诊断。
- `.agentwiki/` 控制状态按 device/space 隔离，通过 DataAdapter 相对路径访问；基线采用不可变 generation + current pointer，不使用 Node `fs` 或桌面专属 API。
- Pull 暂存正文和 Blob 只写入当前 device/space 的 `.agentwiki/` 控制目录；不会写入映射目录外的用户文件。Blob 通过需要授权的固定 Revision API 传输，不生成公开图片 URL。
- Push 确认前的图片字节数是所有 Blob requirement 的保守候选上界；建立 session 后服务端会返回真正缺失的 hash，已有内容可复用为 0 Blob 实传。
- 所有远端 Markdown 路径须先通过 NFC/casefold 可移植路径校验，Vault 适配器写入时再次执行 mapping-root containment。
- Secret Storage 不防御用户主动安装的恶意 Obsidian 插件。

## 验证与发布状态

自动化质量门、生产 Web/API、真实 Obsidian 桌面、Android、GitHub Release、社区市场和实际安装 bundle 是独立证据面。当前 Sync v3 的逐项记录见 `docs/verification/referenced-image-sync-v3-2026-09-04.md`；任一真实设备或发布渠道仍为 pending 时，不应把自动化测试称为“完整发布”或“真实双端通过”。
