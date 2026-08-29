# AgentWiki Sync v2 Obsidian 插件设计

## 状态

- 日期：2026-08-29
- 状态：已确认设计，待实施计划
- 适用仓库：`AgentWiki-Obsidian`
- 上游基线：AgentWiki `v0.7.0`、Sync API v2、`@neomei/agentwiki-sync-protocol@0.4.0`

## 背景

AgentWiki `v0.7.0` 引入 Folder-aware Sync API v2。v2 把 Folder 和 Page 一起纳入不可变 Revision、Snapshot、Delta、Push confirmation 和原子发布边界；零 Folder 的 Space 也是一棵合法的 v2 树。

现有 AgentWiki Sync `0.2.12` 只实现 Sync API v1。它可以继续同步无 Folder 的 Space，但只要 Space 存在活动 Folder 或 Page 已归入 Folder，服务端就会在 v1 head、Snapshot、Delta 和 Push session 入口返回 `SYNC_PROTOCOL_UPGRADE_REQUIRED`。插件当前也未识别该错误，只能显示笼统的 HTTP 409。

本设计把插件升级为 v2-first 的统一树同步客户端，同时保留对尚未提供 v2 endpoint 的旧服务器的自动 v1 兼容。用户不选择协议，界面也不暴露协议开关。

## 目标

1. AgentWiki Folder 映射为 Vault 映射根目录下的真实目录。
2. Folder 和 Page 的创建、改名、移动、删除支持安全的双向同步。
3. 空目录作为正式 Folder 参与 Snapshot、Delta、预览和 Push。
4. 升级后的服务器统一使用 v2；零 Folder Space 自动兼容，无需选择协议。
5. 保留现有显式预览与确认边界，任何 Folder/Page 写入或删除都不能绕过确认。
6. Pull、Push 和本地树变更具有可恢复事务；崩溃后只能安全继续、回滚或停止，不能猜测状态。
7. 现有 v1 映射、凭据、generation、未完成 Push 和可读文件路径不丢失。
8. 插件继续兼容 Obsidian 桌面端与移动端，不引入 Node.js 文件系统依赖。

## 不做

- 不修改 AgentWiki 主项目、生产数据库或部署状态。
- 不直接导入 AgentWiki 主仓 `packages/local-sync` 的内部实现。
- 不把 Folder 扁平化为文件名前缀，也不在 v2 失败时静默退回 v1。
- 不同步映射根目录以外的 Vault 内容。
- 不把 `.agentwiki/`、插件凭据、事务日志或暂存文件上传到服务端。
- 本轮不推 GitHub、不发布插件、不对现有生产 Space 执行最终确认。

## 方案选择

采用“统一树同步核心 + v1/v2 协议适配器”。

不采用两套独立 Runtime，因为 Pull、Push、冲突、预览和恢复逻辑会重复并持续漂移。不嵌入 `@neomei/agentwiki-local-sync`，因为它使用 Node.js 文件系统、独立工作区和不同的凭据/状态边界，不适合 Obsidian 移动端，也会破坏 Vault API 与 FileManager 的行为约束。

## 协议策略

### v2-first 自动协商

连接成功后，插件使用现有 Human Device Credential 请求 `GET /api/sync/v2/capabilities`：

- 成功并通过严格 Schema 与 capability hash 校验：服务器级别固定使用 v2，所有 Space 包括零 Folder Space 都走 v2。
- endpoint 明确不存在或服务器明确返回不支持 v2：把该服务器标记为 legacy v1，继续现有 v1 行为。
- 认证、权限、网络、响应校验、capability hash 或其他 v2 错误：直接失败，不尝试 v1，避免把真实故障误判成旧服务器。

协议结果按标准化 server origin 和 server instance identity 缓存。重新连接、服务器身份变化或插件升级会重新探测。界面只显示诊断性的“Sync v2”或“Legacy v1”，不提供人工选择。

### v1 基线升级

第一次在已有映射上启用 v2 时：

1. 读取并验证现有 v1 generation、Page identity、Vault 路径和当前 revision。
2. 获取 v2 head。若 v2 能从现有 revision 提供一致 Snapshot/Delta，则把 v1 Page 基线转换为零 Folder 的 `TreeSnapshot`。
3. 若 v2 revision 不能直接桥接，则下载完整 v2 Snapshot，按稳定 Page ID 与规范化路径生成升级预览。
4. 只有用户确认并成功提交本地事务后才写入 v2 基线与 Folder identity；旧 v1 generation 暂时保留为只读恢复证据。
5. 已进入 v2 的映射不能自动回退 v1。

