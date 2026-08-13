# AgentWiki Obsidian 人类设备同步 API v1 契约

## 文档状态

- 契约版本：`1`
- 设计确认日期：2026-08-13
- 状态：插件项目已确认的上游需求；AgentWiki 主项目尚未实现
- 适用客户端：AgentWiki Sync Obsidian 插件
- 实现仓库：`/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`，必须通过独立任务修改

## 1. 目的

本契约定义 AgentWiki Sync 首版所需的稳定公开边界：

- 人类用户创建一次性 Obsidian 连接码。
- Obsidian 设备交换为可独立撤销的人类设备凭据。
- 插件读取 Space、revision、分页 Snapshot 和分页 Delta。
- 插件分批上传用户已确认的变化，并原子发布新 revision。
- 服务端在每次请求中重新检查人类用户和实时 Space 权限。

本契约不允许 Agent 绕过 ChangeSet 审核。AgentCredential 不得调用人类设备直接发布操作。

## 2. 兼容与发布边界

- 公开基础路径：`/api/sync/v1`。
- 安装和凭据交换路径：`/api/integrations/obsidian`。
- 所有成功响应和错误响应携带 `protocolVersion: "1"`。
- 服务端必须继续支持已有 local-sync 路由；不得通过破坏性修改现有 Snapshot/Delta 响应来实现本契约。
- 公开 npm 包名：`@neomei/agentwiki-sync-protocol`。
- 协议包必须提供浏览器 ESM、TypeScript 类型和运行时 Schema，不得依赖 Node 内置模块。
- 插件和服务端都必须使用协议包验证跨边界 payload。

## 3. 规范化与 hash

### 3.1 Markdown 正文

- UTF-8 编码。
- `CRLF` 和单独 `CR` 规范化为 `LF`。
- 保留末尾换行的有无。
- 不做 Unicode 正文归一化。
- 单页规范化正文最大 1 MiB。

### 3.2 路径与标题

- 相对路径使用 `/` 分隔。
- 路径段使用 Unicode NFC。
- 禁止绝对路径、空段、`.`、`..`、NUL 和根目录逃逸。
- 路径最长 1,024 字符。
- 标题最长 500 字符。
- 同一 Space 中禁止 NFC 后重复和仅大小写不同的路径。

### 3.3 内容 hash

`contentHash` 是规范化 UTF-8 正文的 SHA-256 小写十六进制字符串。

### 3.4 canonical serialization

协议包必须提供唯一的 canonical serialization 规则：

- 对象 key 按 Unicode code point 升序排列。
- 数组保持协议定义顺序；Push changes 按 `pageId`、`operation`、`path` 稳定排序后序列化。
- 字符串使用 JSON escaping。
- 不允许 `undefined`、NaN、Infinity 或循环引用。

`confirmationHash` 是完整 Push change manifest canonical bytes 的 SHA-256。该 manifest 包含 base revision、每个操作的 page ID、路径、标题、content hash 和归档标志，但不重复包含正文。

## 4. 人类设备凭据模型

新增 `HumanDeviceCredential`，至少包含：

```ts
interface HumanDeviceCredentialRecord {
  id: string;
  userId: string;
  deviceId: string;
  vaultId: string;
  deviceName: string;
  credentialHash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
```

约束：

- 明文凭据只在 exchange 成功响应中返回一次。
- 数据库仅保存使用抗暴力破解安全 hash 的凭据摘要。
- 凭据长期有效，直到用户或当前设备撤销。
- 同一 `userId + deviceId + vaultId` 重新连接时可以撤销旧凭据并签发新凭据。
- 凭据认证得到人类 principal：包含 `userId` 和 `credentialId`，不包含 `agentId`。
- 认证时重新加载未删除、有效用户；不得相信签发时缓存的用户状态。
- 授权时重新加载 Space membership、角色和 platform role。
- 凭据只被 Obsidian integration 与 sync v1 路由接受，不能调用一般用户管理、成员管理、Agent 管理、凭据管理或 Review 决策 API。

## 5. 一次性连接码

### 5.1 创建连接码

`POST /api/integrations/obsidian/installations`

- 认证：当前 AgentWiki Web 的人类 JWT。
- Guard：Human only。
- 请求：

```json
{
  "pluginId": "agentwiki-sync",
  "requestedProtocolVersion": "1"
}
```

