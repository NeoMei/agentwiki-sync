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
- `capabilitiesHash(capabilities)`，对完整 `SyncCapabilities` canonical bytes 求 SHA-256。
- `exchangeRequestHash(request)`，按第 7.2 节的安全投影计算，不把 code 或明文 credential 交给通用日志/诊断。
- `parseBatchIndex(text)`、`parsePageLimit(text)`，只接受第 14.1 节 canonical ASCII 十进制字符串并返回安全整数。
- `parseDecimalCount(text)`，只接受第 5 节定义的 canonical 非负十进制字符串并返回 bigint；`DecimalCountSchema` 与 `DecimalByteCountSchema` 同时导出。
- `idFileKey(id)`，返回已通过第 3.3 节校验的 ID 原字符串 UTF-8 bytes 的 SHA-256 小写十六进制值，不做大小写或 Unicode 改写，供客户端安全映射本地控制文件名。
- `partitionPushChanges(changes, capabilities)`，实现第 3.4 节确定性批次划分。

包内不得导出 AgentWiki Prisma、NestJS、Obsidian 或 Node `Buffer` 类型；hash API 接受/返回 `Uint8Array` 和字符串，并使用 Web Crypto 兼容实现。

### 2.1 HTTP 约定

- JSON 请求和响应使用 `application/json; charset=utf-8`。
- Push confirmation、Push batch 以及明确参与 hash/byte limit 的请求体必须直接发送协议包产生的 canonical JSON UTF-8 bytes；不得先 hash canonical JSON、再发送字段顺序或转义不同的另一份 JSON。exchange 的 requestHash 使用第 7.2 节不含 code/明文 credential 的安全投影；HTTP body 本身仍按 request Schema 序列化并受 TLS 保护，不把含明文 secret 的 bytes 交给通用 hash/诊断流水线。
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
| 激活当前设备凭据 | 200 | 400, 401, 403, 409 |
| 撤销当前设备 | 204 | 401, 403 |
| Web 列出/撤销自己的设备 | 200/204 | 401, 403, 404 |
| 列出 Space | 200 | 401, 403 |
| 查询 head/Snapshot/Delta | 200 | 400, 401, 403, 404, 410, 429 |
| 创建 Push session | 201 | 400, 401, 403, 409, 413, 429 |
| 上传批次 | 200 | 400, 401, 403, 404, 409, 410, 413, 429 |
| finalize | 200 | 400, 401, 403, 404, 409, 410, 413, 429 |
| 查询 Push session | 200 | 401, 403, 404 |
| 终止 Push session | 204 | 401, 403, 404, 409, 410 |

对无权访问的 Space 或 Push session，服务端可统一返回 404 以避免资源枚举；上表中的 403 只用于资源归属已知但当前操作权限不足（例如 viewer finalize）。插件不依赖 403/404 来推断资源是否存在。

## 3. 规范化与 hash

### 3.1 Markdown 正文

- UTF-8 编码。
- `CRLF` 和单独 `CR` 规范化为 `LF`。
- 保留末尾换行的有无。
- 不做 Unicode 正文归一化。
- 正文不得以 U+FEFF 开头；插件把对应的 UTF-8 BOM bytes 视为阻塞性非法输入，避免文本 API 吞掉 BOM 后破坏原始字节条件写入。
- 单页规范化正文最大 1 MiB。

### 3.2 路径与标题

- 相对路径使用 `/` 分隔。
- 路径段使用 Unicode NFC。
- 禁止绝对路径、空段、`.`、`..`、U+0000–U+001F、`< > : " / \\ | ? *` 和根目录逃逸。
- 任一路径段不得以空格或句点结尾；路径段从开头到第一个 `.` 前的 Windows device basename 按 ASCII 大小写不敏感不得等于 `CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`、`COM¹`–`COM³` 或 `LPT¹`–`LPT³`。
- 每个 NFC 路径段的 UTF-8 编码最长 255 字节，完整相对路径的 UTF-8 编码最长 1,024 字节。
- 标题长度为 1–500 个 Unicode code point，禁止 U+0000–U+001F；不自动 trim 或做 Unicode 归一化。
- 同一 Space 中禁止 NFC 后重复和仅大小写不同的路径。
- path 扩展名按 ASCII 大小写不敏感必须等于 `.md`；服务端保留客户端提交的实际大小写。扩展名判断在 NFC 规范化后的最后一个路径段执行，最后一个 `.` 之后的 ASCII fold 必须精确为 `md`。

### 3.3 内容 hash

`contentHash` 是规范化 UTF-8 正文的 SHA-256 小写十六进制字符串。

公共 Knowledge ID（page ID、revision ID、Space ID）长度为 1–128，字符集为 `[A-Za-z0-9._-]` 且首字符必须是字母或数字。`deviceId`、`vaultId`、`installationId`、`exchangeId`、`credentialId`、`credentialFamilyId`、`serverInstanceId`、`sessionId`、`idempotencyKey` 和本地 transaction ID 使用标准小写 UUID v4。`deviceName` 为去除首尾空白后的 1–100 个 Unicode 字符；plugin version 为最长 64 字符的 SemVer。opaque cursor 最长 4,096 字符。

### 3.4 canonical serialization

协议包必须提供唯一的 canonical serialization 规则：

- 对象 key 按 Unicode code point 升序排列。
- 数组保持协议定义顺序；Push changes 在进入 canonical serializer 前按 `(pageId, operation, path-or-previousPath)` 的 Unicode code point tuple 稳定排序。
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

幂等键是在用户确认预览时生成并持久化的随机 UUID v4，不由 confirmation hash 推导。同一 idempotency key 必须绑定同一 user、credential family、Space、base revision、confirmation hash、confirmationByteLength、changeCount 和 totalBodyBytes；凭据轮换不改变已确认操作的 family identity。数据库唯一键至少为 `(credentialFamilyId, idempotencyKey)`；不同 family 可以使用相同随机 UUID 而不互相探测。

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
- Obsidian 新页面使用 UUID v4 作为 `knowledgeKey`。sync v1 的公开 pageId 在整个 AgentWiki 实例内全局唯一，服务端仅在该 knowledgeKey 全局不存在时创建；已存在时必须是同一内部 Page，否则返回 `PAGE_ID_CONFLICT`。数据库必须为 `Page.knowledgeKey` 建立全局唯一约束，或建立以 knowledgeKey 为主键并唯一引用内部 Page/Space 的 `SyncPageIdentityRegistry`；仅有 `(spaceId, knowledgeKey)` 唯一键不够阻止两个 Space 的并发 finalize 创建同一 pageId。
- `path` 对应新增的非空 `Page.syncPath`，是 Space 内的规范化 Markdown 相对路径。
- `pathKey` 对应新增的非空 `Page.syncPathKey`。协议包 `pathKey(path)` 先做 NFC，再使用内嵌 Unicode 15.1 `CaseFolding.txt` 的默认 full case folding；不得依赖客户端操作系统 locale 或运行时自带 Unicode 版本。数据库必须建立 `@@unique([spaceId, syncPathKey])`，并在迁移 SQL 中显式命名该唯一约束，防止跨平台碰撞。
- `title` 对应 `Page.title`，`body` 对应 `Page.content`，格式固定为 Markdown。
- `contentHash` 按第 3 节规范计算；`updatedAt` 是服务端 Page 更新时间，仅供展示，不作为客户端并发条件。

现有 Page 迁移必须确定且可重复：

1. 先为每个现有 Page 写迁移前 PageVersion，精确保留原始 `format`、未规范化正文、路径字段和迁移批次 ID；迁移可按 Space 重试，已完成项不得重复创建版本。
2. 所有 Page 的新正文先拒绝开头 U+FEFF，再执行 `normalizeMarkdown`，唯一允许的内容变化是 `CRLF/CR → LF`。发现 U+FEFF 时该 Space 迁移失败并列出内部 Page ID，不能静默剥离；非 Markdown format（当前包括 `json`）不做解析、重排、缩进、代码围栏或其他转换，只把 Page.format 明确改为 `markdown`。因此成功迁移的结果确定，原始正文仍可由 PageVersion 审计恢复。
3. 若 `sourcePath` 是符合第 3.2 节可移植规则的 `.md` 相对路径且 pathKey 未占用，使用该路径。
4. 否则使用 `pages/p-<idFileKey(knowledgeKey)>.md`。不得直接把 knowledgeKey 放进路径，因为合法 ID 仍可能是 Windows device basename；完整 64 位 key 不截断。
5. 现有 knowledgeKey 必须符合第 3.3 节公共 ID 规则；非法 ID 的迁移失败并列出内部 Page ID，不得静默重写公开 identity。
6. 若历史异常数据仍发生 pathKey 碰撞，迁移失败并列出 Page ID，不允许静默加随机后缀。
7. 一个 Space 的正文转换、syncPath backfill、初始规范化 revision 和约束启用必须在可恢复迁移阶段中完成；失败时该 Space 不对 sync v1 可见，现有 Web 与旧 local-sync 数据不得处于半迁移状态。
8. 全部 Space backfill 完成后把 `syncPath`、`syncPathKey` 设为非空并建立唯一约束。
9. 启用 sync v1 前扫描全部现有 Page 的 knowledgeKey；发现跨 Space 重复时迁移失败并列出内部 Page ID/Space ID，由运维显式解决，不能静默改写公开 identity。校验通过后再建立全局 pageId identity 约束。