## 内部模型

同步核心使用统一树模型：

```ts
interface TreeFolder {
  folderId: string;
  parentFolderId: string | null;
  name: string;
  path: string;
  sortOrder: number;
  updatedAt: string;
}

interface TreePage {
  pageId: string;
  folderId: string | null;
  path: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}

interface TreeSnapshot {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  revisionContentHash: string;
  folders: TreeFolder[];
  pages: TreePage[];
}
```

v1 adapter 产生 `folders: []` 且所有 Page 的 `folderId` 为 `null`。v2 adapter 直接使用协议包的 Folder/Page 数据，经 canonical tree 校验后转换为内部模型。同步核心不再根据协议版本分别实现扫描、差异或冲突。

所有受管路径位于映射根目录内的 `pages/` 树。Folder 路径使用协议包的 portable directory validator；Page 路径使用 portable Markdown validator。路径比较使用协议包 `pathKey()`，不依赖 Windows/macOS 文件系统的大小写行为。

## 本地状态

### v2 基线

`.agentwiki/` 控制区新增独立的版本化状态：

- v2 tree generation：完整 Folder/Page metadata 与 revision 指针。
- Folder identity：`folderId -> path/pathKey/updatedAt`。
- pending Folder/Page identities：本地新建、恢复或待绑定对象的稳定 ID。
- v2 pull transaction journal。
- v2 push preview/session journal。

控制文件继续使用 envelope、双副本/候选读取、hash 和原子发布模式。Schema 拒绝未知的未来版本，损坏项不得被静默忽略。

### Vault 抽象

`VaultPort` 增加目录能力：

- 枚举映射根下的真实目录，包括空目录。
- 判断路径为文件、目录或缺失。
- 创建目录及父目录。
- 重命名/移动 Folder。
- 通过 Obsidian FileManager 把 Folder 移入用户配置的回收站。

所有操作必须重新验证路径仍在映射根内。插件不使用 `node:fs`、inode 或平台专属 API；事务身份由规范化路径、对象类型、稳定 Folder/Page ID 和文件字节 hash 共同约束。

## 扫描与身份解析

扫描结果同时包含 Folder 与 Markdown Page。扫描必须：

- 忽略 `.agentwiki/` 控制区和映射根外内容。
- 保留空目录。
- 拒绝软链接等 Obsidian Vault API 无法安全表达的对象。
- 检测文件/目录同路径、大小写折叠、Unicode NFC 和 Windows 保留名称碰撞。
- 用 v2 Folder identity 识别改名和移动；不能仅凭当前路径生成新 Folder ID。
- Page 继续优先使用已有 Page identity、move hint 和内容证据。
- 新建 Folder/Page 使用 UUID v4，写入 pending identity 后才进入 Push preview。

同一 Folder ID 在本地和远端被移动到不同父目录时产生结构化冲突。相同路径对应不同 Folder ID、文件与目录占用同一路径、父 Folder 不存在或形成环，也必须阻断。

## Pull

1. 获取并严格校验 v2 capabilities。
2. 分页读取 head、Snapshot 或 Delta；固定元数据必须跨页一致，cursor 不得重放。
3. 校验 Folder/Page 数量、正文 hash、manifest bytes、body bytes 和 tree revision hash。
4. 将远端树与 base/local 树做三方比较，生成统一 `TreePullPreview`。
5. 预览按依赖顺序显示：Page 归档、子 Folder 归档、父 Folder 归档、父 Folder upsert、子 Folder upsert、Page upsert。
6. 用户处理所有 Page 与 Folder 冲突后才能确认。
7. 确认后执行本地树事务并提交 v2 generation、Folder identity 和 revision 指针。

无冲突的目录改名/移动应保持 Folder ID 和子树 Page ID，不把整棵子树误判为删除后重建。

## Push

Push 前必须完成 Pull 并重新验证远端 head。插件从 base/local tree 生成 `TreePushChangeV2[]`：

- `upsert_folder`
- `archive_folder`
- `upsert_page`
- `archive_page`

变化顺序与 canonical/hash 计算全部使用公开协议包。插件发送 canonical request bytes，使用 capability-bound confirmation、batch partition 与 hash；不复制主项目内部实现。

`CAPABILITIES_CHANGED` 允许重新获取一次 capability、完全重建 Preview/session/batches；第二次变化失败关闭。`BASE_STALE` 返回 Pull 流程，不复用旧确认。用户确认绑定的是精确 preview hash，任何树变化都会使确认失效。

## Folder 冲突交互

