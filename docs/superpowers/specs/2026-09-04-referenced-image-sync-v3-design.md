# AgentWiki 引用驱动图片同步 Sync v3 设计

## 状态

- 日期：2026-09-04
- 状态：完整设计已通过，待实施
- 主责仓库：`AgentWiki-Obsidian`
- 上游只读基线：AgentWiki `v0.7.0`
- 当前插件基线：AgentWiki Sync `0.3.0`
- 当前公开协议基线：`@neomei/agentwiki-sync-protocol@0.4.0`
- 协议目标：新增 wire protocol `"3"`，保留 Sync v2 和 Legacy v1 兼容边界

## 背景与根因

AgentWiki 网页端已有 Space 附件系统：PNG、JPEG、WebP 和 GIF 经过鉴权上传，元数据保存在 PostgreSQL，不可变字节保存在受保护的内容寻址文件存储中。Markdown 正文保存图片引用，渲染时通过同 Space 解析和授权请求获取 Blob。

AgentWiki Sync `0.3.0` 虽然会通过 Obsidian Vault API 枚举非 Markdown 文件，但本地树扫描只保留 Folder 和 Markdown Page，图片作为普通 `file` 被静默忽略。Sync v1/v2 的 Snapshot、Delta 和 Push 也只有 Page/Folder 对象，无法表示图片身份、版本或 Blob。结果是 Markdown 可以同步，但其引用的本地图片不会上传，网页附件也不会下载。

仅在插件中串联现有附件 REST 和 Sync v2 无法满足完整性：附件上传与 Page Revision 发布不是同一提交边界，会留下短暂或持久破图、孤儿 Blob 和无法唯一恢复的失败状态。因此本设计采用 Sync v3，把“当前 Revision 实际引用的图片”纳入正式修订，但不把 AgentWiki 扩展为通用文件管理器。

## 已确认的产品决策

1. 只扫描 `pages/**/*.md` 中的图片引用。
2. 只同步解析后位于映射根 `assets/` 下的 PNG、JPEG、WebP 和 GIF。
3. `assets/` 中未被 Markdown 引用的图片不进入 Snapshot、Delta、预览或上传。
4. 每张受管图片具有稳定 `attachmentId`；重命名和内容更新不改变身份。
5. 删除最后一个 Markdown 引用只让图片退出同步集合；不归档远端附件，不删除本地文件。
6. 图片仍被当前 Markdown 引用时，缺失、归档或无法唯一解析必须阻止发布。
7. 同名同哈希自动绑定；同名异内容显式冲突。
8. 同一图片仅一端重命名或替换内容时自动合并并显示预览；两端异向变更时要求用户选择。
9. 支持 Obsidian `![[...]]` 与标准 Markdown `![alt](...)` 图片语法；不同步 URL、data URI 或映射目录外文件。
10. 页面正文和其引用图片对用户原子可见；任一引用图片失败，本次同步不发布、不部分应用。
11. 网页端继续使用 Markdown 编辑器内的上传、粘贴、拖放和选择器；不新增独立附件管理中心。

## 目标

1. AgentWiki 网页上传并引用的图片可以安全 Pull 到 Obsidian `assets/`。
2. Obsidian Markdown 引用的 `assets/` 图片可以安全 Push 到 AgentWiki 并正常渲染。
3. 页面、附件身份、附件版本和 Revision 引用集合共享一个权威发布边界。
4. 同名、重命名、内容替换、引用取消和双端并发编辑都有确定的三方合并结果。
5. Push 与 Pull 延续现有预览、显式确认、取消、日志、回滚和崩溃恢复边界。
6. 新旧服务器/插件组合不能静默丢图或只同步 Markdown。
7. 保持 Obsidian 桌面与移动端兼容，不引入 Node.js 文件系统依赖。

## 不做