- 响应：

```json
{
  "protocolVersion": "1",
  "installationId": "uuid",
  "code": "one-time-code",
  "expiresAt": "2026-08-13T11:00:00.000Z"
}
```

规则：

- code 使用密码学安全随机数，明文只显示一次。
- code 最长有效 10 分钟。
- 成功交换后立即失效。
- 撤销 installation 后立即失效。
- 创建行为记录 user ID、时间和安全审计事件，但不记录明文 code。

### 5.2 交换设备凭据

`POST /api/integrations/obsidian/exchange`

- 认证：无；以一次性 code 授权。
- 请求：

```json
{
  "code": "one-time-code",
  "deviceId": "uuid",
  "deviceName": "Neomei iPhone",
  "vaultId": "uuid",
  "pluginVersion": "0.1.0",
  "supportedProtocolVersions": ["1"]
}
```

- 响应：

```json
{
  "protocolVersion": "1",
  "credential": "secret-returned-once",
  "credentialId": "uuid",
  "user": {
    "id": "uuid",
    "displayName": "NeoMei"
  },
  "capabilities": {
    "maxPageBytes": 1048576,
    "maxBatchBytes": 8388608,
    "maxBatchItems": 200,
    "maxSnapshotPageSize": 500,
    "pushSessionTtlSeconds": 3600
  }
}
```

规则：

- 交换端点按 IP、installation ID 和失败次数限流。
- code 的检查和消费必须原子执行。
- 没有共同协议版本时返回 `PROTOCOL_UNSUPPORTED`，不得消费 code。
- 成功后创建绑定 code 所属 user 的 HumanDeviceCredential。
- 响应与日志必须设置禁止缓存和禁止记录 credential 的安全策略。

## 6. 设备会话

### 6.1 查询当前会话

`GET /api/integrations/obsidian/session`

返回 credential ID、当前用户、设备元数据、协议版本和有效状态，不返回 credential。

### 6.2 撤销当前设备

`DELETE /api/integrations/obsidian/credentials/current`

只撤销当前 HumanDeviceCredential。撤销成功后当前请求之外的后续请求必须失败。

### 6.3 用户端设备管理

AgentWiki Web 必须允许当前用户查看和撤销自己的 Obsidian 设备，显示设备名称、Vault ID、创建时间、最后使用时间和撤销状态，不显示 credential。

## 7. Space 列表与能力

`GET /api/sync/v1/spaces`

- 认证：HumanDeviceCredential。
- 返回当前用户可读取的 Space：

```ts
interface SyncSpaceSummary {
  spaceId: string;
  displayName: string;
  role: "viewer" | "editor" | "admin" | "owner";
  canRead: true;
  canPublish: boolean;
  currentRevision: string;
}
```

- `viewer` 的 `canPublish` 为 false。
- `editor`、`admin`、`owner` 的 `canPublish` 为 true。
- 用户失效、成员关系变化和 platform role 变化必须在下一次请求生效。

## 8. Revision head

`GET /api/sync/v1/spaces/:spaceId/head`

响应：

```json
{
  "protocolVersion": "1",
  "spaceId": "uuid",
  "revision": "revision-id",
  "publishedAt": "2026-08-13T11:00:00.000Z"
}
```

该端点只返回 head，不返回页面正文，用于 Status 和 Push 前置检查。

## 9. 分页 Snapshot

`GET /api/sync/v1/spaces/:spaceId/snapshot?revision=<id>&cursor=<opaque>&limit=<n>`

规则：

- 第一次请求可以使用 `revision=current`；响应必须解析为一个固定 revision。
- 后续 cursor 永远绑定同一固定 revision。
- 页面按 page ID 稳定排序。
- cursor 不透明，客户端不得解析。
- 后续有新发布时，本次分页结果仍保持固定 revision。
- revision 不存在或已清理时返回 `REVISION_GONE`。

响应：

```ts
interface SnapshotPage {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  items: SyncPage[];
  nextCursor: string | null;
}

interface SyncPage {
  pageId: string;
  path: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}
```

## 10. 分页 Delta

`GET /api/sync/v1/spaces/:spaceId/delta?from=<revision>&cursor=<opaque>&limit=<n>`

响应固定 `fromRevision` 和 `toRevision`：

