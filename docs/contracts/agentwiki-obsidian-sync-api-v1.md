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
- `protocolVersion` 是 major 字符串。v1 request Schema 拒绝未知字段，避免 hash 歧义；response Schema 忽略未知字段，允许增加可选响应元数据。删除字段、改变字段含义或改变 canonical/hash 规则必须发布 protocol v2。

协议包根入口必须导出：

- 本文定义的所有 `...Request`、`...Response`、`SyncPage`、`DeltaItem`、`PushChange` 和 `SyncErrorCode` 类型。
- 与每个跨 HTTP 边界类型同名并以 `Schema` 结尾的运行时 Schema。
- `normalizeMarkdown(text)`、`normalizeSyncPath(path)`、`pathKey(path)`。
- `canonicalBytes(value)`、`sha256Hex(bytes)`、`contentHash(body)`、`confirmationHash(manifest)`、`batchHash(batchWithoutHash)` 和 `revisionContentHash(manifest)`。
- `partitionPushChanges(changes, capabilities)`，实现第 3.4 节确定性批次划分。

包内不得导出 AgentWiki Prisma、NestJS、Obsidian 或 Node `Buffer` 类型；hash API 接受/返回 `Uint8Array` 和字符串，并使用 Web Crypto 兼容实现。

### 2.1 HTTP 约定

- JSON 请求和响应使用 `application/json; charset=utf-8`。
- 所有参与 hash 或 byte limit 的请求体必须直接发送协议包产生的 canonical JSON UTF-8 bytes；不得先 hash canonical JSON、再发送字段顺序或转义不同的另一份 JSON。
- 除 exchange 外，sync v1 与设备会话端点使用 `Authorization: Bearer <device credential>`。
- 所有时间是 UTC RFC 3339 字符串，精确到毫秒。
- 所有成功响应都包含 `protocolVersion: "1"`。
- 无响应正文的成功操作使用 `204 No Content`；它是唯一不含 `protocolVersion` 的成功响应。
- 所有失败响应使用第 15 节 `SyncApiErrorResponse`。

| 操作 | 成功状态 | 主要失败状态 |
|---|---:|---|
| 创建安装码 | 201 | 401, 403, 409, 429 |
| 撤销未交换安装码 | 204 | 401, 403, 404, 409 |
| 交换设备凭据 | 201 | 400, 401, 409, 429 |
| 查询当前设备会话 | 200 | 401, 403 |
| 撤销当前设备 | 204 | 401, 403 |
| Web 列出/撤销自己的设备 | 200/204 | 401, 403, 404 |
| 列出 Space | 200 | 401, 403 |
| 查询 head/Snapshot/Delta | 200 | 400, 401, 403, 404, 410, 429 |
| 创建 Push session | 201 | 400, 401, 403, 409, 413, 429 |
| 上传批次 | 200 | 400, 401, 403, 404, 409, 410, 413, 429 |
| finalize | 200 | 400, 401, 403, 404, 409, 410, 413, 429 |
| 查询 Push session | 200 | 401, 403, 404, 410 |
| 终止 Push session | 204 | 401, 403, 404, 409 |

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
- path 扩展名按 ASCII 大小写不敏感必须等于 `.md`；服务端保留客户端提交的实际大小写。

### 3.3 内容 hash

`contentHash` 是规范化 UTF-8 正文的 SHA-256 小写十六进制字符串。

公共 Knowledge ID（page ID、revision ID、Space ID）长度为 1–128，字符集为 `[A-Za-z0-9._-]` 且首字符必须是字母或数字。`deviceId`、`vaultId`、`installationId`、`credentialId`、`sessionId`、`idempotencyKey` 和本地 transaction ID 使用标准小写 UUID v4。`deviceName` 为去除首尾空白后的 1–100 个 Unicode 字符；plugin version 为最长 64 字符的 SemVer。opaque cursor 最长 4,096 字符。

### 3.4 canonical serialization

协议包必须提供唯一的 canonical serialization 规则：

- 对象 key 按 Unicode code point 升序排列。
- 数组保持协议定义顺序；Push changes 按 `pageId`、`operation`、`path` 稳定排序后序列化。
- 字符串必须是有效 Unicode scalar sequence，拒绝未配对 surrogate。JSON 字符串转义 `"`、`\`、`\b`、`\t`、`\n`、`\f`、`\r`；其余 U+0000–U+001F 使用小写四位 `\u00xx`。不转义 `/`、非 ASCII、U+2028 或 U+2029。
- 不允许 `undefined`、NaN、Infinity 或循环引用。

字符串排序比较 Unicode code point 序列，不使用当前 locale。数字只允许安全整数，协议 v1 hash 对象不使用浮点数。输出为无 BOM、无多余空白的 UTF-8。

```ts
interface PushConfirmationManifestV1 {
  protocolVersion: "1";
  spaceId: string;
  baseRevision: string;
  changes: PushManifestChangeV1[];
}