- 不同步未被 Markdown 引用的 Space 附件或 Vault 图片。
- 不做通用附件目录、标签、搜索、文件夹、缩略图库或自动孤儿清理产品。
- 不同步 PDF、视频、音频、SVG 或任意二进制文件。
- 不上传网络图片、Base64/data URI、Vault 其他目录、`.agentwiki/` 或凭据。
- 不将图片字节内联到 Snapshot、Delta 或 JSON Push batch。
- 不让旧插件对含受管图片的 Space 继续执行不完整同步。
- 本设计阶段不修改 AgentWiki 主仓、数据库、生产部署或当前安装插件。

## 方案选择

采用 **Sync v3 统一修订**：Folder、Page 和被引用 Attachment 共用 Snapshot、Delta、Push confirmation、Push session 和 Finalize。Blob 通过独立内容通道预上传，但只有 Finalize 中的数据库事务可以让附件版本和 Page Revision 变为可见。

不采用以下方案：

- **Sync v2 + 独立附件 REST**：开发快，但附件与 Page Revision 无法原子发布，需要一套很难完整的补偿协议。
- **独立 Attachment Manifest 绑定 v2 Revision**：会产生两套 Snapshot/Delta、两套保留与完整性校验，长期复杂度不低于 v3。

## 权威模型与不变量

### 受管引用集合

每个 Sync v3 Revision 的附件集合必须等于该 Revision 内所有 Page Markdown 经权威解析后的去重图片身份集合。客户端不能单独宣称一张图被引用；服务端 Finalize 必须重新解析正文、解析附件身份，并与暂存 manifest 严格相等。

引用消失使新 Revision 不再包含该 `attachmentId`，在 Delta 中表示为 `detach_attachment`。`detach_attachment` 只改变 Revision 引用集合，不归档 `SpaceAttachment`，不删 Blob，不删 Vault 文件。

### 图片身份与版本

```ts
interface SyncAttachmentV3 {
  attachmentId: string;
  path: string;          // canonical assets/<displayName>
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: string;     // bounded decimal bigint
  width: number;
  height: number;
  contentHash: string;   // lowercase SHA-256
  updatedAt: string;     // RFC 3339
}
```

- `attachmentId` 是稳定身份。
- `path` 是 Space 内可版本化的规范路径，首版必须为 `assets/<single-file-name>`，不支持附件子目录。
- 路径唯一性使用与 Page/Folder 相同的 Unicode NFC、case-fold 和可移植名称规则。
- 内容更新创建新 AttachmentVersion，保留 `attachmentId`。
- 重命名更新当前路径，保留 `attachmentId` 和当前 AttachmentVersion。
- 同一 Revision 中一个 `attachmentId` 只能出现一次，一个 `pathKey` 只能对应一个 `attachmentId`。

### Page 与附件关系

Sync v3 Page 在 v2 Page 字段之上新增规范化、去重、按 `attachmentId` 排序的 `referencedAttachmentIds: string[]`。该字段是服务端和插件对 Markdown 解析结果的签名证据，不代替正文中的具体语法或位置。Finalize 必须验证：

1. 每个 ID 都存在于同一 Space 的本次候选 Attachment 集合。
2. 每个引用 Attachment 都是活跃的。
3. 每个 AttachmentVersion 都有已验证、可读取的 Blob。
4. 服务端重新解析正文得到的 ID 集合与声明字段完全相等。

## Markdown 引用解析

### 受支持语法

- Obsidian 图片嵌入：`![[assets/name.png]]`，并保留 alias/尺寸部分。
- 标准 Markdown 图片：`![alt](../assets/name.png "title")`，按 Page 路径解析相对目标。
- 升级兼容：历史网页正文中的 `![[name.png]]` 只在 `assets/` 内能唯一解析到一个活跃 Attachment 时才视为合法。它可按原样下发，不强制改写已有正文。

新的网页上传、粘贴、拖放和选择器插入统一生成 `![[assets/<server-authoritative-name>]]`。网页 Markdown 解析器必须识别这一规范路径，不将 `assets/` 当作展示名的一部分。

### 拒绝与歧义

