# AgentWiki Sync v2 验证记录

## 自动门禁（已执行）

- `npm run check`：格式检查、ESLint、strict typecheck、全部单元/集成/E2E/性能测试、生产构建、bundle safety 与 release metadata 检查。

最新收口结果（2026-08-30，插件 0.2.12）：

- 测试：**41 个测试文件、323 项测试全部通过**（`vitest run`）。
- Prettier 通过；ESLint **0 error / 20 warning**（均为既有已知 warning，不含新增错误）。
- strict typecheck、production build 通过；bundle safety 报告 `main.js` **1,180,773 bytes**；release metadata **0.2.12**。

Task 12 新增回归覆盖：

- E2E（`tests/e2e/manual-sync-flow.test.ts`）：混合文件夹/页面树在桌面与移动端之间往返——桌面创建嵌套目录与空目录并 Push，移动端 Pull 后改名目录、编辑页面并 Push，桌面再 Pull，最终两端目录集合一致、空文件夹 `pages/Empty` 保留、远端页面正文与路径正确。
- 资源上限（`tests/performance/bounded-space.test.ts` 新增 `bounded v2 tree`）：分别断言以下边界在超过时立即失败，而不是在 `limit + 1` 处继续保留对象或分配超出声明的正文：
  - `maxClientSpaceFolders = 10_000`（扫描器，`SPACE_TOO_LARGE`）。
  - `maxSnapshotObjects = 15_000`（下载器，`快照对象数量超过限制`）。
  - `maxDocumentTreeBytes = 2 MiB`（下载器，`快照字节数超过限制`）。
  - `maxDeltaItems = 15_000`（下载器，`增量条目数量超过限制`）。
  - `maxPushChanges = 100`（推送分区，`BATCH_TOO_LARGE`）。
  - `maxResponseBytes = 4 MiB`（v2 能力 schema 拒绝超出协议上界的服务端声明）。

以上为回归保护：这些断言在当前实现下直接通过，说明边界已满足；未出现需要修改实现才能通过的 RED 缺陷。

## Computer Use 执行记录（2026-08-30）

已在真实 Obsidian 1.13.7 中执行以下可安全完成的 GUI 验收：

- 当前生产 Vault 的已安装插件完成只读同步预览：映射显示 `NeoMei-Space · AgentWiki · 所有者`、`服务器有更新`、`扫描 6 / 6`、`本地没有未推送的变更`、`服务器变更已与合并基线一致`。未点击自动合并、本地版本、服务器版本或任何确认写入按钮。
- 建立隔离 Vault `AgentWiki-Sync-V2-Acceptance-A`，装入当前仓库 HEAD 的 `main.js`、`styles.css`、`manifest.json`，并用 SHA-256 确认隔离 Vault 的 bundle 与仓库 HEAD 一致。
- 隔离 Vault 中插件真实启用，Ribbon 与命令面板均出现 `AgentWiki Sync`；打开同步中心后，HEAD 对裸错误码正确显示中文：`加载差异失败：库身份不匹配。请检查是否连接了正确的服务器和库。`

其他 Obsidian 自动化停止后，又将修复后的仓库 HEAD 临时装入真实 `NeoMei-Docs` Vault，并完成了生产只读复验：

- 修复前，HEAD 在同步中心稳定失败：`加载差异失败：服务器内部错误。请稍后再试。`
- 使用已保存凭据做脱敏、只读的接口探测：V2 `capabilities`、映射 Space 的 `head` 和 `snapshot` 均为 200；全局 V2 `spaces` 为 500；V1 `spaces` 为 200 且返回合法 Space 元数据。
- 根因是同步中心并行加载状态、增量和全局 Space 列表；V2 列表的单点 500 使整个预览失败，而实际 V2 单 Space 同步接口并未失效。
- 插件现仅在 V2 Space 发现接口返回 HTTP 5xx 时，使用 V1 列表补齐 Space 名称、角色和发布权限；V2 的 capabilities、head、delta、snapshot 与 push 不降级。403 等鉴权错误仍原样失败，不会被回退掩盖。
- 修复后的真实同步中心成功显示 `NeoMei-Space · AgentWiki · 所有者`、`协议：Sync v2`、`服务器有更新` 和本地变更列表；界面中没有协议选择器，排版无溢出或错位。
- 通过键盘进入 `自动合并 — 拉取预览`，确认最终写入边界为单独的 `确认执行` 按钮；随后按 Escape 退出，未点击确认、未 Push/finalize、未产生远端写入。

