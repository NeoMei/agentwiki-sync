# Sync v2 页面版本一致性修复要求

日期：2026-09-25。状态：插件 0.5.5 与服务端 v0.12.7 已发布；服务端部署、NeoMei-Docs 原生同步与零差异验收均已通过。

## 已验证现象

- 用户在 `Hello AgentWiki!` 内容冲突中选择保留本地。Pull 已提交，本地正文仍保留，Push 在 finalize 返回 HTTP 409 / `BASE_STALE` / `Document tree base is stale`。
- 当前 Obsidian 窗口为测试 Vault；磁盘曾是 0.5.4，运行时仍是 0.5.3。现已重新加载并确认运行 0.5.5。
- 插件 0.5.5 修复已有 Page/Folder 的 Push `updatedAt`：使用远端基线值，不能使用本地扫描时间。新增对象保持原流程。提交 `01da7a6`；1,397 项测试、类型检查、构建和发布检查通过。
- 0.5.5 的真实新推送仍返回同一个 409。当前服务端 head 与本地基线相同：`cmufdb3vd02k212csqgvx9oxs`，sequence 5。
- 此页同步标识为 `cmsiwqitz0008eci1a5r25uzz`。Sync v2 snapshot 的 `updatedAt` 是 `2026-09-24T10:07:06.104Z`，修复后推送准确携带这个值。
- 登录态网页正常 GET `/api/pages/cmsiwqitz0007eci1h89876qf` 返回 HTTP 200，实体的 `updatedAt` 是 `2026-09-24T10:07:05.965Z`。两个版本值相差 139 ms。
- 初次取证阶段未修改服务端。随后用户授权独立主项目修复及部署，生产数据库只读核对确认了相同的 139 ms 差异。

## 主项目代码依据（只读检查）

主项目：`/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`。

- `apps/server/src/core/sync/space-revision-writer.service.ts`：`SyncRevisionPageRow.upsert` 的 create/update 使用 `updatedAt: new Date()`；快照时间由 revision writer 另行生成。
- `apps/server/src/content-tree/content-tree.service.ts`：`publishSyncV2BatchLocked` 对已有页面要求请求 `updatedAt === Page.updatedAt.toISOString()`，否则抛出 `CONTENT_TREE_CONFLICT`。
- `apps/server/src/integrations/obsidian/push-session.service.ts` 将上述错误映射成 `BASE_STALE`。协议消费者仅能拿到快照版本，无法提供当前实体的另一时间值。

## 所需稳定契约与影响

1. 同步读取返回的 Page/Folder 版本值必须能用于后续 Push 的并发前置条件；在服务器无新变更时，Pull 后修改正文应能成功 Push。
2. 同一事务中产生的实体和同步快照应使用同一权威版本值。覆盖普通逐项 revision writer、批量 writer、网页修改及同步发布路径。
3. 已有 head 快照的时间可能已经与实体漂移。修复必须明确处理历史数据，不能只修未来写入，也不能原地篡改已发布的不可变快照而不处理完整性证据。
4. 如采用“请求版本对比基线快照”的兼容方案，必须同时校验 head 与实际实体未漂移；不能简单删除时间戳校验或接受任意陈旧内容。
5. 补充真实数据库回归：网页编辑后 Pull→本地修改→Push、保留本地冲突、目录修改、真正并发修改仍被拒绝，以及既有漂移 head 的恢复。
6. 按本项目跨仓约束，在独立 AgentWiki 主项目任务中实现、审查和部署；插件不复制服务端内部实现、不读取数据库凭据，也不绕过并发校验。

## 验收

使用当前 Vault 中已经确认保留的本地页面，恢复失败事务后重新预览并 Push；验证服务端发布成功、本地基线提交成功、再次预览零差异，且本地正文哈希不变。GitHub 发布和单元测试本身不代表该验收通过。

插件发布：<https://github.com/NeoMei/agentwiki-sync/releases/tag/0.5.5>。本地安装的 `main.js` 与 Release 一致，SHA-256：`760cd12f030f6d7ccecfed81c05ad1a3e15c1000fbd1b717e65f1b73dd3f13a6`。

## 服务端修复与回归

- 主项目修复提交 `f3ad6904`，发布提交 `fef97f18`，发布 <https://github.com/NeoMei/AgentWiki/releases/tag/v0.12.7>。
- 普通和批量 writer 均使用实体版本；批量 SQL 修复 `timestamptz` 转 `timestamp(3)` 在非 UTC 会话下的 8 小时偏移。
- 历史 token 兼容要求当前 head 未移动、请求 token 等于 head 快照 token、实体正文哈希/标题/路径/目录一致且实体时间早于快照；不修改旧快照。
- 服务端类型检查、构建、定向 lint 通过；79 项定向测试及 6 项真实 PostgreSQL 回归通过，数据库连接强制 Asia/Shanghai。全量 2,646 通过、10 失败、26 跳过，10 项 MCP mock 失败在未改的 v0.12.6 主仓也复现。
- 最终内容选择：用户明确选择 NeoMei-Docs 的空正文；测试 Vault 的另一份正文不作为此次上传来源。

## 生产与原生验收结果

- 生产版本 0.12.7；API、Worker、Frontend active，公网健康检查的数据库、Redis、审计持久化、附件存储均 ok。两个修复源文件 SHA-256 与发布候选一致。数据库和应用回滚备份已生成并验证。
- 当前真实验收库是 `NeoMei-Docs`，映射目录 `Wiki`。用户选择保留空正文后，通过插件面板“恢复已确认同步”成功发布 sequence 6，revision `cmugtrwqv0056hbtsa67osh5n`。
- Push journal 为 `remoteState=published`、`localCommitPhase=verified`。本地与云端正文均 0 字节，内容哈希均为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- Page 与新 snapshot 版本均为 `2026-09-25T10:35:49.999Z`；旧 snapshot 的 `2026-09-24T10:07:06.104Z` 保持不变。
- 再次打开 Obsidian 同步面板，明确显示“本地与服务器已同步，无需操作”“本地没有未推送的变更”“服务器没有新的变更”。
- 测试 Vault 的另一份正文未上传；本次以用户最终选择的 NeoMei-Docs 为验收对象。