以下引用不进入图片同步：HTTP(S) URL、data URI、绝对路径、解析到 `assets/` 之外的路径和不支持的扩展名。URL/data URI 是明确的外部资源，保留正文但不触发本地图片错误。一个看似本地图片的引用如果路径逃出、存在同名歧义、文件缺失或类型不匹配，则作为预览阻塞项，用户必须修正引用或文件后才能继续。

### 精确改写

重命名时必须通过 Markdown 解析器保存的 source range 只改写目标 path token：

- Obsidian 语法保留 alias、尺寸、空白和其他标记。
- 标准 Markdown 保留 alt、title、尖括号/转义风格，按当前 Page 目录生成指向新 `assets/` 路径的等价相对路径。
- 不执行全文字符串替换。
- 不能精确定位的引用阻止重命名，不猜测改写。

## Sync v3 公开协议

### 能力协商

`GET /api/sync/v3/capabilities` 返回严格协议对象和 canonical capability hash。在 v2 能力上增加：

- 每张图片最大字节数。
- 每次修订最大 Attachment 数。
- 每次 Push/Pull 最大图片总字节。
- Blob 分块大小、最大分块数和最大并发数。
- 允许的 MIME 和图片尺寸/解码像素上限。
- Push session、Blob 暂存和下载授权的 TTL。

任何未知字段、hash 不匹配、非法上限或响应超限都失败关闭。

### Snapshot 与 Delta

v3 Snapshot 的权威 manifest 包含：

```ts
interface TreeRevisionContentManifestV3 {
  protocolVersion: "3";
  spaceId: string;
  folders: SyncFolderV3[];
  pages: SyncPageV3[];
  attachments: SyncAttachmentV3[];
}
```

canonical 顺序为 Folder 父先子后、Page 按 pathKey/ID、Attachment 按 pathKey/ID。Revision hash 覆盖 Folder、Page（包含 `referencedAttachmentIds`）与 Attachment 元数据，不内联 Blob 字节；AttachmentVersion 的 `contentHash` 将 Blob 字节密码学地绑定到 Revision。

Delta 在 v2 Folder/Page 操作上增加：

- `upsert_attachment`：新绑定、重命名或内容版本变化。
- `detach_attachment`：新 Revision 不再引用，不归档附件。

Delta 不提供同步归档操作。网页主动归档当前未引用的附件属于附件 REST 领域，不属于 Sync Revision；归档当前 Revision 仍引用的附件必须返回 `ATTACHMENT_REFERENCED`。

### Push manifest 与 Blob 通道

Push confirmation manifest 同时绑定 Folder/Page/Attachment changes、Page 的引用 ID 集合、每个 Blob hash/字节数和能力 hash。服务端创建 session 后只返回缺失的 `contentHash` 集合。

创建 Push session 的请求必须在上传 canonical change batches 之前携带严格的 `blobRequirements`：每项只包含 `contentHash`、`sizeBytes`、`mimeType`、`width` 和 `height`，不包含 `attachmentId`、路径或更新时间。requirements 按 `contentHash` 严格升序且唯一，精确覆盖本次 confirmation changes 中全部 `upsert_attachment.attachment.contentHash` 的去重集合；同一个 Blob 可以由多个 Attachment identity 复用。这里必须声明全部需要的 Blob，包括服务端可能已经持有的内容，客户端不得在 create 前猜测服务端存量；服务端再据此过滤并返回 `missingContentHashes`。

create request 的 `attachmentCount` 表示本次 confirmation 中 `upsert_attachment` change 的数量约束，不是候选最终 Revision 的 Attachment 总数。纯 `detach_attachment`、沿用 base 的未变 Attachment 都不要求 Blob requirement；因此 `blobRequirements.length <= attachmentCount`，`attachmentCount = 0` 时 requirements 必须为空。`transferBlobBytes` 是上述去重 requirements 的 `sizeBytes` 精确总和（包括服务端可能已存在的 Blob），并受 100 MiB 硬上限和协商 capability 约束。公开 request schema 可以校验排序、唯一、数量和精确字节和；requirements 与 confirmation changes 的集合一致性必须由服务端在 batch upload 和 Finalize 时交叉验证。confirmation manifest 与 `confirmationHash` 算法保持不变，因为 `upsert_attachment` 已绑定同一组 Blob 元数据。