新增回归测试覆盖：V2 Space 发现 500 时回退 V1 列表；V2 403 时禁止回退。修复后的全量门禁为 41 个测试文件、323 项测试全部通过。

尚未执行的是需要真实写入的双 Vault 往返：隔离 Vault 没有独立的非生产 Space/凭据，生产 Space 不用于破坏性验收。因此 Step 4 保留为后续非生产环境清单；Step 5 已由 Computer Use 完成。

### Step 4：真实 Obsidian 双 Vault 往返

准备：一个隔离的测试 Vault（非生产 Vault）、一个非生产 AgentWiki Space、以及同一 Space 的第二个隔离 Vault。

1. 连接并确认协议显示
   - 操作：在设置页完成连接，打开同步中心。
   - 预期：同步中心显示 `协议：Sync v2`（服务端支持 v2 时），且没有任何协议下拉/选择器。
   - 判定：出现 `协议：Sync v2` 且无可交互协议选择器；若服务端不支持 v2 应显示 `协议：Legacy v1`。

2. Pull 预览嵌套目录、空文件夹与页面
   - 操作：让 Space 包含嵌套文件夹、一个空文件夹和若干 Page，执行 Pull 前先查看预览。
   - 预期：预览列出文件夹新增/更新与页面新增/更新；空文件夹出现在待创建目录中。
   - 判定：预览可见且未写入 Vault；空文件夹未被遗漏。

3. 确认 Pull 后本地变更
   - 操作：确认 Pull，然后本地改名/移动一个文件夹、编辑一个 Page、新建一个空文件夹。
   - 预期：Pull 落盘后状态干净；改名/编辑/新建被状态识别为本地变更。
   - 判定：状态区正确显示文件夹移动、页面修改与新增空文件夹，无“未解决的结构化冲突”。

4. 预览并确认 Push
   - 操作：执行 Push 预览，核对改动后确认。
   - 预期：预览包含 folder upsert/archive、page upsert/archive；确认后远端修订推进。
   - 判定：确认后无报错，远端 head 更新且本地状态回净。

5. 第二个 Vault Pull 校验一致性
   - 操作：在第二个隔离 Vault 连接同一 Space 并 Pull。
   - 预期：Folder ID、路径、空文件夹、页面正文与第一个 Vault 一致；Pull 后状态干净。
   - 判定：两 Vault 目录/正文一致，空文件夹存在，状态零变更。

6. 中断一个 Pull 后恢复
   - 操作：在 Pull 到达检查点后强制中断，随后再次打开同步中心触发恢复。
   - 预期：恢复要么到达 committed，要么回滚，要么在歧义处冻结而不覆盖中断后新产生的本地编辑。
   - 判定：未覆盖中断后的本地编辑；最终状态要么一致要么显式冻结提示，无静默数据丢失。

### Step 5：生产只读探测（Computer Use 已通过）

对已配置的生产凭据，只执行连接、capabilities、status 与 Pull preview，**不执行任何确认写入**。

- 结果：修复后显示 `Sync v2`，完成 status、差异与 Pull preview；V2 Space 列表 500 由 V1 元数据列表兼容，单 Space V2 同步链路保持不变。
- 确认：未点击“确认执行”、未调用 Push/finalize，未产生任何远端写入。
- 脱敏：记录中不含凭据、服务器实例 ID、页面正文或敏感路径。
- 判定：通过。