type PushManifestChangeV1 =
  | {
      operation: "upsert";
      pageId: string;
      path: string;
      title: string;
      contentHash: string;
    }
  | {
      operation: "archive";
      pageId: string;
      previousPath: string;
    };
```

`changes` 在 canonical serialization 前按 `(pageId, operation, path-or-previousPath)` 的 Unicode code point tuple 升序排列。一个 page ID 在同一 manifest 中只允许一个操作；pathKey 也只能由一个 upsert 占用。`confirmationHash` 是完整 `PushConfirmationManifestV1` canonical UTF-8 bytes 的 SHA-256。

`batchHash` 是移除 `batchHash` 字段后的 `{ protocolVersion, batchIndex, changes }` canonical UTF-8 bytes 的 SHA-256。`maxBatchBytes` 计算实际发送的完整 `PushBatch` JSON UTF-8 字节数，包含 `batchHash` 和正文；`totalBodyBytes` 是全部 upsert 规范化正文字节数之和，archive 贡献 0。

批次划分是确定性的：先使用 confirmation manifest 的 changes 顺序；从 batch 0 开始贪心加入下一 change，直到再加入会超过 `maxBatchItems` 或完整 PushBatch 的 `maxBatchBytes`，然后开启下一批。单条 change 自身超限返回 `PAGE_TOO_LARGE` 或 `BATCH_TOO_LARGE`。恢复上传时必须用 session 创建时记录的 capability 重新得到相同 partition 和 batchHash。

幂等键是在用户确认预览时生成并持久化的随机 UUID v4，不由 confirmation hash 推导。同一 idempotency key 必须绑定同一 user、credential、Space、base revision 和 confirmation hash。

### 3.5 固定 hash fixture

正文 `Hello\n` 的 `contentHash`：

```text
66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18
```

canonical confirmation manifest：

```json
{"baseRevision":"rev-7","changes":[{"contentHash":"66a045b452102c59d840ec097d59d9467e13a3f34f6494e539ffd32c1bb35f18","operation":"upsert","pageId":"11111111-1111-4111-8111-111111111111","path":"Guide.md","title":"Guide"},{"operation":"archive","pageId":"22222222-2222-4222-8222-222222222222","previousPath":"Old.md"}],"protocolVersion":"1","spaceId":"space-a"}
```

预期 `confirmationHash`：

```text
212c1be142dfc093c9c8974080b7f0b9b8ae956c137284fd58a8db1248e4a3d5
```

同一组 changes 的 batch 0 在 upsert 中额外包含 `"body":"Hello\n"`；移除 `batchHash` 后的预期 `batchHash`：

```text
a2a748fe94c9c1d63c26bf35d4a50e32d085e352033f4f52126cb80545f25276
```

把该 `batchHash` 加回完整 PushBatch 后，canonical JSON 的 `maxBatchBytes` 计数为 `428`。

固定 pathKey fixture：`pathKey("Straße/İ.MD")` 必须得到 `strasse/i\u0307.md`（`i` 后是 U+0307 COMBINING DOT ABOVE）。

## 4. AgentWiki Page 公共同步模型

同步 API 使用以下公开模型；它是 AgentWiki 所有页面写入路径共同维护的正式状态，不是 local-sync 的临时投影：

```ts
interface SyncPageRecord {
  pageId: string;
  spaceId: string;
  path: string;
  pathKey: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}