Blob 上传：

1. 只允许 session 需要的 hash。
2. 支持分块、幂等重试和完整收据。
3. 服务端组合后重新验证字节数、SHA-256、扩展名、MIME、魔数、宽高和解码像素。
4. 验证成功的 Blob 以内容寻址形式保存，但在 Finalize 前不属于任何可见 Revision。
5. 过期 session 的无引用 Blob 在宽限期后由 GC 清理。

Blob 下载必须使用当前 Human Device Credential，并绑定 Space、固定 Revision、AttachmentVersion 和短 TTL。下载不返回直接公开 URL，不在 DOM、Vault 或日志中持久化授权地址。

### Finalize

Finalize 在同一锁定边界中：

1. 锁定 Space/head，重新校验 Human Device Credential、当前成员角色、Space policy 和 base revision。
2. 重算 capability hash、confirmation hash、batch receipts 和声明数量/字节。
3. 验证所有引用 Blob 完整存在。
4. 权威解析所有候选 Page Markdown，并与 Page 引用 ID 和候选 Attachment 集合比较。
5. 在一个 PostgreSQL 事务中写入 AttachmentVersion、SpaceAttachment 当前字段、Page/PageVersion、Revision Folder/Page/Attachment rows、Delta、sidecar、ChangeSet provenance 和新 head。
6. 事务成功后持久化幂等终态；任何重试返回同一结果，不重放发布。

Blob 文件的预写不可能与 PostgreSQL 共享文件系统级原子事务；系统的原子可见边界是“先写不可见 Blob，再用数据库事务链接到新 Revision”。这会允许可 GC 的暂存孤儿 Blob，但不会出现可见 Page 引用未发布 Blob 的状态。

## 服务端数据模型

在现有 `SpaceAttachment` 与内容寻址存储之上追加版本和 Revision 关系，不破坏已发布附件：

- `AttachmentVersion`：`id`、`attachmentId`、`contentHash`、`storageKey`、`mimeType`、`sizeBytes`、`width`、`height`、`createdAt`。相同 `attachmentId + contentHash` 唯一。
- `SyncRevisionAttachmentRow`：`revisionId`、`attachmentId`、`attachmentVersionId`、`path`、`pathKey`、`ordinal`。Revision 内 ID 和 pathKey 都唯一。
- Push staging 追加 Attachment change、Blob requirement、chunk receipt 和验证结果；不把 Blob 内联到单一 JSON row。
- Revision 追加 `attachmentCount`、`revisionAttachmentBytes`、包含 Attachment 的 manifest byte length 和版本化 sidecar/schema 标记。

数据迁移为现有活跃 `SpaceAttachment` 创建初始 AttachmentVersion。历史 v1/v2 Revision 不猜测反向绑定附件，保持原样。每个 Space 第一个 v3 Revision 从当前 Page Markdown 和活跃 SpaceAttachment 构建完整引用集合；存在歧义、缺失或归档引用时拒绝升级并要求先修复。

Retention 和 GC 必须保留任何可读 Revision、未过期 Push session、AttachmentVersion 或当前 SpaceAttachment 仍引用的 Blob。Revision 过期不等于附件归档。

## 插件本地模型

### 树模型

插件内部 Snapshot 升级为 Folder/Page/Attachment 统一模型。Vault 扫描分两阶段：

1. 枚举并解析 `pages/**/*.md`，收集候选图片引用。
2. 只读取候选引用指向的 `assets/` 文件，计算 hash 并验证图片。

扫描不读取未引用图片字节，但可以枚举 `assets/` 名称以执行唯一解析和路径碰撞校验。

### 私有控制状态

`.agentwiki/` 新增版本化、hash 保护的状态：