现有 PreviewModal 扩展 Folder 冲突，不新增平行窗口。每项显示 Folder 名称、稳定 ID、base/local/remote 父路径与目标路径，可选择：

- 保留本地目标路径。
- 使用服务器目标路径。
- 手动输入最终目标路径。

手动路径立即执行 portable path、父 Folder、循环和碰撞校验。未解决 Folder/Page 冲突数量合并显示；大列表继续分页。确认区保持 sticky，所有待处理项归零前禁用“确认执行”。

同步中心显示当前协议、Folder/Page 数量、角色和变化摘要。Folder 操作使用明确中文：创建目录、移动目录、重命名目录、删除目录。

## 本地树事务与恢复

v2 Pull 使用持久化操作计划。每个操作记录：

- 操作类型与稳定对象 ID。
- before/after 路径和对象类型。
- 受影响 Page 的 before/after 字节 hash。
- 预期 base revision、目标 revision 与最终 tree hash。
- 当前 phase、下一操作和 rollback/cleanup checkpoint。

执行前把需要覆盖或删除的 Page 内容写入私有暂存 generation。每步前后重新读取 Vault 状态并写 checkpoint：

- 明确处于 before：执行该步。
- 明确处于 after：把该步标记完成并继续。
- 两者都不匹配：停止为 ambiguous，保留暂存与日志，向用户显示恢复指引。

回滚只恢复事务确认过的 before 状态，不覆盖用户在中断后新增的修改。事务提交顺序为 Vault tree 完成、控制基线原子切换、旧暂存清理。删除 Folder/Page 通过 FileManager 进入回收站；暂存清理只删除插件私有控制文件。

## 错误与安全边界

- 新增 `SYNC_PROTOCOL_UPGRADE_REQUIRED`、`PROTOCOL_UNSUPPORTED`、`CAPABILITIES_CHANGED`、`REVISION_GONE` 等 v2 友好提示。
- 服务端声明 v2 后，网络、认证、权限、payload、hash、cursor 或 capability 错误均不回退 v1。
- Folder-aware Space 缺少 v2 支持时明确阻断，不平铺、不丢目录。
- 响应大小、Folder/Page 数量、正文和 manifest byte limits 在分配大对象前执行。
- 诊断继续递归脱敏 credential、Authorization、正文与路径附近的秘密字段。

## 测试策略

### 单元测试

- v2-first 协商与仅 legacy endpoint 的 v1 fallback。
- v1 基线转换为零 Folder v2 tree。
- Folder scan、pathKey、身份持久化、改名/移动/空目录。
- Folder/Page tree diff、依赖排序、循环和碰撞。
- Folder 冲突选择与确认禁用逻辑。
- 新错误码的用户提示。

### 集成测试

- v2 capabilities、head、Snapshot、Delta 分页与 cursor/hash/size 失败。
- Folder/Page 混合 Pull 和 Push。
- capability 变化一次重建、两次失败。
- v1 映射升级、full Snapshot 重建和旧 generation 保留。
- 每个本地树事务 checkpoint 的中断、恢复、回滚与 ambiguous 停止。

### E2E 与性能

- fake AgentWiki 双设备：Folder 创建、改名、移动、空目录、递归删除、Page 正文冲突。
- 旧服务器 v1 回归。
- 最大协商边界下的 Folder/Page 扫描、分页和 Push partition，验证内存有界。
- Vitest 配置显式排除 `.worktrees/**`，正式 `npm run check` 不再误扫旧工作树。

### 真实验收

- 使用独立测试 Vault 和隔离 AgentWiki 测试服务执行完整 v2 往返。
- 现有 `NeoMei-Docs` 与生产 Space 只验证连接、差异和预览；最终确认需另行授权。
- Windows 窄桌面和移动宽度复查 Folder 冲突长路径布局。

## 验收标准

1. 升级服务器上所有 Space 自动使用 v2，零 Folder Space 无需用户选择并保持现有文件内容与路径。
2. Folder/Page 双向创建、改名、移动、删除和空目录可正确预览、确认、同步及跨设备恢复。
3. v2 失败不降级为 v1，不出现平铺或静默丢 Folder。
4. 任一未解决冲突、路径碰撞、hash 不一致或事务歧义都会阻止确认。
5. 中断恢复不会覆盖中断后产生的用户修改。
6. 现有 v1 测试全部通过，新 v2 测试覆盖协议、事务和 UI；`npm run check` 为零失败。
7. build 与 bundle safety/release metadata 检查通过。
8. 真实隔离 Vault 完成至少一次 v2 Pull 与 Push；生产 Vault 未经额外确认不执行最终写入。