```ts
interface DeltaPage {
  protocolVersion: "1";
  spaceId: string;
  fromRevision: string;
  toRevision: string;
  items: DeltaItem[];
  nextCursor: string | null;
}

type DeltaItem =
  | { operation: "upsert"; page: SyncPage }
  | { operation: "archive"; pageId: string; previousPath: string };
```

移动和重命名使用同一 page ID 的 `upsert` 表达。若 `from` 已不可用，返回 `REVISION_GONE`，客户端改取 Snapshot 并使用本地 base 做三方合并。

## 11. Push session

Push 使用临时上传会话，避免把整个 Space 放入单一请求，同时保持最终发布原子性。

### 11.1 创建 session

`POST /api/sync/v1/spaces/:spaceId/push-sessions`

请求：

```ts
interface CreatePushSessionRequest {
  baseRevision: string;
  idempotencyKey: string;
  confirmationHash: string;
  changeCount: number;
  totalBodyBytes: number;
}
```

服务端创建 session 前检查用户和 Space 读取/发布能力，并检查 base revision 当前有效，但 finalize 时必须再次检查。

响应包含 `sessionId`、到期时间和当前 capabilities。

### 11.2 上传批次

`PUT /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId/batches/:batchIndex`

```ts
type PushChange =
  | {
      operation: "upsert";
      pageId: string;
      path: string;
      title: string;
      body: string;
      contentHash: string;
    }
  | {
      operation: "archive";
      pageId: string;
      previousPath: string;
    };

interface PushBatch {
  protocolVersion: "1";
  batchIndex: number;
  batchHash: string;
  changes: PushChange[];
}
```

规则：

- 批次必须满足 exchange 返回的 item 和 byte 限制。
- 相同 session、batch index 和 batch hash 的重试返回原成功结果。
- 相同 index、不同 hash 返回 `BATCH_MISMATCH`。
- 上传阶段只写临时 staging，不改变 Page、ChangeSet 或 revision。
- 批次顺序可以乱序到达；finalize 负责检查索引完整性。

### 11.3 原子 finalize

`POST /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId/finalize`

请求：

```json
{
  "confirmationHash": "sha256",
  "userConfirmed": true
}
```

finalize 必须：

1. 重新认证 HumanDeviceCredential 和当前用户。
2. 重新检查 Space 角色为 editor/admin/owner 或当前有效的 owner 等价平台权限。
3. 检查 session 未过期且属于当前 credential 和 Space。
4. 检查所有批次齐全、批次 hash 正确、数量和字节总数一致。
5. 重建 canonical change manifest 并验证 confirmation hash。
6. 在发布事务内重新检查当前 revision 等于 base revision。
7. 校验 page ID、路径、标题、正文、hash 和路径唯一性。
8. 记录人类用户、设备 credential、来源 `obsidian_sync` 和确认 hash。
9. 发布所有页面更新和归档，并推进一个新 revision。

成功响应：

```ts
interface FinalizePushResponse {
  protocolVersion: "1";
  status: "published" | "noop" | "existing";
  revision: string;
  publishedAt: string;
  contentHash: string;
}
```

同一 idempotency key 和同一 payload 返回第一次结果；同一 key 和不同 payload 返回 `IDEMPOTENCY_MISMATCH`。

### 11.4 查询 session 与最终结果

`GET /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

只允许创建该 session 的当前 HumanDeviceCredential 查询。响应返回：

```ts
interface PushSessionStatusResponse {
  protocolVersion: "1";
  sessionId: string;
  status: "uploading" | "ready_to_finalize" | "published" | "aborted" | "expired";
  receivedBatchIndexes: number[];
  expiresAt: string;
  result: FinalizePushResponse | null;
}
```

finalize 已提交但客户端未收到响应时，该端点必须返回持久化的最终结果。查询不得延长 session 到期时间，不得泄漏正文或其他 credential 的 session。

### 11.5 审计而非二次审核

人类设备 finalize 已包含 Obsidian 内的明确确认。服务端可以创建同步来源的已接受 ChangeSet 或等价审计记录，但不得返回 `pending_review`。AgentCredential 的现有提交仍必须进入待审核 ChangeSet，不能使用本接口。

### 11.6 终止 session

`DELETE /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

允许当前 credential 在 finalize 前删除 staging。到期 session 由服务端安全清理。清理不得影响已发布 revision。