- Attachment identity：`attachmentId -> path/pathKey/baseContentHash`。
- Pending Attachment identity：本地新引用、尚未发布的稳定 ID。
- v3 generation：完整 Folder/Page/Attachment metadata 和 Revision 指针，不内联图片字节。
- Blob staging：下载中的已验证分块/完整 Blob，成功或过期后清理。
- Pull journal：受影响 Markdown/图片的 before/after hash、操作顺序、checkpoint 和 rollback 状态。
- Push journal：confirmation hash、session ID、缺失 Blob、chunk/receipt、Finalize 终态和本地提交阶段。

所有 Schema 拒绝未知未来版本。日志不保存 credential、Authorization header、公开 Blob URL 或未脱敏图片字节。

detach 后保留一条不活跃的身份提示，仅用于未来重新引用同 path/hash 时恢复原 `attachmentId`。该提示不会使插件监视、上传、下载或删除已退出引用集合的文件。重新引用时若 path/hash 已变化或身份存在歧义，则按首次绑定/冲突规则重新决策，不凭陈旧提示强制绑定。

## Pull 状态机

1. 恢复或终止上次未完成 Pull/Push，未达唯一状态时冻结该 Space。
2. 获取并严格校验 v3 capabilities、head 和固定 Snapshot/Delta。
3. 校验 Folder/Page/Attachment 数量、manifest 字节、Page 正文 hash、Attachment metadata 与整体 Revision hash。
4. 只为本地缺失或 `contentHash` 不同的 AttachmentVersion 下载 Blob。
5. 在私有 staging 中验证每个 Blob 的长度、hash、MIME、魔数和尺寸。
6. 将 base/local/remote Folder、Page 和 Attachment 做三方比较，构建一个统一预览。
7. 用户处理所有冲突后显式确认。
8. 写入持久化 Pull journal 和受影响对象的 before images。
9. 使用 Obsidian Vault/FileManager API 按依赖顺序应用操作：先创建目录和新图片路径，再写入已改写引用的 Markdown，最后移除旧图片路径。这个顺序保证事务执行中可以暂时多一份图，但不让已改写的 Markdown 指向尚未存在的目标。
10. 重扫描并验证目标 Revision hash，再原子切换 v3 generation 和 identity 指针。
11. 清理日志和暂存。

Obsidian Vault API 无法把多文件更改做成单个文件系统事务。因此本地“原子”指可恢复的原子结果：成功提交完整目标状态，或仅在当前字节仍等于事务 after image 时回滚到 before image。如果中断后用户已修改对象，停止为 ambiguous，绝不覆盖。

## Push 状态机

1. 必须先完成 Pull 并重新验证远端 head。
2. 扫描本地 Page 与引用 Attachment，用 identity 台账和 base Snapshot 恢复稳定 ID。
3. 计算 Folder/Page/Attachment 变更和三方冲突。
4. 展示统一预览；冲突未解决或有阻塞引用时禁止确认。
5. 确认时用精确 Folder/Page/Attachment manifest 生成 confirmation hash，创建 Push session。
6. 按服务端返回的缺失 hash 幂等上传 Blob，记录 chunk 与 receipt。
7. 上传 canonical change batches，并在本地状态不再匹配确认 hash 时停止 Finalize。
8. 发送 Finalize；此后进入不可取消阶段，只能查询幂等终态。
9. 成功后重扫描本地，验证与已发布 Revision 一致，再提交 v3 generation 与 identity。

`CAPABILITIES_CHANGED` 允许一次重新获取能力并完全重建预览/session；第二次变化失败关闭。`BASE_STALE` 回到 Pull，不复用旧确认。

## 三方合并与冲突

Attachment 独立比较 `path` 和 `contentHash`：

