# Sync v2 页面版本一致性修复要求

日期：2026-09-25。状态：插件侧修复已发布，真实页面 Push 仍被服务端拒绝，尚未完成同步验收。

## 已验证现象

- 用户在 `Hello AgentWiki!` 内容冲突中选择保留本地。Pull 已提交，本地正文仍保留，Push 在 finalize 返回 HTTP 409 / `BASE_STALE` / `Document tree base is stale`。
- 当前 Obsidian 窗口为测试 Vault；磁盘曾是 0.5.4，运行时仍是 0.5.3。现已重新加载并确认运行 0.5.5。
- 插件 0.5.5 修复已有 Page/Folder 的 Push `updatedAt`：使用远端基线值，不能使用本地扫描时间。新增对象保持原流程。提交 `01da7a6`；1,397 项测试、类型检查、构建和发布检查通过。
- 0.5.5 的真实新推送仍返回同一个 409。当前服务端 head 与本地基线相同：`cmufdb3vd02k212csqgvx9oxs`，sequence 5。
- 此页同步标识为 `cmsiwqitz0008eci1a5r25uzz`。Sync v2 snapshot 的 `updatedAt` 是 `2026-09-24T10:07:06.104Z`，修复后推送准确携带这个值。
- 登录态网页正常 GET `/api/pages/cmsiwqitz0007eci1h89876qf` 返回 HTTP 200，实体的 `updatedAt` 是 `2026-09-24T10:07:05.965Z`。两个版本值相差 139 ms。
- 未改动服务端代码、数据库、部署状态或网页正文。SSH 的现有免交互登录返回 `Permission denied (publickey,password)`。

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