```

字段映射固定如下：

- `pageId` 对应 `Page.knowledgeKey`，是公开、稳定且不透明的 Knowledge ID；`Page.id` 仍是数据库内部 ID，永不进入 sync v1。
- 现有 `knowledgeKey` 原值保持不变；不要求把既有 CUID 改为 UUID。
- Obsidian 新页面使用 UUID v4 作为 `knowledgeKey`。服务端仅在同一 Space 中该 knowledgeKey 不存在时创建；已存在时必须属于同一页面，否则返回 `PAGE_ID_CONFLICT`。
- `path` 对应新增的非空 `Page.syncPath`，是 Space 内的规范化 Markdown 相对路径。
- `pathKey` 对应新增的非空 `Page.syncPathKey`。协议包 `pathKey(path)` 先做 NFC，再使用内嵌 Unicode 15.1 `CaseFolding.txt` 的默认 full case folding；不得依赖客户端操作系统 locale 或运行时自带 Unicode 版本。`@@unique([spaceId, syncPathKey])` 或等价 PostgreSQL 唯一约束防止跨平台碰撞。
- `title` 对应 `Page.title`，`body` 对应 `Page.content`，格式固定为 Markdown。
- `contentHash` 按第 3 节规范计算；`updatedAt` 是服务端 Page 更新时间，仅供展示，不作为客户端并发条件。

现有 Page 迁移必须确定且可重复：

1. 若 `sourcePath` 是合法 `.md` 相对路径且 pathKey 未占用，使用该路径。
2. 否则使用 `pages/<knowledgeKey>.md`。
3. 若历史异常数据仍发生 pathKey 碰撞，迁移失败并列出 Page ID，不允许静默加随机后缀。
4. backfill 完成后把 `syncPath`、`syncPathKey` 设为非空并建立唯一约束。

`slug` 继续服务 AgentWiki Web URL，`parentId` 继续服务 Web 层级，`sourcePath` 继续表示来源 provenance；三者都不能代替 `syncPath`。Web 移动/重命名页面必须显式更新 `syncPath`，并通过统一 revision 写入器校验路径。

非 sync v1 的新建入口如果没有显式合法 `syncPath`，先生成 knowledgeKey，再使用 `pages/<knowledgeKey>.md`；知识流水线可以把合法 source path 显式传为 syncPath。任何入口都不能从 title 临时派生易碰撞路径。

`PageVersion` 必须增加当时的 `syncPath` 与 `syncPathKey`，使恢复和审计能还原路径。创建新 Page 没有前置版本；update、move、rename、archive 和 restore 在变更前写 PageVersion。Obsidian 创建页的 `authorId` 和 `lastModifiedByUserId` 都取设备凭据对应的当前 user ID。

## 5. 统一 Space revision 与发布副作用

Space revision 必须覆盖所有可改变同步页面集合的操作，而不仅是知识审核发布。以下入口都必须通过同一个 `SpaceRevisionWriter`（名称可调整，语义不可调整）：

- AgentWiki Web/API 创建、修改、移动、重命名、归档或恢复 Page。
- ChangeSet 审核发布和回滚。
- Obsidian sync v1 finalize。
- 任何导入、迁移或后台任务对 Page 的可见修改。

Relation/Memory-only 变更不推进 page sync revision；包含 Page 项目的 ChangeSet 只为整次 Page 结果推进一个 revision。

写入器在同一数据库事务或具备等价 fencing 的临界区中：

1. 锁定当前 Space revision head。
2. 校验调用方提供的 expected revision 或页面版本条件。
3. 写 Page、PageVersion、归档状态、syncPath 和修改者 provenance。
4. 生成该次变更的 Delta。
5. 创建唯一、单调递增的 `SpaceKnowledgeRevision`。
6. 写与 revision 关联的审计记录。

`SpaceKnowledgeRevision` 必须补充：

```ts
interface RevisionOriginFields {
  parentRevisionId: string | null;
  origin: "web_editor" | "change_set" | "obsidian_sync" | "migration";
  createdByUserId: string | null;
  humanDeviceCredentialId: string | null;
  sourceChangeSetId: string | null;
}
```

Web/API 人类直接编辑使用 `web_editor + createdByUserId`，知识流水线使用 `change_set + sourceChangeSetId`，Obsidian 使用三项身份字段，历史回填使用 `migration`。直接 Web 编辑以 PageVersion 和 revision origin 审计，不额外制造 ChangeSet。

事务提交后通过持久化 outbox 更新 `PageSearchDocument`；归档会删除搜索索引。搜索索引失败不回滚已发布 revision，但必须可重试并暴露监控告警。

归档规则固定为：

- 写入归档前 PageVersion，设置 `Page.deletedAt`，从新 revision Snapshot 中排除该页。
- 删除 `PageSearchDocument`。
- 保留 Page、PageVersion 和 KnowledgeRelation 数据，以支持审计与恢复；默认查询和 Snapshot 忽略连接到已归档页面的 Relation。
- 恢复 Page 清除 `deletedAt`、重新校验 syncPath 唯一性、创建新 revision并重建搜索索引。

初始空 Space 的 revision 固定为：

```json
{
  "revision": "0",
  "sequence": 0,
  "revisionContentHash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
```

每个非空 revision 的 `revisionContentHash` 是该 revision 全部未归档 SyncPage 的精简 manifest（按 pageId 排序，只含 pageId/path/title/contentHash）canonical bytes 的 SHA-256。Snapshot、Delta、head 和 finalize 必须对同一 revision 返回相同值。

精简 manifest 的完整类型为：

```ts
interface RevisionContentManifestV1 {
  protocolVersion: "1";
  spaceId: string;
  pages: Array<{
    pageId: string;
    path: string;
    title: string;
    contentHash: string;
  }>;
}
```

`pages` 按 pageId Unicode code point 升序。零页面 revision 使用零字节 SHA-256，即上面的 `e3b0...b855`，不对空 JSON 对象求 hash。统一写入器在所有入口把 Page content 的换行规范化为 LF，并保证 `format = "markdown"`；迁移遇到非 Markdown Page 必须先显式转换，不能从 sync revision 中静默排除。

Obsidian finalize 必须创建一个来源为 `obsidian_sync`、状态直接为 `published` 的 ChangeSet 和 published ChangeItem，记录 `createdByUserId`、HumanDeviceCredential ID、confirmation hash、base revision 和新 revision。它不创建待审核 Approval，也不授予调用者一般 `review:decide` 权限。这是唯一允许的审计实现，不使用“等价记录”分支。

为承载该审计，`ChangeSet` 增加 `origin: "review" | "obsidian_sync"`、`humanDeviceCredentialId`、`confirmationHash` 和 `baseRevisionId` 可空字段；普通 ChangeSet 使用默认 `review`。Obsidian ChangeItem 使用既有 `create_page/update_page/archive_page` 类型、状态直接为 `published`，`publishedResourceId` 保存内部 `Page.id`，payload 同时保存公开 pageId/path/title/contentHash 以及变更前字段。`reviewedAt` 与 `publishedAt` 设为同一事务时间，不创建 Approval。

### 5.1 有界 revision 存储

sync v1 不得从现有 `SpaceKnowledgeRevision.snapshot` 单个 JSON 字段读取完整 100 MiB Snapshot。主项目需新增或等价实现以下规范化存储；字段名可遵循 Prisma 命名规范，关系语义必须一致：

```ts
interface SyncPageContentRow {
  contentHash: string; // primary key
  body: string;
  byteLength: number;
}

interface SyncRevisionPageRow {
  revisionId: string;
  pageId: string;
  path: string;
  pathKey: string;
  title: string;
  contentHash: string; // FK -> SyncPageContentRow
  updatedAt: string;
}

interface SyncRevisionDeltaRow {
  revisionId: string; // 本次 toRevision
  ordinal: number;
  operation: "upsert" | "archive";
  pageId: string;
  previousPath: string | null;
  contentHash: string | null;
}
```

约束：

- `SyncRevisionPageRow` 唯一键为 `(revisionId, pageId)`，另有 `(revisionId, pathKey)` 唯一键。
- `SyncRevisionDeltaRow` 唯一键为 `(revisionId, ordinal)` 和 `(revisionId, pageId)`。
- 正文按 contentHash 去重；hash 与实际规范化正文不一致时事务失败。
- 新 revision 在数据库内通过上一 revision 的 entry `INSERT … SELECT` 后应用本次变更，或使用等价的持久化快照算法；不得先把整个 Space 读入 Node 内存。
- Snapshot 按 `(revisionId, pageId)` 数据库 keyset cursor 分页；Delta 按 revision sequence 与 ordinal 分页。
- revisionContentHash 以 pageId 排序流式计算，不构造全量 JSON 字符串。
- 内容 blob 只有在没有 Page、revision entry 或未过期 staging 引用后才能垃圾回收。
- 旧 `snapshot/delta` JSON 可为兼容 local-sync 保留，但 sync v1 的正确性和性能不能依赖它。后续迁移旧 revision 时按固定批次回填规范化 entry。

统一写入器的 Page 修改方法必须返回 `{ page, revision, sequence, revisionContentHash }`，使 Web/API 调用者能观测该次写入对应的 revision。

## 6. 人类设备凭据模型

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
- 设备凭据是 32 个密码学安全随机字节的 base64url 字符串。数据库保存 `HMAC-SHA-256(serverPepper, credential)`，serverPepper 只来自服务端秘密配置；日志不记录明文或摘要。
- 凭据长期有效，直到用户或当前设备撤销。
- 同一 `userId + deviceId + vaultId` 重新连接时可以撤销旧凭据并签发新凭据。
- 凭据认证得到人类 principal：包含 `userId` 和 `credentialId`，不包含 `agentId`。
- 认证时重新加载未删除、有效用户；不得相信签发时缓存的用户状态。
- 授权时重新加载 Space membership、角色和 platform role。
- 凭据只被 Obsidian integration 与 sync v1 路由接受，不能调用一般用户管理、成员管理、Agent 管理、凭据管理或 Review 决策 API。

## 7. 一次性连接码

### 7.1 创建连接码

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

- code 至少包含 20 个密码学安全随机字节并以适合人工复制的 base64url 字符串表示，明文只显示一次；数据库只保存同样使用 serverPepper 的 HMAC。
- code 最长有效 10 分钟。
- 成功交换后立即失效。
- 撤销 installation 后立即失效。
- 创建行为记录 user ID、时间和安全审计事件，但不记录明文 code。

`DELETE /api/integrations/obsidian/installations/:installationId` 由创建该 installation 的当前 Web 人类用户调用。未交换状态成功返回 `204` 并使 code 失效；已交换返回 `INSTALLATION_ALREADY_EXCHANGED / 409`，用户应改为撤销对应设备凭据。

### 7.2 交换设备凭据

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
  "serverInstanceId": "uuid",
  "credential": "secret-returned-once",
  "credentialId": "uuid",
  "user": {
    "id": "uuid",
    "displayName": "NeoMei"
  },
  "capabilities": {
    "maxPageBytes": 1048576,
    "maxBatchBytes": 4194304,
    "maxBatchItems": 100,
    "maxResponseBytes": 4194304,
    "maxPageItems": 200,
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
- `serverInstanceId` 是数据库持久化的部署实例 UUID；重启和域名变化时保持不变，数据库克隆到独立服务时必须显式轮换。

## 8. 设备会话

### 8.1 查询当前会话

`GET /api/integrations/obsidian/session`

返回 credential ID、当前用户、设备元数据、协议版本和有效状态，不返回 credential：

```ts
interface HumanDeviceSessionResponse {
  protocolVersion: "1";
  serverInstanceId: string;
  credentialId: string;
  deviceId: string;
  deviceName: string;
  vaultId: string;
  createdAt: string;
  lastUsedAt: string;
  user: { id: string; displayName: string };
  capabilities: SyncCapabilities;
}

interface SyncCapabilities {
  maxPageBytes: number;
  maxBatchBytes: number;
  maxBatchItems: number;
  maxResponseBytes: number;
  maxPageItems: number;
  pushSessionTtlSeconds: number;
}
```

### 8.2 撤销当前设备

`DELETE /api/integrations/obsidian/credentials/current`

只撤销当前 HumanDeviceCredential。成功返回 `204`。撤销成功后当前请求之外的后续请求必须失败；重复撤销以 `DEVICE_CREDENTIAL_REVOKED` 返回 `401`。

### 8.3 用户端设备管理

AgentWiki Web 必须允许当前用户查看和撤销自己的 Obsidian 设备：

- `GET /api/integrations/obsidian/credentials` 返回 `HumanDeviceCredentialSummary[]`。
- `DELETE /api/integrations/obsidian/credentials/:credentialId` 只能撤销当前 user 自己的凭据，成功返回 `204`。

```ts
interface HumanDeviceCredentialSummary {
  credentialId: string;
  deviceId: string;
  vaultId: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface HumanDeviceCredentialListResponse {
  protocolVersion: "1";
  credentials: HumanDeviceCredentialSummary[];
}
```

列表不返回 credential 明文或摘要。撤销操作写安全审计事件；重复撤销返回 `204`，避免 Web 管理界面竞态。

## 9. Space 列表与能力

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

interface SyncSpaceListResponse {
  protocolVersion: "1";
  spaces: SyncSpaceSummary[];
}
```

- `viewer` 的 `canPublish` 为 false。
- `editor`、`admin`、`owner` 的 `canPublish` 为 true。
- 当前有效 `super_admin` 返回 effective role `owner`，但不创建 Space membership；设备凭据只继承同一人类用户实时重载后的 platform role。
- 用户失效、成员关系变化和 platform role 变化必须在下一次请求生效。

## 10. Revision head

`GET /api/sync/v1/spaces/:spaceId/head`

响应：

```json
{
  "protocolVersion": "1",
  "spaceId": "uuid",
  "revision": "revision-id",
  "sequence": 7,
  "revisionContentHash": "sha256",
  "publishedAt": "2026-08-13T11:00:00.000Z"
}
```

该端点只返回 head，不返回页面正文，用于 Status 和 Push 前置检查。初始 revision `0` 的 `publishedAt` 为 `null`，因此该字段的正式类型是 `string | null`。

## 11. 分页 Snapshot

`GET /api/sync/v1/spaces/:spaceId/snapshot?revision=<id>&cursor=<opaque>&limit=<n>`

规则：

- 第一次请求可以使用 `revision=current`；响应必须解析为一个固定 revision。
- 后续 cursor 永远绑定同一固定 revision。
- 页面按 page ID 稳定排序。
- cursor 不透明，客户端不得解析。
- cursor 是 base64url 编码、服务端 HMAC 签名的 payload，绑定 route kind、Space、固定 revision、最后 pageId/ordinal 和 24 小时到期时间；签名错误、跨路由/Space 使用或过期返回 `CURSOR_INVALID`。
- 后续有新发布时，本次分页结果仍保持固定 revision。
- revision 不存在或已清理时返回 `REVISION_GONE`。
- `limit` 必须在 `1..capabilities.maxPageItems`；默认取二者较小的 100。
- 服务端在加入下一项会使完整 JSON 响应超过 `maxResponseBytes` 时提前结束本页并返回 cursor。单个合法页面必须始终可以单独返回，因此 `maxResponseBytes` 必须大于 `maxPageBytes` 加协议开销。
- 每一页都重复相同 revision、sequence 和 revisionContentHash；客户端发现变化必须废弃全部分页结果。

响应：

```ts
interface SnapshotPage {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
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

## 12. 分页 Delta

`GET /api/sync/v1/spaces/:spaceId/delta?from=<revision>&cursor=<opaque>&limit=<n>`

响应固定 `fromRevision` 和 `toRevision`：

```ts
interface DeltaPage {
  protocolVersion: "1";
  spaceId: string;
  fromRevision: string;
  toRevision: string;
  toSequence: number;
  toRevisionContentHash: string;
  items: DeltaItem[];
  nextCursor: string | null;
}

type DeltaItem =
  | { operation: "upsert"; page: SyncPage }
  | { operation: "archive"; pageId: string; previousPath: string };
```

移动和重命名使用同一 page ID 的 `upsert` 表达。若 `from` 已不可用，返回 `REVISION_GONE`，客户端改取 Snapshot 并使用本地 base 做三方合并。

Delta 使用与 Snapshot 相同的条数、字节、cursor 和固定 revision 规则。archive 项目按 page ID 排序位置参与分页；同一 `toRevision` 中一个 page ID 只出现一次最终操作。

当 `fromRevision` 不是 head 时，服务端把 `(fromSequence, toSequence]` 中所有 revision delta 合并为每个 page ID 的最终净变化：

- 在 from Snapshot 不存在、to Snapshot 存在：返回一次最终 `upsert`。
- 两边都存在且 path/title/contentHash 任一不同：返回一次最终 `upsert`。
- from 存在、to 不存在：返回一次 `archive`，`previousPath` 取 from Snapshot 的 path。
- 两边都不存在或最终完全相同：不返回项目。

实现使用 revision rows 的有序 SQL/流式归并，不把完整 from/to Snapshot 加载到 Node 内存。`toRevision` 在第一次请求时锁定为当时 head，后续 cursor 不随新发布变化。

## 13. Push session

Push 使用临时上传会话，避免把整个 Space 放入单一请求，同时保持最终发布原子性。

服务端 staging 按 session metadata、batch receipt 和逐条 PushChange 持久化，正文复用第 5.1 节 content blob；不得把全部批次累积到单个数据库 JSON 或 Node 内存对象。finalize 按 pageId 有序读取 staging、验证并在同一发布事务中应用；临时数据总量受租户配额限制。

### 13.1 创建 session

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

```ts
interface CreatePushSessionResponse {
  protocolVersion: "1";
  sessionId: string;
  status: "uploading";
  expiresAt: string;
  capabilities: SyncCapabilities;
}
```

相同 idempotency key 和 confirmation hash 的创建重试返回同一 session，状态码仍为 `201`；相同 key、不同 base/hash 返回 `IDEMPOTENCY_MISMATCH`。

响应中的 capabilities 固化到该 session，后续服务端配置变化不影响已创建 session 的批次划分；客户端只用该响应的 capability 构造批次。

### 13.2 上传批次

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

interface PushBatchReceipt {
  protocolVersion: "1";
  sessionId: string;
  batchIndex: number;
  batchHash: string;
  receipt: string;
  receivedBatchCount: number;
}
```

规则：

- 批次必须满足 session 返回的 item 和完整 HTTP body byte 限制。
- 相同 session、batch index 和 batch hash 的重试返回原成功结果。
- 相同 index、不同 hash 返回 `BATCH_MISMATCH`。
- 上传阶段只写临时 staging，不改变 Page、ChangeSet 或 revision。
- 批次顺序可以乱序到达；finalize 负责检查索引完整性。
- 批次不能为空；batch index 必须从 0 开始连续。finalize 要求 `0..maxReceivedIndex` 每个 index 恰好存在一次，且全部 changes 数量等于 changeCount。
- 同一 page ID 不得跨批次重复；finalize 发现重复返回 `PAYLOAD_INVALID`。
- 任一批次使 session 累计 change 数或 totalBodyBytes 超过创建声明时立即返回 `PAYLOAD_INVALID`，不保存该批次。
- receipt 是 `base64url(HMAC-SHA-256(serverPepper, sessionId + "\n" + batchIndex + "\n" + batchHash))`；客户端只需原样持久化，不用于授权。

### 13.3 原子 finalize

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

如果 changeCount 为 0，客户端不应创建 session；服务端仍必须接受幂等重试并返回 `noop` 和当前 revision，不创建 ChangeSet 或新 revision。如果所有 upsert 与当前 page 完全相同且没有 archive，finalize 同样返回 `noop`，不创建 ChangeSet 或新 revision。`existing` 只表示相同 idempotency key 已经完成过，返回第一次的原始结果。

成功响应：

```ts
interface FinalizePushResponse {
  protocolVersion: "1";
  status: "published" | "noop" | "existing";
  revision: string;
  sequence: number;
  publishedAt: string;
  revisionContentHash: string;
  changeSetId: string | null;
}
```

同一 idempotency key 和同一 payload 返回第一次结果；同一 key 和不同 payload 返回 `IDEMPOTENCY_MISMATCH`。

### 13.4 查询 session 与最终结果

`GET /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

只允许创建该 session 的当前 HumanDeviceCredential 查询。响应返回：

```ts
interface PushSessionStatusResponse {
  protocolVersion: "1";
  sessionId: string;
  status: "uploading" | "ready_to_finalize" | "finalizing" | "published" | "aborted" | "expired";
  receivedBatchIndexes: number[];
  expiresAt: string;
  result: FinalizePushResponse | null;
}
```

finalize 已提交但客户端未收到响应时，该端点必须返回持久化的最终结果。查询不得延长 session 到期时间，不得泄漏正文或其他 credential 的 session。已发布 session 及其不含正文的最终结果至少保留 30 天；staging 正文可在发布后立即删除。

### 13.5 审计而非二次审核

人类设备 finalize 已包含 Obsidian 内的明确确认。服务端必须按第 5 节创建同步来源、直接 published 的 ChangeSet 和 ChangeItem，不得返回 `pending_review`。AgentCredential 的现有提交仍必须进入待审核 ChangeSet，不能使用本接口。

### 13.6 终止 session

`DELETE /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

允许当前 credential 在 finalize 前删除 staging，成功返回 `204`。`finalizing` 或 `published` 状态返回 `PUSH_SESSION_STATE_INVALID`；到期 session 由服务端安全清理。清理不得影响已发布 revision。

## 14. 容量和分页要求

- 协议不设置 Space 总页数硬上限。
- 服务端可以执行租户配额，但必须通过结构化 `QUOTA_EXCEEDED` 返回当前限制。
- 单页最大正文为 1 MiB。
- 单批次和单响应限制由 exchange/session capability 返回；服务端 v1 默认均为 4 MiB，客户端不得固化更大的值。
- 首版端到端验收基线：单 Space 5,000 页、规范化正文总计 100 MiB。
- Snapshot、Delta 和上传必须以有界批次处理；服务端和客户端都不得要求把完整 100 MiB payload 同时保存在一个 JSON 对象中。

## 15. 错误 envelope

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
- `INSTALLATION_NOT_FOUND`
- `INSTALLATION_REVOKED`
- `INSTALLATION_ALREADY_EXCHANGED`
- `INSTALLATION_CODE_INVALID`
- `INSTALLATION_CODE_EXPIRED`
- `PROTOCOL_UNSUPPORTED`
- `REVISION_GONE`
- `CURSOR_INVALID`
- `BASE_STALE`
- `CONFIRMATION_REQUIRED`
- `CONFIRMATION_MISMATCH`
- `PAYLOAD_INVALID`
- `PATH_COLLISION`
- `PAGE_ID_CONFLICT`
- `PAGE_TOO_LARGE`
- `BATCH_TOO_LARGE`
- `BATCH_MISMATCH`
- `PUSH_SESSION_EXPIRED`
- `PUSH_SESSION_NOT_FOUND`
- `PUSH_SESSION_STATE_INVALID`
- `PUSH_SESSION_INCOMPLETE`
- `IDEMPOTENCY_MISMATCH`
- `QUOTA_EXCEEDED`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

错误 details 不得包含凭据、安装码、Authorization header 或 Markdown 正文。

错误到 HTTP 与重试语义固定如下；未列出的验证错误归入 `PAYLOAD_INVALID / 400 / false`：

| Error code | HTTP | retryable |
|---|---:|---|
| `AUTHENTICATION_REQUIRED`, `DEVICE_CREDENTIAL_REVOKED` | 401 | false |
| `USER_INACTIVE`, `SPACE_FORBIDDEN`, `SPACE_READ_ONLY` | 403 | false |
| `INSTALLATION_NOT_FOUND`, `PUSH_SESSION_NOT_FOUND` | 404 | false |
| `INSTALLATION_REVOKED`, `PUSH_SESSION_EXPIRED`, `REVISION_GONE` | 410 | false |
| `INSTALLATION_CODE_INVALID`, `INSTALLATION_CODE_EXPIRED` | 401 | false |
| `PROTOCOL_UNSUPPORTED` | 409 | false |
| `CURSOR_INVALID`, `CONFIRMATION_REQUIRED`, `PAYLOAD_INVALID` | 400 | false |
| `INSTALLATION_ALREADY_EXCHANGED`, `BASE_STALE`, `CONFIRMATION_MISMATCH`, `PATH_COLLISION`, `PAGE_ID_CONFLICT`, `BATCH_MISMATCH`, `PUSH_SESSION_INCOMPLETE`, `PUSH_SESSION_STATE_INVALID`, `IDEMPOTENCY_MISMATCH` | 409 | false |
| `PAGE_TOO_LARGE`, `BATCH_TOO_LARGE`, `QUOTA_EXCEEDED` | 413 | false |
| `RATE_LIMITED` | 429 | true |
| `INTERNAL_ERROR` | 500 | true |

`retryable` 只表示“不改变请求语义即可稍后重试”。`BASE_STALE` 虽可通过先 Pull 恢复，但原请求本身不可直接重试，因此为 false。429 响应必须带整数秒 `Retry-After` header。

## 16. HTTP 与安全要求

- 生产服务地址必须是 HTTPS。
- 仅 development 模式允许 loopback HTTP。
- URL 禁止嵌入用户名或密码。
- credential 使用 `Authorization: Bearer <secret>`。
- 敏感响应设置 `Cache-Control: no-store`。
- 服务端日志中对 code、credential、Authorization 和正文做默认删除或脱敏。
- 默认限流：安装码创建每 user 每分钟 5 次；exchange 每 IP 每 15 分钟 10 次失败、每 installation 最多 5 次失败；session 创建每 credential+Space 每分钟 10 次；批次上传每 credential 每分钟 120 次；finalize 每 credential+Space 每分钟 10 次。部署可调低但不能调高超过 10 倍，429 必须返回 `Retry-After`。
- 所有 Space 路由在 service layer 重新授权，不能只依赖 controller guard。
- finalize 的权限、base 和 payload 校验必须抵抗 TOCTOU；最终检查位于发布事务或等价 fenced 临界区。
- staging 数据绑定 credential、user、Space、session 和到期时间；其他 principal 不可读取或 finalize。

## 17. 验收测试

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
14. Web Page create/update/move/archive/restore、ChangeSet 发布/回滚和 Obsidian finalize 都推进同一 Space revision；没有任何可见 Page 修改绕过 head。
15. `knowledgeKey ↔ pageId` 与 `syncPath ↔ path` 往返不变，现有 Page backfill 可重复且碰撞时失败。
16. finalize 同时写 PageVersion、published ChangeSet/ChangeItem、修改者 provenance 和 revision；归档删除搜索索引但保留 Relation/PageVersion。
17. Snapshot/Delta 同时受 item 和 response byte 限制，单页跨分页可完成，cursor 各页 revision/hash 一致。
18. 第 3.5 节 fixture 的 content、confirmation、batch hash 和 428 字节计数在浏览器与 Node 完全一致。
19. sync v1 Snapshot/Delta 从规范化 revision rows 使用 keyset cursor 读取；性能测试证明请求路径不解析完整 legacy snapshot JSON。
20. 内容 blob 去重、引用保留和垃圾回收不会删除历史 revision 或未过期 staging 仍引用的正文。

## 18. 跨仓实施规则

- 本文档只记录插件所需公开契约，不授权当前任务修改 AgentWiki 主项目。
- 主项目实现必须建立独立设计、计划、测试和发布任务。
- 插件只能依赖已发布协议包和公开 API，不能复制主项目 controller、service、Prisma 类型或 local-sync 内部实现。
- 主项目最终路由或字段如需调整，必须先更新本契约并在插件仓库中明确版本迁移影响。