| 场景 | 结果 |
| --- | --- |
| 首次绑定，同 pathKey 且同 hash | 自动绑定现有 `attachmentId` |
| 仅一端更新内容 | 保留 ID，使用新 AttachmentVersion |
| 仅一端重命名 | 保留 ID，更新另一端路径和所有受影响 Markdown 引用 |
| 两端替换为不同 hash | 冲突：本地 / 服务器 / 保留两份 |
| 两端重命名为不同 pathKey | 冲突：选一个路径，或保留两份 |
| 路径被另一 ID 占用 | 名称冲突，不静默加后缀 |
| 引用存在但图片缺失/已归档 | 阻止：恢复图片、重新绑定，或先删除引用 |
| 最后一个引用消失 | detach；两端文件保留但退出同步管理 |

“保留两份”不猜测页面分流。用户必须选择哪一版继续使用原 `attachmentId` 和现有引用；另一版创建新 ID，由服务端分配可移植名，例如 `assets/photo (2).png`。只有用户在预览中显式把某个 Page 引用改向新版本时，系统才改写该 Page。

## 网页端行为

保留现有 Markdown 编辑器的图片按钮、粘贴、拖放、上传和选择器。新增行为仅限：

- 新插入统一使用 `assets/` 规范路径。
- Page 保存必须解析引用并写入 v3 Revision 引用集合。
- 附件选择器中增加轻量“重命名”操作。确认对话框显示受影响 Page；服务端在一个 Space 锁事务中精确改写当前 Page 引用、写 PageVersion/Revision 并重命名附件。
- 归档仍被当前 Revision 引用的附件时，显示引用 Page 列表并阻止。

不新增附件主导航、Space 附件管理页或自动清理任务。

## Obsidian 同步中心

继续使用现有统一预览弹窗，不新增平行同步界面。摘要增加：

- Sync v3 协议标识。
- 上传、下载、内容替换、重命名和 detach 的图片数。
- 上传/下载总字节和能力上限。
- 每个图片的路径、操作、字节数、影响 Page 数和冲突选项。

预览不展示图片原始字节、凭据、Blob 存储路径或带授权的 URL。所有引用和冲突解决完成前禁用“确认执行”。

进度阶段为：扫描、校验、下载/上传、发布、本地提交。扫描、校验、传输、合并和预览可取消；服务端 Finalize 和 Vault 事务开始后不在中间停止，必须达到成功、安全回滚或 ambiguous 终态。

## 兼容与升级

### 协议选择

- 新插件 + v3 服务器：自动选择 v3。
- 新插件 + 仅 v2/v1 服务器：如果本地和远端候选 Markdown 都没有本地图片引用，可继续使用现有 v2/v1；只要任一端存在候选本地图片引用，就阻止同步并提示升级服务器。
- 旧插件 + 当前 v3 Revision 含 Attachment：服务器对 v2/v1 head、Snapshot、Delta 和 Push session 返回 `SYNC_PROTOCOL_UPGRADE_REQUIRED`，防止只同步 Markdown。
- 已进入 v3 的本地映射不自动降级。

新插件在旧服务器上判断远端候选图片引用时，只需解析 Snapshot/Delta 正文；无需访问私有服务器实现。任何看似本地图片且旧协议无法证明完整性的引用都安全地触发升级提示。

### 第一个 v3 Revision

数据库 Schema 迁移只回填 AttachmentVersion，不在未校验 Markdown 的情况下批量伪造历史 Revision，也不让 GET 请求隐式修改 Space。

服务器升级后，v3 Space 列表对每个 Space 返回 `native_v3 | bootstrap_required | legacy_v2` 模式。当当前 v2 Revision 的 Markdown 包含候选本地图片引用时：

1. 旧 v1/v2 同步入口立即返回 `SYNC_PROTOCOL_UPGRADE_REQUIRED`，避免过渡期静默漏图。
2. 新插件通过只读 bootstrap preview 获取当前 Page、可解析 Attachment、歧义和缺失项。
3. 第一次 Pull 的统一预览同时告知用户该 Space 将升级为 v3。只有所有引用可唯一解析且用户确认后，专用 bootstrap 写入入口才在 Space 锁下创建语义等价的第一个 v3 Revision。
4. bootstrap 发布成功后，插件才按该固定 v3 Revision 执行 Blob 下载和本地 Pull。