## 12. 容量和分页要求

- 协议不设置 Space 总页数硬上限。
- 服务端可以执行租户配额，但必须通过结构化 `QUOTA_EXCEEDED` 返回当前限制。
- 单页最大正文为 1 MiB。
- 单批次限制由 exchange/session capability 返回，不固化在插件。
- 首版端到端验收基线：单 Space 5,000 页、规范化正文总计 100 MiB。
- Snapshot、Delta 和上传必须以有界批次处理；服务端和客户端都不得要求把完整 100 MiB payload 同时保存在一个 JSON 对象中。

## 13. 错误 envelope

```ts
interface SyncApiErrorResponse {
  protocolVersion: "1";
  error: {
    code: SyncErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, string | number | boolean | null>;
  };
}
```

`SyncErrorCode` 至少包含：

- `AUTHENTICATION_REQUIRED`
- `DEVICE_CREDENTIAL_REVOKED`
- `USER_INACTIVE`
- `SPACE_FORBIDDEN`
- `SPACE_READ_ONLY`
- `INSTALLATION_CODE_INVALID`
- `INSTALLATION_CODE_EXPIRED`
- `PROTOCOL_UNSUPPORTED`
- `REVISION_GONE`
- `BASE_STALE`
- `CONFIRMATION_REQUIRED`
- `CONFIRMATION_MISMATCH`
- `PAYLOAD_INVALID`
- `PATH_COLLISION`
- `PAGE_TOO_LARGE`
- `BATCH_TOO_LARGE`
- `BATCH_MISMATCH`
- `PUSH_SESSION_EXPIRED`
- `PUSH_SESSION_INCOMPLETE`
- `IDEMPOTENCY_MISMATCH`
- `QUOTA_EXCEEDED`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

错误 details 不得包含凭据、安装码、Authorization header 或 Markdown 正文。

## 14. HTTP 与安全要求

- 生产服务地址必须是 HTTPS。
- 仅 development 模式允许 loopback HTTP。
- URL 禁止嵌入用户名或密码。
- credential 使用 `Authorization: Bearer <secret>`。
- 敏感响应设置 `Cache-Control: no-store`。
- 服务端日志中对 code、credential、Authorization 和正文做默认删除或脱敏。
- Exchange、session 创建、批次上传和 finalize 分别实施合理限流。
- 所有 Space 路由在 service layer 重新授权，不能只依赖 controller guard。
- finalize 的权限、base 和 payload 校验必须抵抗 TOCTOU；最终检查位于发布事务或等价 fenced 临界区。
- staging 数据绑定 credential、user、Space、session 和到期时间；其他 principal 不可读取或 finalize。

## 15. 验收测试

主项目独立任务至少验证：

1. 安装码单次消费、过期、撤销、限流和并发交换。
2. 明文设备 credential 不进入数据库、日志和普通响应。
3. 被删除或停用用户的设备凭据下一次请求立即失败。
4. Space 角色从 editor 降为 viewer 后，已有 push session finalize 失败。
5. AgentCredential 无法调用 sync v1 人类发布端点。
6. Snapshot 和 Delta 分页固定 revision，发布并发时不混页。
7. 相同批次幂等，相同 index 不同 hash 被拒绝。
8. 缺批次、错误总数、错误总字节和错误 confirmation hash 被拒绝。
9. finalize 前 revision 改变时返回 `BASE_STALE`，不发布任何页面。
10. finalize 故障注入后 Page、归档、审计记录和 revision 要么全部提交，要么全部不提交。
11. finalize 响应丢失后，session 查询返回相同的持久化最终结果。
12. 5,000 页、100 MiB 的 Snapshot、Delta、上传和 finalize 通过有界内存完成。
13. 协议包在浏览器 ESM 环境和服务端 Node 环境中使用相同 fixture 得到相同验证与 hash 结果。

## 16. 跨仓实施规则

- 本文档只记录插件所需公开契约，不授权当前任务修改 AgentWiki 主项目。
- 主项目实现必须建立独立设计、计划、测试和发布任务。
- 插件只能依赖已发布协议包和公开 API，不能复制主项目 controller、service、Prisma 类型或 local-sync 内部实现。
- 主项目最终路由或字段如需调整，必须先更新本契约并在插件仓库中明确版本迁移影响。