`slug` 继续服务 AgentWiki Web URL，`parentId` 继续服务 Web 层级，`sourcePath` 继续表示来源 provenance；三者都不能代替 `syncPath`。Web 移动/重命名页面必须显式更新 `syncPath`，并通过统一 revision 写入器校验路径。

非 sync v1 的新建入口如果没有显式合法 `syncPath`，先生成 knowledgeKey，再使用 `pages/p-<idFileKey(knowledgeKey)>.md`；知识流水线可以把合法 source path 显式传为 syncPath。任何入口都不能从 title 临时派生易碰撞路径。

`PageVersion` 必须增加当时的 `syncPath`、`syncPathKey` 和可空 `migrationBatchId`，使恢复、迁移幂等和审计能还原路径。创建新 Page 没有前置版本；update、move、rename、archive 和 restore 在变更前写 PageVersion。迁移版本以 `(pageId, migrationBatchId)` 唯一，避免批次重试重复写。Obsidian 创建页的 `authorId` 和 `lastModifiedByUserId` 都取设备凭据对应的当前 user ID。

## 5. 统一 Space revision 与发布副作用

Space revision 必须覆盖所有可改变同步页面集合的操作，而不仅是知识审核发布。以下入口都必须通过同一个 `SpaceRevisionWriter`（名称可调整，语义不可调整）：

- AgentWiki Web/API 创建、修改、移动、重命名、归档或恢复 Page。
- ChangeSet 审核发布和回滚。
- Obsidian sync v1 finalize。
- 任何导入、迁移或后台任务对 Page 的可见修改。

为保持现有 local-sync 只有一条权威 revision 序列，已发布的 Relation/Memory-only ChangeSet 也推进统一 revision，但复制父 revision 的 Page rows、保持相同 `revisionContentHash`，sync v1 Delta 为空。包含一个或多个 Page 项目的 ChangeSet 只为整次最终 Page 结果推进一个 revision。

写入器在同一数据库事务或具备等价 fencing 的临界区中：