如果网页 Page 保存、附件重命名或其他已有人类确认的写入首先需要 v3，同一个 Space writer 在其锁定事务内执行相同 bootstrap 校验并直接发布该用户写入的第一个 v3 Revision，不创建额外中间 head。无图片引用的 Space 可保持 v2，不强迫旧插件升级。

一旦 Space 发布过 v3 Revision，后续即使当前 Revision 的 Attachment 集合为空，权威 head 仍保持 v3。为实现已确认的“无受管图片时可用旧客户端”兼容，v1/v2 读取可以返回去除 Attachment 字段后的协议投影及其独立投影 hash；只要目标 head 或固定 Delta 终点包含 Attachment，就必须拒绝投影。投影 hash 不能与 v3 权威 revision hash 混用，服务端必须按请求协议版本固定并校验它。

## 权限与安全

- Sync v3 继续使用单独 Human Device Credential，不使用 Agent API key 发布本地同步。
- Snapshot/Delta/Blob 下载要求当前 Space 可读。
- Push session 创建和 Finalize 都要求当前角色可发布，Finalize 在 Space 锁内重查。
- 网页上传、重命名、归档和恢复继续遵循现有 HumanOnly 与 Space 角色边界。
- Blob 根目录仍在部署产物之外持久化，不公开静态服务，继续拒绝符号链接、路径穿越和非常规文件。
- 同一图片在不同 Space 之间可底层去重 Blob，但附件身份、元数据、授权和引用始终按 Space 隔离。

## 能力上限

默认单图限制与现有网页附件一致：10 MiB、10,000 像素单边、40,000,000 解码像素。实际运行值来自 v3 capabilities，客户端不把默认值当作服务器真值。

公开协议的硬上限为：每张 Blob 10 MiB、每个 Revision 1,000 个受管 Attachment、每次 Push/Pull 需要新传输的 Blob 总量 100 MiB、每块 1 MiB、每个 Blob 最多 10 块。服务器 capabilities 可以降低但不能超过这些值。客户端默认最多并发 2 个 Blob，可在服务器 capability 和运行时平台约束内降为 1，不提供用户可调的无界并发。

若固定 Revision 需下载的缺失 Blob 超过单次 100 MiB，不得分批部分应用该 Revision；预览显示超限并要求减少/压缩引用图片后再同步。本 spec 不允许未受限制的请求、响应、内存缓冲、本地 staging 或事务 before image。

## 错误边界

Sync v3 新增或明确使用以下可行动错误：

- `ATTACHMENT_REFERENCE_INVALID`：语法或路径无法安全解析。
- `ATTACHMENT_MISSING`：当前 Page 引用的本地文件或远端活跃附件不存在。
- `ATTACHMENT_CONTENT_INVALID`：扩展名、MIME、魔数、尺寸、字节数或 hash 不一致。
- `ATTACHMENT_NAME_CONFLICT`：一个 pathKey 对应不同身份/内容，或目标路径已占用。
- `ATTACHMENT_REFERENCED`：试图归档当前 Revision 仍引用的附件。
- `ATTACHMENT_BLOB_MISSING`：Finalize 时需要的 Blob 未完整上传、未验证或已过期。
- `ATTACHMENT_QUOTA_EXCEEDED`：单图、修订总字节或 Space 配额超限。
- `SYNC_PROTOCOL_UPGRADE_REQUIRED`：当前 Revision 含 v3 附件语义，旧客户端不能安全继续。

错误响应不包含文件系统绝对路径、凭据、未脱敏 Markdown、Blob 字节或服务器内部存储键。

## 验收与测试矩阵

### 公开协议包

- Folder/Page/Attachment v3 Schema、strict unknown-field rejection 和类型导出。
- canonical Snapshot、Delta、confirmation、batch 和 capability hash test vectors，覆盖 Unicode NFC/case-fold。
- `upsert_attachment` / `detach_attachment` 顺序、去重和 revision hash。
- Page `referencedAttachmentIds` 与 Attachment 集合不变量。
- Blob 分块请求/收据、字节上限和幂等向量。

### AgentWiki 服务端与网页

- 新表、唯一约束、外键、BigInt JSON、迁移回填与回滚备份验证。
- v3 capabilities/head/Snapshot/Delta 分页、cursor、固定元数据和响应字节上限。
- Blob 上传分块、去重、断点续传、MIME/魔数/尺寸校验、过期、GC 与并发竞态。
- Finalize 的权限重查、base stale、confirmation mismatch、缺失 Blob、引用不一致和数据库原子性。
- Retention 和 GC 不删除可读 Revision/session/附件版本仍引用的 Blob。
- 网页上传、粘贴、拖放、选择、规范 `assets/` 插入、受影响 Page 重命名和归档保护。
- 同 Space 不同角色、被删除/失活用户、撤销 credential 和 Agent 凭据隔离。

### Obsidian 插件

- Obsidian 与标准 Markdown 语法，alias/alt/title/转义，相对路径，历史裸名唯一解析。
- URL/data URI 不进入同步；路径逃出、歧义、缺失和不支持类型按规则阻止。
- 未引用图片不读字节、不进预览、不上传。
- Attachment identity/pending identity/generation/staging/journal 的损坏、未知版本、双候选和跨设备恢复。
- 同名同 hash、同名异 hash、单端替换、双端替换、单端重命名、双端重命名、目标占用和保留两份。
- 精确引用改写与未相关 Markdown 字节不变。
- Pull 下载前置校验、Vault 多文件事务、before/after 恢复、用户中途修改不覆盖。
- Push 缺失 Blob、分块重试、取消、Finalize 终态恢复和本地提交。
- 桌面与移动端 Vault/FileManager API，窄宽同步弹窗和大列表分页。

### 兼容矩阵

- 新插件 + v3 服务器，有图/无图 Space。
- 新插件 + v2/v1 服务器，本地无图、本地有图、远端有候选图片引用。
- 旧插件 + v3 服务器，当前 Revision 无 Attachment/有 Attachment。
- v1/v2 本地 generation 升级到 v3，失败不污染旧基线。

### 端到端与真实验收

1. 独立测试 Space 网页上传并引用图片，Obsidian Pull 后离线可见。
2. 独立测试 Vault 中新建图片并引用，Push 后网页可见，且受保护 Blob 无公开 URL。
3. 覆盖内容替换、双端冲突、重命名、保留两份和精确 Markdown 改写。
4. 删除最后一个引用后，两端图片均保留且下次同步不再传输。
5. 在 Blob 上传、下载、Finalize 响应、Vault 图片写入、Markdown 写入和 generation 切换点逐一故障注入，证明无可见破图且可唯一恢复。
6. 使用真实 Obsidian 桌面端和至少一个移动端运行时验证 Vault/FileManager 行为。
7. 发布验收使用独立测试 Vault/Space；未获得用户对“确认执行”的单独授权，不在主 Vault 或生产 Space 上执行写入。

## 发布顺序

1. 在 AgentWiki 主项目的独立任务中实现并发布包含 Sync v3 的公开协议包。
2. 在 AgentWiki 主项目独立任务中实现数据迁移、服务端、Web 和 v1/v2 升级门，通过生产前验证后先部署服务器。
3. 插件仅依赖已发布的公开协议包，不直接导入 AgentWiki 主仓内部代码。
4. 插件完整验证后再发布新版本，不覆写旧 tag/Release。
5. 发布后分别核对本地源码、GitHub/tag/Release、npm 协议包、生产服务、Obsidian 市场状态和真实安装 bundle；任一状态不代表其他状态。

## 仓库边界

本 spec 保存在插件仓库，作为跨仓公开契约和影响记录。AgentWiki 主仓在本任务中保持只读。主项目实施必须由单独授权任务进行，并在主项目自身的设计/计划/验证文档中回链本 spec。