1. 在 PostgreSQL 中以 Space 行锁或事务级 advisory lock 锁定当前 Space revision head；只依赖 `@@unique([spaceId, sequence])` 后失败重试不算完整并发控制。
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
  migrationBatchId: string | null;
}
```

Web/API 人类直接编辑使用 `web_editor + createdByUserId`，知识流水线使用 `change_set + sourceChangeSetId`，Obsidian 使用三项身份字段，历史回填使用 `migration + migrationBatchId`。`(spaceId, migrationBatchId)` 唯一，迁移重试返回同一 revision。直接 Web 编辑以 PageVersion 和 revision origin 审计，不额外制造 ChangeSet。

同一数据库事务内同步更新或删除 `PageSearchDocument` 的文本字段，使 revision 对外可见时关键词搜索结果已经一致；文本索引写入失败必须回滚 Page 和 revision。可选语义 embedding 仍可通过持久化 outbox 异步生成，失败不回滚已发布 revision，但必须可重试并暴露监控告警。该规则与 AgentWiki 稳定架构中的“同步维护 PageSearchDocument”一致。

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

每个 revision 同时持久化不可变的 `pageCount`、`revisionBodyBytes` 和 `revisionManifestByteLength`：pageCount 是未归档 row 数；revisionBodyBytes 是这些 row 引用的规范化正文 UTF-8 byteLength 之和；manifest byte length 是计算 revisionContentHash 的实际输入长度，零页为 0。三个值与 rows/hash 在同一 revision 写入事务中流式计算，Relation/Memory-only revision 原样复制父 revision 指标。三个指标在数据库都使用非负 `bigint`，公开 JSON 使用下述十进制字符串，避免大 Space 超出 JavaScript safe integer；head/Snapshot/Delta/finalize 只返回这些已持久化指标，不临时对当前 Page 表 count/sum。

```ts
type DecimalCount = string;
type DecimalByteCount = DecimalCount;
```

`DecimalCount`/`DecimalByteCount` 的严格 Schema 是 `"0"` 或不以 `0` 开头的十进制正整数字符串，数值不超过数据库 signed bigint 上限；禁止符号、小数、空白和指数形式。协议包提供 `parseDecimalCount()` 返回 bigint。插件先以 bigint 与 number capability 转换出的 bigint 比较，只有确认 pageCount ≤ 5,000、body ≤ 100 MiB、manifest ≤ 4 MiB 后才转换为本地安全整数；服务端不得先转 JavaScript number 再序列化。

Obsidian finalize 必须创建一个来源为 `obsidian_sync`、状态直接为 `published` 的 ChangeSet 和 published ChangeItem，记录 `createdByUserId`、HumanDeviceCredential ID、confirmation hash、base revision 和新 revision。它不创建待审核 Approval，也不授予调用者一般 `review:decide` 权限。这是唯一允许的审计实现，不使用“等价记录”分支。具有实际变更的 finalize 必须给 Push session 增加非空 `publishedChangeSetId` 或等价外键，并对该 session 一对一唯一，使服务端可以用数据库约束阻止重复审计发布。

为承载该审计，`ChangeSet` 增加 `origin: "review" | "obsidian_sync"`、`humanDeviceCredentialId`、`confirmationHash` 和 `baseRevisionId` 可空字段；普通 ChangeSet 使用默认 `review`。Obsidian ChangeItem 使用既有 `create_page/update_page/archive_page` 类型、状态直接为 `published`，`publishedResourceId` 保存内部 `Page.id`，payload 同时保存公开 pageId/path/title/contentHash 以及变更前字段。`reviewedAt` 与 `publishedAt` 设为同一事务时间，不创建 Approval。

### 5.1 有界 revision 存储

sync v1 不得从现有 `SpaceKnowledgeRevision.snapshot` 单个 JSON 字段读取完整 100 MiB Snapshot。主项目必须新增以下规范化存储；字段名可遵循 Prisma 命名规范，关系语义必须一致：

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
- 新 revision 在数据库内通过上一 revision 的 entry `INSERT … SELECT` 后应用本次变更，或使用等价的持久化快照算法；不得先把整个 Space 读入 Node 内存。sequence 在持有同一 Space 锁时由上一 head + 1 生成，parentRevisionId 必须等于被锁定 head。
- Snapshot 按 `(revisionId, pageId)` 数据库 keyset cursor 分页；Delta 按 revision sequence 与 ordinal 分页。
- revisionContentHash 以 pageId 排序流式计算，不构造全量 JSON 字符串。
- 内容 blob 只有在没有 Page、revision entry 或未过期 staging 引用后才能垃圾回收。
- `SpaceKnowledgeRevision` 必须删除现有 `@@unique([spaceId, contentHash])`；Space 内容允许经历 `A → B → A`，第三次仍创建新 sequence/revision。可保留普通 `(spaceId, contentHash)` 索引用于查询，但 content hash 不是 revision identity。
- `SpaceKnowledgeRevision` 新增非空 `revisionContentHash`。现有 `contentHash` 保留为 legacy bundle hash，供旧路由使用；两者语义不得混用。所有旧 revision 按 sequence 升序固定批次回填规范化 page entry并重算 `revisionContentHash`，不覆盖旧 `contentHash`。每个 revision 的 page rows 必须由其历史 snapshot/delta 得到，不能用当前 Page 表倒灌历史。回填 hash 或 page 内容不一致时停止该 Space 迁移并报告 revision ID。
- `SpaceKnowledgeRevision` 同批新增非空 `pageCount/revisionBodyBytes/revisionManifestByteLength`；历史回填从对应 revision rows/blob 求得并与重建 hash 同批校验，不能用当前 Page 表指标代替历史值。
- Prisma 迁移顺序固定为 expand/backfill/contract：Release A 先添加可空新列和新表、部署可同时读写新旧存储的代码，再按 Space 回填并校验；Release B 最后添加非空/唯一约束、删除 contentHash 唯一约束并允许 legacy JSON 为空。Release A 可回滚到旧二进制；Release B 之后只允许回滚到 Release A 兼容二进制，不得声称旧二进制能解析 nullable legacy JSON。

### 5.2 既有 local-sync 兼容适配器

兼容策略唯一固定为“规范化 Page rows + legacy 非 Page sidecar 合成旧 DTO”。为保留安全回滚窗口，迁移分为两次应用发布：Release A 完成 expand/backfill，并在新写入器中临时双写规范化 rows 与旧 `snapshot/delta` JSON，因此可回滚到旧应用；完成数据校验、旧 local-sync 回归和一个明确观察窗口后，Release B 才执行 contract、停止 legacy JSON 双写并允许其为 null。Release B 不承诺回滚到不理解 nullable legacy JSON 的旧二进制；必须保留 Release A 兼容二进制作为回滚目标。Release B 之后不允许新写入器继续双写包含全部页面正文的巨大 `snapshot/delta` JSON：

1. 迁移旧 revision 时，从原 `snapshot/delta` 提取 memories、relations、provenance、deletions、schemaVersion、recipeVersion 等非 Page 字段到按 revision 保存的 `LegacyRevisionSidecar`；sidecar 中每个数组保持原始 ordinal。每个原 `pages[]` 元素的完整 legacy 投影由 `(revisionId, pageId)` 对应的 `LegacyRevisionPageExtra` 与其引用的正文 blob 共同表示：extra 保存原始 ordinal、字段存在性、字段顺序、`legacyBodyHash`、原 contentHash/path/updatedAt 以及 `order`、`metadata`、`artifactIds` 等全部非正文字段；不得假设规范化 row 的共有字段足以重建原 DTO。存储实现不得在每个 revision 重复内联整篇正文：未规范化正文按原始 UTF-8 bytes 放入内容寻址的 `LegacyPageBodyRow`；若原 bytes 已等于规范化正文，可与 `SyncPageContentRow` 共享同一 blob 或等价去重存储。Pages 的 sync v1 字段和规范化正文另行回填到规范化 rows。旧 JSON 在验证完成前保留，之后可按独立迁移清理。
2. 每个新统一 `SpaceKnowledgeRevision` 都继承父 revision 的规范化 Page rows 和 sidecar。Page 变化更新 page rows 和 page delta；Memory/Relation-only 变化只更新 sidecar 和 legacy delta，但仍可按现有 local-sync 语义推进同一 sequence/head。`/api/sync/v1` 遇到没有 Page 净变化的 revision 时仍返回新的 revision ID、相同 `revisionContentHash` 和空 Page Delta，使插件安全推进 base；不维护第二套相互漂移的 revision 序列。
3. 既有 local-sync Snapshot 路由优先按 legacy page ordinal 流式输出 `LegacyRevisionPageExtra` 与其正文 blob 合成的完整旧 Page 投影，再按 sidecar ordinal 合并其他数组；规范化 Page rows 只作为 sync v1 权威内容，不覆盖历史 legacy 字段。新 revision 在统一写入事务中同时生成完整、确定的 legacy Page 投影与 ordinal。迁移前后的字段存在性、数组顺序、默认值和状态码必须保持不变。
4. 既有 local-sync Delta 路由的每个 `revisions[i].delta` 必须继续是**目标 revision 的完整 KnowledgeBundle 起点**，不能只包含净变化。当前发布版客户端把第一条 delta 直接作为 accumulated bundle，只有后续条目才在其上合并；返回净增量会使未出现页面从本地工作区消失。适配器必须为每个目标 revision 读取其完整规范化 Page rows/page extras 和完整 Memory/Relation sidecar，同时保留从父 revision 到该 revision 的 legacy `deletions/provenance` 转换信息，使连续多条 revision 合并与当前实现完全一致。若未来要改成真正净 Delta，必须先发布能把第一条增量应用到本地 base 的新版 local-sync 协议，不得在本兼容层静默改变语义。
5. 现有 legacy revision controller 的外层响应保持 `revisionId/sequence/contentHash/schemaVersion/recipeVersion/bundle` 和 `fromRevision/toRevision/revisions[]` 不变；其中每个 `bundle/delta` 继续是现有 KnowledgeBundle 结构。不得误用 packages/local-sync 中另一个 `SnapshotSchema/DeltaSchema` 作为这些路由的替代 DTO。
6. 旧路由的单响应 JSON 和原有数量限制属于 legacy 兼容边界，不承诺 sync v1 的 100 MiB 有界响应；但服务端内部不得先解析已经清理的完整 legacy snapshot JSON。新插件只调用 `/api/sync/v1`。
7. 新 revision 以固定 legacy serializer 流式计算现有 `contentHash`，不构造完整 bundle 字符串；serializer 必须与迁移前 `JSON.stringify(snapshot)` 的字段插入顺序、数组顺序和省略规则兼容。历史 revision 保留已存储的 legacy `contentHash`，不得用规范化正文重算并覆盖；迁移验证以原 DTO 深度等价且返回原 contentHash 为通过条件。旧 `snapshot`/`delta` 字段在 schema 中改为 nullable，新写入器写 null，兼容路由不能依赖它们。
8. Release A 上线后、Release B 把旧 JSON 置 null 前，必须以当前生产 `@neomei/agentwiki-local-sync` 公网版本运行 Snapshot、Delta、Pull 和 Push 回归，逐字段比较迁移前后 DTO并比较 legacy contentHash；不一致则禁止 Release B。旧 JSON 实体清理是 Release B 之后的独立运维批次，只能在规范化 rows/sidecar/blob 验证通过且兼容路由不再读取旧 JSON 后执行。

统一写入器的 Page 修改方法必须返回 `{ page, revision, sequence, revisionContentHash }`，使 Web/API 调用者能观测该次写入对应的 revision。

## 6. 人类设备凭据模型

新增 `HumanDeviceCredential`，至少包含：

```ts
interface HumanDeviceCredentialRecord {
  id: string;
  credentialFamilyId: string;
  userId: string;
  deviceId: string;
  vaultId: string;
  deviceName: string;
  credentialHash: string;
  status: "provisional" | "active" | "revoked" | "expired";
  provisionalExpiresAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
```

约束：

- 设备凭据由插件在 exchange 前用 Web Crypto 生成，是 32 个密码学安全随机字节的 base64url 字符串；先存入 Secret Storage，再只在 exchange 请求的敏感 body 中发送。exchange 响应不返回明文凭据。数据库保存 `HMAC-SHA-256(serverPepper, "human-device-credential\0" + credential)`，serverPepper 只来自服务端秘密配置；`credentialHash` 建立全局唯一约束，Bearer 认证只允许按该列 `findUnique` 得到一个 principal，服务端日志不记录明文或摘要。极低概率 hash/credential 碰撞使整个 exchange 事务回滚并返回通用 `CREDENTIAL_COLLISION / 409`，不消费 code、不泄漏既有主体；插件丢弃该 pending credential、生成新的随机 credential，并用同一个仍有效 code 发起全新的 exchangeId/request。
- exchange 创建的凭据初始为 `provisional`，最长 10 分钟，仅允许调用 `GET session`、`POST credentials/current/activate` 和 `DELETE credentials/current`；不能列 Space、读 Snapshot/Delta 或创建 Push session。成功 activate 后变为长期 `active`；过期 provisional 在认证时原子标记 `expired` 并返回 `DEVICE_CREDENTIAL_EXPIRED`，定时清理只用于回收从未再次访问的过期记录。
- 只有 `active` 凭据长期有效，直到用户或当前设备撤销。
- 同一 `userId + deviceId + vaultId` 重新连接时允许保留原 active 凭据并新建一个 provisional 凭据。exchange 必须锁定 credential family，先把该 family 所有仍标为 provisional 的记录按数据库当前时间推进为 `expired`（已到期）或 `revoked`（未到期且被新尝试替换），再创建唯一新 provisional；数据库分别建立“每个 family 最多一个 provisional credential”和“每个 family 最多一个 active credential”的部分唯一约束。PostgreSQL 部分索引只看 status，不在 predicate 使用 `now()`。认证、activate、exchange 和清理 worker 都先锁 family、再按 credential ID 锁行并执行相同过期推进，避免死锁或过期行阻塞重连。这样旧 active 在新连接完成前仍可使用，但较早的 provisional 不能在稍后反向覆盖较新的连接尝试。
- `credentialFamilyId` 是首次为 `userId + deviceId + vaultId` 连接时生成的 UUID；同一组合重新连接沿用该 family，不同用户、deviceId 或 vaultId 永不共享 family。Push session 同时记录创建 credential ID 和 family ID。
- credential family 使用独立持久化记录或等价唯一键，对 `(userId, deviceId, vaultId)` 唯一；并发 exchange 通过 upsert/唯一冲突重读并锁定同一 family，不能产生两个 family 或两个可激活的 provisional credential。
- 凭据认证得到人类 principal：包含 `userId` 和 `credentialId`，不包含 `agentId`。
- 认证时重新加载未删除、有效用户；不得相信签发时缓存的用户状态。
- 授权时重新加载 Space membership、角色和 platform role。
- 凭据只被 Obsidian integration 与 sync v1 路由接受，不能调用一般用户管理、成员管理、Agent 管理、凭据管理或 Review 决策 API。

## 7. 一次性连接码

### 7.1 创建连接码

`POST /api/integrations/obsidian/installations`

- 认证：当前 AgentWiki Web 的人类 JWT。
- Guard：Human only。
- 请求与响应：

```ts
interface CreateObsidianInstallationRequest {
  pluginId: "agentwiki-sync";
  requestedProtocolVersion: "1";
}

interface CreateObsidianInstallationResponse {
  protocolVersion: "1";
  installationId: string;
  code: string;
  expiresAt: string;
}
```

规则：

- code 至少包含 20 个密码学安全随机字节并以适合人工复制的 base64url 字符串表示，明文只显示一次；数据库只保存 `HMAC-SHA-256(serverPepper, "obsidian-installation-code\0" + code)`，与 credential HMAC 做域分离。`installationCodeHash` 建立全局唯一约束，exchange 只按该列 `findUnique`；创建 installation 若发生极低概率碰撞，在同一请求内重新生成 code 后再插入，不返回碰撞细节。
- code 最长有效 10 分钟。
- 首次成功后 code 对任何新 exchange 立即失效；只允许第 7.2 节绑定同一 exchangeId/requestHash/credential 的短期恢复重试。
- 撤销 installation 后立即失效。
- 创建行为记录 user ID、时间和安全审计事件，但不记录明文 code。

`DELETE /api/integrations/obsidian/installations/:installationId` 由创建该 installation 的当前 Web 人类用户调用。未交换状态成功返回 `204` 并使 code 失效；已交换返回 `INSTALLATION_ALREADY_EXCHANGED / 409`，用户应改为撤销对应设备凭据。

### 7.2 交换设备凭据

`POST /api/integrations/obsidian/exchange`

- 认证：无；以一次性 code 授权。
- 请求与响应：

```ts
interface ExchangeObsidianCredentialRequest {
  code: string;
  exchangeId: string;
  credential: string;
  deviceId: string;
  deviceName: string;
  vaultId: string;
  pluginVersion: string;
  supportedProtocolVersions: [string, ...string[]];
}

interface ExchangeObsidianCredentialResponse {
  protocolVersion: "1";
  serverInstanceId: string;
  credentialId: string;
  credentialStatus: "provisional";
  provisionalExpiresAt: string;
  user: { id: string; displayName: string };
  capabilities: SyncCapabilities;
}
```

规则：

- 交换端点按 IP、installation ID 和失败次数限流。
- code 为 27–256 个 base64url 无填充字符，credential 固定为 32 bytes 对应的 43 个 base64url 无填充字符；supportedProtocolVersions 为 1–8 个不重复的十进制 major 字符串，至少包含 `"1"` 才能协商本契约。
- 插件在首次发送前生成并持久化 `exchangeId`、credential Secret ID 和除 code 外的完整请求字段；网络结果不确定时只允许从 Secret Storage 取回同一 credential，以完全相同的请求重试。code 检查、请求绑定和消费必须原子执行。
- 对存储在 PostgreSQL 的 installation，exchange 在单个事务中以条件更新把 `pending` 改为 `exchanged`、绑定 `exchangeId + requestHash`、取得并锁定 credential family、按上述时间规则收敛该 family 的全部旧 provisional、以请求 credential 的 HMAC 创建全局唯一的新 provisional credential、保存非敏感响应字段并写安全审计；任一步失败整体回滚，不消费 code。Redis 可用于限流，不作为这些动作之间的唯一事务边界。
- `requestHash` 对“移除 code，并把 credential 替换为原 credential bytes 的 SHA-256”的完整 `ExchangeObsidianCredentialRequest` canonical bytes 求 SHA-256，客户端与服务端可独立得到同一值。installation 首次成功后，在 installation 原到期时间与 provisional 到期时间两者较早者之前，携带同一 code、exchangeId、requestHash 和 credential 的重试必须返回语义等价的 `201 + ExchangeObsidianCredentialResponse`；不同 exchangeId、requestHash 或 credential 返回 `INSTALLATION_ALREADY_EXCHANGED / 409`。服务端不需要保存可解密 credential；这解决提交后响应丢失，同时不把交换变成可修改参数的重复授权。
- 完全相同的恢复重试超过上述窗口后返回 `INSTALLATION_ALREADY_EXCHANGED / 409`；插件覆写 pending code/credential secret并要求生成新 code。若首次 exchange 从未提交而 code 自然过期，则返回 `INSTALLATION_CODE_EXPIRED / 401`。两者都不可继续旧连接尝试。
- 没有共同协议版本时返回 `PROTOCOL_UNSUPPORTED`，不得消费 code。
- 成功后创建绑定 code 所属 user 的 HumanDeviceCredential。
- 首次成功和完全相同的恢复重试都返回同一 provisional credential 的非敏感元数据；此时不撤销该 user/device/vault 的现有 active credential，避免新设备连接流程中断时破坏旧连接。旧 active credential 只在 activate 新凭据的事务中被撤销。
- exchange 请求/响应与服务端日志必须设置禁止缓存，并对请求中的 code/credential 默认删除或脱敏；响应本身不含 credential。
- `serverInstanceId` 来自数据库单行 `ServerInstanceIdentity(instanceId, deploymentSeedHash)`；部署必须另行注入不随数据库备份复制的 32-byte `AGENTWIKI_DEPLOYMENT_SEED`，数据库只保存其域分离 HMAC。进程启动时 seed hash 与数据库不一致必须拒绝对外服务，不能自动采用克隆值。首次空数据库可原子初始化；数据库克隆到独立部署后，运维必须用显式 `agentwiki instance rotate --confirm-new-deployment` 命令在维护模式下以新 seed 同时轮换 instanceId/hash并写审计，再开放流量。CI/部署门禁要求非空唯一 seed，备份恢复演练验证：同部署恢复使用原 seed 保持 instanceId，克隆部署在 rotate 前启动失败、rotate 后得到新 instanceId。

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
  credentialStatus: "provisional" | "active";
  provisionalExpiresAt: string | null;
  user: { id: string; displayName: string };
  capabilities: SyncCapabilities;
}

interface SyncCapabilities {
  maxPageBytes: number;
  maxBatchBytes: number;
  maxBatchItems: number;
  maxChangeCount: number;
  maxConfirmationBytes: number;
  maxClientSpacePages: number;
  maxClientManifestBytes: number;
  maxClientTotalBodyBytes: number;
  maxResponseBytes: number;
  maxPageItems: number;
  pushSessionTtlSeconds: number;
}
```

capability 的 v1 数值边界固定为：`maxPageBytes = 1,048,576`；`maxBatchItems` 为 `1..100`；`maxBatchBytes/maxResponseBytes/maxConfirmationBytes` 为 `1,048,576..4,194,304`，且 maxBatchBytes/maxResponseBytes 必须能容纳一个 maxPageBytes 项及 envelope 开销；`maxPageItems` 为 `1..200`；`maxChangeCount = 5,000`；`maxClientSpacePages = 5,000`；`maxClientManifestBytes = 4,194,304`；`maxClientTotalBodyBytes = 104,857,600`；`pushSessionTtlSeconds` 为 `900..86,400`。exchange/session 响应超出这些 hard bounds 属于协议错误，插件不能盲信或扩大本地资源预算。

### 8.2 激活当前设备凭据

`POST /api/integrations/obsidian/credentials/current/activate`

- 认证：当前 provisional 或已 active HumanDeviceCredential。
```ts
interface ActivateCurrentObsidianCredentialRequest {
  credentialId: string;
}
```

请求 credentialId 必须与 Authorization 对应的 credential ID 一致；成功响应为 `HumanDeviceSessionResponse`。
- provisional 且未过期时，在一个事务中锁定 credential family，确认当前凭据仍是该 family 唯一 provisional，撤销其他 active credential，把当前凭据改为 active、清空 provisionalExpiresAt、写 activatedAt 和审计事件。被后续 exchange 替换的 provisional 必须返回 `DEVICE_CREDENTIAL_REVOKED`，不能重新激活。
- 当前凭据已 active 时幂等返回 `200 + HumanDeviceSessionResponse`；已过期或已撤销返回 401。
- 并发 exchange/activate 通过 family 行锁以及 provisional/active 两个部分唯一约束收敛；不得留下两个 active credential，也不得让较早的 provisional 在较新 exchange 完成后重新激活。

### 8.3 撤销当前设备

`DELETE /api/integrations/obsidian/credentials/current`

只撤销当前 HumanDeviceCredential。成功返回 `204`。撤销成功后当前请求之外的后续请求必须失败；重复撤销以 `DEVICE_CREDENTIAL_REVOKED` 返回 `401`。

### 8.4 用户端设备管理

AgentWiki Web 必须允许当前用户查看和撤销自己的 Obsidian 设备：

- `GET /api/integrations/obsidian/credentials` 返回 `HumanDeviceCredentialListResponse`。
- `DELETE /api/integrations/obsidian/credentials/:credentialId` 只能撤销当前 user 自己的凭据，成功返回 `204`。

```ts
interface HumanDeviceCredentialSummary {
  credentialId: string;
  deviceId: string;
  vaultId: string;
  deviceName: string;
  status: "provisional" | "active" | "revoked" | "expired";
  provisionalExpiresAt: string | null;
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
  pageCount: DecimalCount;
  revisionManifestByteLength: DecimalByteCount;
  revisionBodyBytes: DecimalByteCount;
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

正式响应类型：

```ts
interface RevisionHeadResponse {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  pageCount: DecimalCount;
  revisionManifestByteLength: DecimalByteCount;
  revisionBodyBytes: DecimalByteCount;
  publishedAt: string | null;
}
```

该端点只返回 head，不返回页面正文，用于 Status 和 Push 前置检查。初始 revision `0` 的 `publishedAt` 为 `null`。

## 11. 分页 Snapshot

`GET /api/sync/v1/spaces/:spaceId/snapshot?revision=<id>&cursor=<opaque>&limit=<n>`

```ts
interface SnapshotQuery {
  revision: string;
  cursor?: string;
  limit?: number;
}
```

规则：

- 第一次请求可以使用 `revision=current`；响应必须解析为一个固定 revision。
- 后续 cursor 永远绑定同一固定 revision。
- 页面按 page ID 稳定排序。
- cursor 不透明，客户端不得解析。
- cursor 是 base64url 编码、服务端 HMAC 签名的 payload，绑定 route kind、Space、固定 revision、最后 pageId/ordinal 和 24 小时到期时间；签名错误、跨路由/Space 使用或过期返回 `CURSOR_INVALID`。
- 后续有新发布时，本次分页结果仍保持固定 revision。
- revision 存在但其规范化 Page rows 已超过保留期时返回 `REVISION_GONE`。根本不存在、属于另一 Space 或调用者不可读的 revision 统一返回 `REVISION_GONE / 410`，不通过 404/403 泄漏跨 Space revision 存在性。
- 每个 Space 的 head revision 及其 rows 永不被 revision retention 清理，且无论年龄都可签发 24 小时 cursor。每个 revision 持久化可空 `supersededAt`：发布新 head 的同一 Space/head 锁事务把旧 head 的 supersededAt 设为数据库当前时间且此后不可修改。普通非 head revision 的对外可查询窗口至少到 publishedAt 后 30 天；物理删除时间不得早于 `max(publishedAt + 31 天, supersededAt + 25 小时)`，额外 1 小时是 cursor/worker 时钟与调度安全余量。cleanup 先在事务中锁定 Space/head，确认目标仍非 head、supersededAt 非空且已越过该 max deadline，再删除 revision rows。这样存在多年的 head 在刚被替换前签发的 cursor 也至少有完整 24 小时可用；deadline 前的既有 cursor 可继续完成固定 revision，过了对外窗口且没有有效 cursor的新请求稳定返回 `REVISION_GONE`。内容 blob 只在 revision/staging/Page 等全部引用删除后另行 GC。插件离线超过对外保留期后 Delta 得到 410，按既定 Snapshot 三方合并分支恢复。
- `limit` 必须在 `1..capabilities.maxPageItems`；默认取二者较小的 100。
- 服务端在加入下一项会使完整 JSON 响应超过 `maxResponseBytes` 时提前结束本页并返回 cursor。单个合法页面必须始终可以单独返回，因此 `maxResponseBytes` 必须大于 `maxPageBytes` 加协议开销。
- 每一页都重复相同 revision、sequence、revisionContentHash、pageCount、revisionManifestByteLength 和 revisionBodyBytes；客户端发现任一变化必须废弃全部分页结果。

响应：

```ts
interface SnapshotPage {
  protocolVersion: "1";
  spaceId: string;
  revision: string;
  sequence: number;
  revisionContentHash: string;
  pageCount: DecimalCount;
  revisionManifestByteLength: DecimalByteCount;
  revisionBodyBytes: DecimalByteCount;
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

```ts
interface DeltaQuery {
  from: string;
  cursor?: string;
  limit?: number;
}
```

响应固定 `fromRevision` 和 `toRevision`：

```ts
interface DeltaPage {
  protocolVersion: "1";
  spaceId: string;
  fromRevision: string;
  toRevision: string;
  toSequence: number;
  toRevisionContentHash: string;
  toPageCount: DecimalCount;
  toRevisionManifestByteLength: DecimalByteCount;
  toRevisionBodyBytes: DecimalByteCount;
  items: DeltaItem[];
  nextCursor: string | null;
}

type DeltaItem =
  | { operation: "upsert"; page: SyncPage }
  | { operation: "archive"; pageId: string; previousPath: string };
```

移动和重命名使用同一 page ID 的 `upsert` 表达。若 `from` 已不可用，返回 `REVISION_GONE`，客户端改取 Snapshot 并使用本地 base 做三方合并。若 `fromRevision` 等于第一次请求时的 head，响应固定 `toRevision = fromRevision`、`items = []`、`nextCursor = null`，并返回该 revision 的 sequence/hash。

Delta 使用与 Snapshot 相同的条数、字节、cursor 和固定 revision 规则；每一页重复相同的 from/to revision、toSequence、toRevisionContentHash、toPageCount 和两个 toRevision byte 指标，任一变化都使客户端废弃全部分页结果。合并后的最终项统一按 page ID Unicode code point 升序分页，archive 与 upsert 使用同一排序空间；同一 `toRevision` 中一个 page ID 只出现一次最终操作。cursor 必须绑定 `fromRevision + toRevision + lastPageId`，不能仅绑定某个中间 revision ordinal。

当 `fromRevision` 不是 head 时，服务端把 `(fromSequence, toSequence]` 中所有 revision delta 合并为每个 page ID 的最终净变化：

- 在 from Snapshot 不存在、to Snapshot 存在：返回一次最终 `upsert`。
- 两边都存在且 path/title/contentHash 任一不同：返回一次最终 `upsert`。
- from 存在、to 不存在：返回一次 `archive`，`previousPath` 取 from Snapshot 的 path。
- 两边都不存在或最终完全相同：不返回项目。

实现使用 revision rows 的有序 SQL/流式归并，不把完整 from/to Snapshot 加载到 Node 内存。`toRevision` 在第一次请求时锁定为当时 head，后续 cursor 不随新发布变化。

当 `(fromSequence, toSequence]` 只有 Relation/Memory-only revision 时，`items` 为空，但 `toRevision/toSequence` 仍前进且 `toRevisionContentHash` 与 from 相同。这与“from 已是 head”不同，客户端必须仍能推进本地 base revision。

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
  capabilitiesHash: string;
  confirmationHash: string;
  confirmationByteLength: number;
  changeCount: number;
  totalBodyBytes: number;
}
```

服务端处理 create 时先认证 HumanDeviceCredential 并重载当前用户，再以 `(credentialFamilyId, idempotencyKey)` 查询既有 session：存在则校验它属于同一 user/device/vault/Space、全部绑定字段相同且该用户仍可读该 Space，然后直接返回当前状态/result；恢复路径不再要求原 base 等于当前 head，也不要求当前仍有发布权。不存在时才检查 Space 读取/发布能力、要求 request `capabilitiesHash` 等于服务端当前完整 capability hash，并要求 base revision 等于当前 head；capability 已变化返回 `CAPABILITIES_CHANGED`，不创建 session，不接受客户端确认后静默换限制。“查询既有或创建”必须依赖 `(credentialFamilyId, idempotencyKey)` 唯一约束并在唯一冲突后重读既有记录，两个并发 create 不能创建两个 session。finalize 时必须在发布事务内再次检查。创建与 finalize 之间 head 改变时返回 `BASE_STALE`。

```ts
interface CreatePushSessionResponse {
  protocolVersion: "1";
  sessionId: string;
  status: PushSessionStatus;
  expiresAt: string;
  capabilities: SyncCapabilities;
  result: FinalizePushResponse | null;
}

type PushSessionStatus = "uploading" | "ready_to_finalize" | "published" | "aborted" | "expired";
```

TypeScript 中 `FinalizePushResponse` 与 `PushSessionStatus` 可以按声明提升互相引用；运行时 Schema 必须使用惰性引用或先定义 finalize result Schema，不能产生模块初始化循环。

相同 idempotency key 的创建重试只有在 user、credential family、Space、base revision、capabilities hash、confirmation hash、confirmationByteLength、changeCount 和 totalBodyBytes 全部相同时才返回同一 session 的当前状态和已持久化 result，状态码仍为 `201`；任一项不同返回 `IDEMPOTENCY_MISMATCH`。因此 finalize 已成功但本地 session ID 未持久化时，同一 credential 或同 family 的轮换 credential 重试 create 也能恢复同一结果。轮换凭据只能通过 exact create replay/GET 恢复既有 session，不能上传、finalize 或终止它；旧 session 未发布时客户端必须以新确认和新 idempotency key 开始另一 session，旧 staging 按 TTL 清理。

`changeCount` 是 `0..capabilities.maxChangeCount` 的安全整数；v1 服务端 hard maximum 与默认值均为 5,000。`confirmationByteLength` 是正安全整数且不得超过 `maxConfirmationBytes`，v1 hard maximum 与默认值均为 4 MiB；finalize 重建 manifest 后必须同时与声明 byte length/hash 完全相等。`totalBodyBytes` 是非负安全整数且受租户配额限制。`changeCount = 0` 时 `totalBodyBytes` 必须为 0，session 创建后立即为 `ready_to_finalize`，不上传批次；非零时初始为 `uploading`。

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
- 批次不能为空；batch index 必须从 0 开始连续。`changeCount > 0` 时 finalize 要求 `0..maxReceivedIndex` 每个 index 恰好存在一次，且全部 changes 数量等于 changeCount；`changeCount = 0` 时批次集合必须为空，完整性条件为空真。
- 同一 page ID 不得跨批次重复；finalize 发现重复返回 `PAYLOAD_INVALID`。
- upsert 的 page ID 如已存在于同一 Space 的未归档 Page，表示更新；如已存在于同一 Space 的归档 Page，表示恢复同一 Page，必须清除 `deletedAt`、校验路径唯一并写恢复前 PageVersion；如不存在，表示创建。若该 page ID 存在于另一 Space，返回 `PAGE_ID_CONFLICT`，不转移原页。
- 数据库必须对 `(sessionId, pageId)` 建立唯一约束。每次 PUT batch 都必须与 DELETE/finalize 使用同一 Push session `SELECT ... FOR UPDATE` 行锁；锁内重新检查 credential、状态、expiry 和既有 batch receipt，再在一个事务内写入该批全部 staging rows、receipt、`receivedBatchCount`、累计 change 数/正文 bytes 以及 `ready_to_finalize` 转换。不同 batch 不得发生累计值 lost update，session 进入 aborted/published/expired 后不得再提交 staging。
- 任一批次使 session 累计 change 数或 totalBodyBytes 超过创建声明时立即返回 `PAYLOAD_INVALID`，整批不保存。上传结束只有“累计值等于声明值”才能把 session 置为 `ready_to_finalize`；小于声明值保持 `uploading`。
- receipt 是 `base64url(HMAC-SHA-256(serverPepper, sessionId + "\n" + batchIndex + "\n" + batchHash))`；客户端只需原样持久化，不用于授权。

### 13.3 原子 finalize

`POST /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId/finalize`

请求：

```ts
interface FinalizePushRequest {
  confirmationHash: string;
  userConfirmed: true;
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
8. 从 locked base revision 的持久化 bigint 指标加 staged upsert/archive 的精确 count/byte delta，计算发布后的 pageCount/revisionBodyBytes；流式构造结果 manifest 同时得到 revisionManifestByteLength。三项不得超过 session capability；任一超限返回 `SPACE_TOO_LARGE`，不发布。计算、比较和持久化均不得经由浮点 number。
9. 记录人类用户、设备 credential、来源 `obsidian_sync` 和确认 hash。
10. 发布所有页面更新和归档，并推进一个新 revision。

finalize 对同一 session 使用第 13.2 节 PUT 和第 13.6 节 DELETE 共享的数据库行锁，并在同一发布事务内完成所有动作。第一个请求持锁验证 `ready_to_finalize`，写 Page/ChangeSet/revision、`publishedChangeSetId` 和完整 result，然后直接把 session 提交为 `published`。并发 finalize 必须等待该行锁：锁释放后如已 `published` 则返回已持久化的同一 result，不启动第二次发布。事务回滚时 session 仍是 `ready_to_finalize`。服务端不持久 `finalizing` 中间状态；该词只用于客户端本地 journal 表示“finalize 请求已发出但结果未知”。

如果 changeCount 为 0，客户端不应创建 session；服务端仍必须接受协议调用并在 finalize 返回 `noop` 和当前 revision，不创建 ChangeSet 或新 revision。如果所有 upsert 与当前 page 完全相同且没有 archive，finalize 同样返回 `noop`，不创建 ChangeSet 或新 revision。两种 noop 都必须在持有统一 session 行锁、确认 base 仍等于当前 head 的同一数据库事务中，把当时 head 的完整 `FinalizePushResponse`（含 hash、三个指标、publishedAt、`changeSetId: null`）持久化为 result 并把 session 置为 `published`；响应丢失、并发 head 随后前进或服务重启后，finalize/exact create replay/GET session 一律返回该已存结果，不重新按新 head 计算 noop。

`publishedAt` 对 `published` 是本次 revision 的提交时间；对 `noop` 是当前 head 的发布时间，初始 revision `0` 时为 `null`。

成功响应：

```ts
interface FinalizePushResponse {
  protocolVersion: "1";
  status: "published" | "noop";
  revision: string;
  sequence: number;
  publishedAt: string | null;
  revisionContentHash: string;
  pageCount: DecimalCount;
  revisionManifestByteLength: DecimalByteCount;
  revisionBodyBytes: DecimalByteCount;
  changeSetId: string | null;
}
```

同一 idempotency key 和同一 payload 返回第一次持久化的**完全相同响应**，包括原 status，不使用额外的 `existing` 状态；同一 key 和不同 payload 返回 `IDEMPOTENCY_MISMATCH`。

### 13.4 查询 session 与最终结果

`GET /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

当前有效凭据可以在以下任一条件下查询 session：它是创建凭据；或它与创建凭据属于同一 credential family 且仍对应同一有效 user、deviceId 和 vaultId。后者只用于凭据轮换后恢复结果，不能上传批次、终止或 finalize 旧 session。响应返回：

```ts
interface PushSessionStatusResponse {
  protocolVersion: "1";
  sessionId: string;
  status: PushSessionStatus;
  receivedBatchIndexes: number[];
  expiresAt: string;
  result: FinalizePushResponse | null;
}
```

finalize 已提交但客户端未收到响应时，该端点必须返回持久化的最终结果。查询不得延长 session 到期时间，不得泄漏正文或其他 credential family 的 session。`published`、`aborted`、`expired` session 的不含正文状态至少保留 30 天；staging 正文可在发布、终止或到期后立即删除，但删除事务必须遵守第 13.6 节的统一 session 行锁。在保留期内查询过期 session 固定返回 `200 + status: "expired"`；超过保留期才返回 `PUSH_SESSION_NOT_FOUND / 404`。`PUSH_SESSION_EXPIRED / 410` 只用于对已过期 session 执行上传、finalize 或 DELETE 等变更请求。

### 13.5 审计而非二次审核

人类设备 finalize 已包含 Obsidian 内的明确确认。服务端必须按第 5 节创建同步来源、直接 published 的 ChangeSet 和 ChangeItem，不得返回 `pending_review`。AgentCredential 的现有提交仍必须进入待审核 ChangeSet，不能使用本接口。

### 13.6 终止 session

`DELETE /api/sync/v1/spaces/:spaceId/push-sessions/:sessionId`

允许创建该 session 的当前 credential 在未过期且 finalize 提交前删除 staging，并在事务中把 session 置为 `aborted`，成功返回 `204`。DELETE、PUT、finalize，以及所有“标记 expired/删除 staging”的请求路径和后台 cleanup worker 必须先取得同一 session `SELECT ... FOR UPDATE` 行锁，并在锁内按数据库当前时间重查状态与 expiry。这样不会在发布中途删 staging，也不会在 session 已进入确定状态后反向改状态；`published/aborted` 只允许清理 staging 正文，不能改变已持久化状态或 result。credential family 中的轮换凭据没有终止权限。`published` 状态返回 `PUSH_SESSION_STATE_INVALID`；已过期返回 `PUSH_SESSION_EXPIRED / 410`。到期 session 由服务端按上述锁规则清理，且清理不得影响已发布 revision。

## 14. 容量和分页要求

- AgentWiki 产品不设置 Space 总页数、正文总量或 manifest 字节硬上限；但 Obsidian 插件 v1 的移动端有界实现只绑定 pageCount、revisionBodyBytes 和 revisionManifestByteLength 分别不超过三个 client capability 的 Space。Space list/head/Snapshot/Delta/finalize 返回对应固定 revision 指标；任一超限时插件只显示不兼容诊断，不继续下载正文、写 Vault 或建立映射。
- 服务端可以执行租户配额，但必须通过结构化 `QUOTA_EXCEEDED` 返回当前限制。
- 单页最大正文为 1 MiB。
- 单批次和单响应限制由 exchange/session capability 返回；服务端 v1 默认均为 4 MiB，客户端不得固化更大的值。
- 单次 Push 最多 5,000 changes，confirmation canonical bytes 最多 4 MiB；两项都通过 capability 返回且服务端 v1 不得配置得更大。超过 change/confirmation 限制返回 `BATCH_TOO_LARGE`；结果 pageCount 超限返回 `SPACE_TOO_LARGE`。插件阻塞该 Space 的整库 Push 并提示缩小映射；首版不以自动拆分或部分 Push 改变用户确认边界。
- 首版端到端验收基线：单 Space 5,000 页、规范化正文总计 100 MiB。
- Snapshot、Delta 和上传必须以有界批次处理；服务端和客户端都不得要求把完整 100 MiB payload 同时保存在一个 JSON 对象中。

### 14.1 路由 Schema 清单

所有 `:spaceId/:sessionId/:credentialId/:installationId/:batchIndex` path 参数和 Snapshot/Delta query 均由协议包导出具名严格 Schema；ID 复用第 3.3 节，batchIndex 是非负安全整数。无 body 的 GET/DELETE 不定义空对象 Schema，204 使用 HTTP `NoContent` 语义。path 类型固定如下；v1 必须导出这些类型及同名 `Schema`：

```ts
interface SpaceParams { spaceId: string }
interface PushSessionParams { spaceId: string; sessionId: string }
interface PushBatchParams { spaceId: string; sessionId: string; batchIndex: string }
interface CredentialParams { credentialId: string }
interface InstallationParams { installationId: string }
```

逐路由 body/query/success 类型如下：

| 路由 | Body / Query | 成功响应 |
|---|---|---|
| POST installations | `CreateObsidianInstallationRequest` | `CreateObsidianInstallationResponse` |
| POST exchange | `ExchangeObsidianCredentialRequest` | `ExchangeObsidianCredentialResponse` |
| GET session | 无 | `HumanDeviceSessionResponse` |
| POST activate | `ActivateCurrentObsidianCredentialRequest` | `HumanDeviceSessionResponse` |
| GET credentials | 无 | `HumanDeviceCredentialListResponse` |
| GET spaces | 无 | `SyncSpaceListResponse` |
| GET head | path params | `RevisionHeadResponse` |
| GET snapshot | `SnapshotQuery` | `SnapshotPage` |
| GET delta | `DeltaQuery` | `DeltaPage` |
| POST push-sessions | `CreatePushSessionRequest` | `CreatePushSessionResponse` |
| PUT batch | path params + `PushBatch` | `PushBatchReceipt` |
| POST finalize | `FinalizePushRequest` | `FinalizePushResponse` |
| GET push session | path params | `PushSessionStatusResponse` |
| DELETE installation/current credential/web credential/push session | path params 或无 | `NoContent` |

表中 `SnapshotQuery/DeltaQuery` 是 query Schema，不参与 JSON body；path param Schema 可组合为 `SpaceParams`、`PushSessionParams`、`CredentialParams`、`InstallationParams` 和 `PushBatchParams` 导出。实现不得以 controller 内临时 DTO 替代公开 Schema。

HTTP 原始 query/path 中 `limit` 与 `batchIndex` 是 ASCII 十进制字符串。path/query Schema 必须拒绝符号、小数、指数、空白、前导 `+`、多余前导零和超范围值；`PushBatchParams.batchIndex` 保持 canonical 十进制字符串，再由公开 `parseBatchIndex()` 转为内部安全整数并与 body `PushBatch.batchIndex` 严格相等。`SnapshotQuery/DeltaQuery.limit` 同理由公开 `parsePageLimit()` 转换；不能依赖 Nest 隐式 coercion。其他 ID/path 参数保持原字符串并严格校验。

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
- `DEVICE_CREDENTIAL_EXPIRED`
- `USER_INACTIVE`
- `SPACE_FORBIDDEN`
- `SPACE_READ_ONLY`
- `INSTALLATION_NOT_FOUND`
- `INSTALLATION_REVOKED`
- `INSTALLATION_ALREADY_EXCHANGED`
- `INSTALLATION_CODE_INVALID`
- `INSTALLATION_CODE_EXPIRED`
- `CREDENTIAL_COLLISION`
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
- `SPACE_TOO_LARGE`
- `BATCH_MISMATCH`
- `PUSH_SESSION_EXPIRED`
- `PUSH_SESSION_NOT_FOUND`
- `PUSH_SESSION_STATE_INVALID`
- `PUSH_SESSION_INCOMPLETE`
- `IDEMPOTENCY_MISMATCH`
- `CAPABILITIES_CHANGED`
- `QUOTA_EXCEEDED`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

错误 details 不得包含凭据、安装码、Authorization header 或 Markdown 正文。

错误到 HTTP 与重试语义固定如下；未列出的验证错误归入 `PAYLOAD_INVALID / 400 / false`：

| Error code | HTTP | retryable |
|---|---:|---|
| `AUTHENTICATION_REQUIRED`, `DEVICE_CREDENTIAL_REVOKED`, `DEVICE_CREDENTIAL_EXPIRED` | 401 | false |
| `USER_INACTIVE`, `SPACE_FORBIDDEN`, `SPACE_READ_ONLY` | 403 | false |
| `INSTALLATION_NOT_FOUND`, `PUSH_SESSION_NOT_FOUND` | 404 | false |
| `INSTALLATION_REVOKED`, `PUSH_SESSION_EXPIRED`, `REVISION_GONE` | 410 | false |
| `INSTALLATION_CODE_INVALID`, `INSTALLATION_CODE_EXPIRED` | 401 | false |
| `PROTOCOL_UNSUPPORTED` | 409 | false |
| `CURSOR_INVALID`, `CONFIRMATION_REQUIRED`, `PAYLOAD_INVALID` | 400 | false |
| `INSTALLATION_ALREADY_EXCHANGED`, `CREDENTIAL_COLLISION`, `BASE_STALE`, `CAPABILITIES_CHANGED`, `CONFIRMATION_MISMATCH`, `PATH_COLLISION`, `PAGE_ID_CONFLICT`, `BATCH_MISMATCH`, `PUSH_SESSION_INCOMPLETE`, `PUSH_SESSION_STATE_INVALID`, `IDEMPOTENCY_MISMATCH` | 409 | false |
| `PAGE_TOO_LARGE`, `BATCH_TOO_LARGE`, `QUOTA_EXCEEDED` | 413 | false |
| `SPACE_TOO_LARGE` | 409 | false |
| `RATE_LIMITED` | 429 | true |
| `INTERNAL_ERROR` | 500 | true |

`retryable` 只表示“不改变请求语义即可稍后重试”。`BASE_STALE` 虽可通过先 Pull 恢复，但原请求本身不可直接重试，因此为 false。429 响应必须带整数秒 `Retry-After` header。

## 16. HTTP 与安全要求

- 生产服务地址必须是 HTTPS。
- 仅 development 模式允许 loopback HTTP。
- URL 禁止嵌入用户名或密码。
- `/api/integrations/obsidian/*`、`/api/sync/v1/*` 和设备 session 路由不得返回 3xx；服务端必须在原请求 URL 直接返回终态成功或结构化错误。这是移动端 Obsidian `requestUrl` 无手动 redirect 控制时的强制服务端边界。
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
21. 删除 `(spaceId, contentHash)` 唯一约束后，Space 内容经历 `A → B → A` 会得到三个不同 sequence/revision，第三个 revision 的内容 hash 可与第一个相同。
22. Markdown 和 JSON Page 迁移只规范化换行、不解析或重排正文，并保存含原始正文的迁移前 PageVersion；开头 U+FEFF 明确阻塞而不静默剥离，非法 sourcePath 使用确定 fallback，失败不会暴露半迁移 Space。
23. 当前发布版 local-sync 在迁移前后获得逐字段等价的 Snapshot/Delta，包括 pages 原 ordinal、字段存在性、未规范化历史正文与已存储 legacy contentHash；从非空 base 拉取时，第一个 `revisions[i].delta` 是完整目标 KnowledgeBundle，不丢失未变页面，且可完成 Pull/Push。新 revision 不依赖完整 legacy JSON 双写。
24. 关键词 `PageSearchDocument` 与 Page/revision 同事务成功或失败；embedding outbox 失败不影响文本搜索一致性。
25. Windows 保留名、非法字符、尾随点/空格、超长 UTF-8 路径段和 Unicode case-fold 碰撞在协议包、服务端和浏览器 fixture 中得到相同拒绝结果。
26. session 上传/finalize 过期返回 410；保留期内 GET 返回 `200 + expired`，保留期后返回 404。
27. finalize 成功但响应丢失、创建凭据随后撤销时，同一 user/device/vault 的轮换凭据只能查询原结果，不能继续写旧 session；不同 identity 无法查询。
28. Relation/Memory-only revision 保持同一权威 sequence、相同 Page hash 和空 sync v1 Delta；随后 Page revision 的 parent/sequence 连续。
29. create session 响应丢失且该推送已使 head 前进后，以同一幂等键仍能恢复同一 session 及完全相同 result，不因原 base 已落后返回 `BASE_STALE`；任一绑定字段变化均返回 `IDEMPOTENCY_MISMATCH`，不同 credential family 不互相碰撞。
30. expand/backfill/contract 每阶段均可中断和重试；历史 rows 只由对应历史 revision 重建。Release A 双写期间可回滚到旧应用；Release B 停止 legacy JSON 双写后只回滚到 Release A 兼容二进制，不尝试回滚到不理解 nullable 字段的旧代码。
31. 并发 exchange 对同一 user/device/vault 复用并锁定同一 credential family，最终最多留下一个可激活 provisional；较早 provisional 被替换后不能再 activate，并发 activate 最终只留下一个 active credential。installation 状态、旧 provisional 撤销、新 provisional 创建和审计事务中任一故障都不会产生已消费但无凭据或有凭据但 installation 仍 pending 的状态。
32. 并发相同 create session 仅创建一条 session；同批并发上传的 staging rows、receipt 与累计值原子一致，跨批 page ID 重复被数据库唯一约束拒绝。
33. 两个并发 finalize 最多发布一个 ChangeSet 和一个 revision；第二个请求等待行锁后返回同一 result。发布事务回滚后 session 仍为 `ready_to_finalize` 且可重试，服务端不会留下无 result 的 `finalizing`。
34. Delta 的 from=head 返回空项与原 revision；Relation/Memory-only revision 则返回空项但前进 to revision。两种情况在分页 cursor 和插件 base 推进中都能区分。
35. `idFileKey` 对大小写不同的合法 ID 生成不同 key；COM¹–COM³/LPT¹–LPT³、空标题和控制字符标题在协议包与服务端得到相同拒绝结果。
36. 所有 Obsidian integration、session 和 sync v1 路由对正确 URL 直接返回终态响应，集成测试断言不出现 3xx。
37. 对同一 Space 已归档 page ID 的 upsert 恢复原 Page 并写 PageVersion；跨 Space 重用 page ID 返回 `PAGE_ID_CONFLICT`，不会静默移动页面。
38. exchange 后进程在 Secret Storage、本地 journal、session 验证和 activate 的每个间隙退出时，未激活凭据最长 10 分钟失效并返回专用 expired 错误；activate 响应丢失后重试/GET session 能确定 active 结果，且任何时候同一 user/device/vault 最多一个 active credential。
39. credential 轮换后，同 family 新凭据只能恢复查询旧 Push session 的已发布结果；未发布 session 不能继续写或 finalize，客户端以新确认和新 idempotency key 重建。不同 family 无法查询旧 session 时通过 head/Pull 判断并收敛，不盲目重复未知发布。
40. 两个不同 batch 的并发 PUT 与 DELETE/finalize/expiry cleanup 竞争时全部通过同一 session 行锁线性化；累计数量/字节不丢更新，aborted/published/expired 后无 staging 晚提交，cleanup 不能删除正在 finalize 所需的 staging 或改变确定结果。
41. 两个 Space 并发创建同一 pageId 时，全局数据库约束只允许一个内部 Page/identity 成功，另一事务返回 `PAGE_ID_CONFLICT`；历史跨 Space 重复会阻塞迁移而非静默重写。
42. exchange 在服务端提交后丢失响应时，插件用 Secret Storage 中同一 credential 和持久化 exchangeId 重试，取得同一 credentialId/provisional 元数据；不同请求绑定被拒绝，数据库和日志均无明文 credential/code。
43. 协议包逐路由导出的 body/query/path/success Schema 与服务端 controller 和插件 client 共用；credentials GET 始终返回 envelope，匿名 JSON DTO 不进入实现。
44. maxChangeCount=5,000、maxConfirmationBytes=4 MiB 的边界在 client/server 一致执行；5,001 项或超 4 MiB confirmation 被阻塞/拒绝，5,000 项 Push 在 32 MiB 插件额外 heap 预算内完成。
45. 已绑定 Space 从 5,000 增长到 5,001 时，head/Snapshot/Delta 的 pageCount 使插件在写 Vault 前阻断；Obsidian finalize 的结果页数超过 5,000 时服务端原子拒绝，首次合并也不能产生超限本地集合。
46. create session 的 confirmationByteLength 参与幂等绑定并受 capability 限制；finalize 重建出的 canonical byte length/hash 任一不符都原子拒绝。
47. Push 预览读取的完整 capability hash 参与 create 和幂等绑定；预览与 create 之间 capability 变化返回 `CAPABILITIES_CHANGED` 且不创建 session，客户端重新预览。
48. revision 的 pageCount/body/manifest 指标与 rows/hash 同事务写入，Relation/Memory-only 原样继承；Snapshot/Delta 每页全部指标固定，插件重建值不符时废弃。超过 JavaScript safe integer 的数据库 fixture 仍以 canonical decimal string 精确往返，服务端计算和客户端阈值比较不经浮点 number。
49. `installationCodeHash` 与 `credentialHash` 分别全局唯一且只做单值查询；可控 fixture 强制碰撞时 installation 创建内部重生成 code，credential exchange 整体回滚、不消费 code且不泄漏既有主体，客户端换 credential/exchangeId 后可成功。
50. family 中存在已过期但仍标 provisional 的行时，新 exchange 在 family 锁内先推进 expired 再建立唯一 provisional；exchange/认证/activate/cleanup 的并发与故障注入不死锁、不产生双 provisional/active。
51. head revision rows 永不被 retention cleanup 删除且无论年龄都能分页；超过 31 天的长期 head 在签发 cursor 后被新发布替换时，同事务固定 supersededAt，cleanup 不早于 `max(publishedAt+31d, supersededAt+25h)`。故障注入验证旧 cursor 在替换后仍能完成，cleanup 与多页 Snapshot/Delta 并发不删除有效 cursor 所需 rows。
52. 数据库克隆到使用不同 deployment seed 的服务时启动门禁拒绝流量；显式 rotate 后得到新的 serverInstanceId。同部署备份恢复使用原 seed 时保持 ID，rotate 写安全审计。
53. changeCount=0 和“全部 upsert 与当前相同”两种 noop 均在 session 锁事务中持久化完整 result 并置 published；响应丢失、并发 head 后续前进、重启和 exact create replay 都返回原 result，不创建 ChangeSet/revision。

## 18. 跨仓实施规则

- 本文档只记录插件所需公开契约，不授权当前任务修改 AgentWiki 主项目。
- 主项目实现必须建立独立设计、计划、测试和发布任务。
- 插件只能依赖已发布协议包和公开 API，不能复制主项目 controller、service、Prisma 类型或 local-sync 内部实现。
- 主项目最终路由或字段如需调整，必须先更新本契约并在插件仓库中明确版本迁移影响。
