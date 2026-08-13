# AgentWiki 项目上下文

本文档仅服务当前电脑上的 `AgentWiki-Obsidian` 项目，用于帮助开发 Agent 定位 AgentWiki 主项目并取得实现插件所需的稳定信息。AgentWiki 的实时状态以主项目 `.codex-memory/current.md` 和源码为准。

## 本地位置

- AgentWiki 产品代码：`/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`
- AgentWiki 项目记忆：`/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory`
- GitHub 主仓：`https://github.com/NeoMei/AgentWiki`

注意：本机 `AgentWiki ` 目录名末尾包含一个空格。shell 示例必须写成：

```bash
cd '/Users/neomei/项目/codexprojects/AgentWiki /agentwiki'
```

## 产品与技术基线

AgentWiki 是以 Space 为知识隔离、版本和同步边界的协作式知识平台。当前产品栈为：

- 前端：React、Vite、React Router
- 后端：NestJS
- 数据：Prisma、PostgreSQL
- 本地同步：`@neomei/agentwiki-local-sync`
- 远程 Agent 接入：Streamable HTTP MCP `/api/mcp`

版本号和当前发布状态会变化，不在本文档中固化；需要时读取主项目 `package.json` 和 `.codex-memory/current.md`。

## 主项目目录

- `apps/client/`：AgentWiki Web 前端
- `apps/server/`：NestJS API、认证、权限、知识流水线与同步端点
- `packages/shared/`：主项目内部共享类型与工具
- `packages/local-sync/`：本地知识采集、预览、冲突合并、同步客户端和 Agent gateway
- `docs/`：设计、运维、测试和验证文档
- `scripts/`：开发、部署及端到端验证脚本

## 插件集成相关入口

优先从以下位置理解已有同步契约，不要复制内部实现：

- `packages/local-sync/src/agentwiki-client.ts`：AgentWiki API 客户端和请求边界
- `packages/local-sync/src/protocol/sync.ts`：Snapshot、Delta、Conflict 等同步协议类型与校验
- `packages/local-sync/src/sync/sync-engine.ts`：Pull、Push、三方合并和本地状态推进
- `packages/local-sync/src/gateway/knowledge-workflows.ts`：预览、确认和知识同步工作流
- `apps/server/src/knowledge-pipeline/knowledge-revision.controller.ts`：Revision Snapshot 与 Delta 端点
- `apps/server/src/knowledge-pipeline/knowledge-sync.controller.ts`：知识同步状态与提交端点
- `apps/server/src/core/agent/local-sync-installation.service.ts`：本地同步接入与安装凭据交换

路径相对于 `/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`。

## 稳定架构边界

- Space 是知识隔离、版本和同步的最小边界，同一 Space 只有一套统一 Wiki。
- 服务端 Revision 是权威版本；本地 Vault 只是可编辑、可恢复的副本。
- Push 前必须 Pull；同字段冲突使用 base/local/remote 三方合并提案，禁止静默覆盖和 last-write-wins。
- Source → SourceVersion → IngestRun → Artifact/Evidence → ChangeSet/Approval → Page/Relation 是权威知识生产链。
- Agent 内容写入进入 ChangeSet，只有审核接受后才发布；Agent 不能自行批准 ChangeSet。
- Agent 权限是 Credential Scope、Space Grant、Agent 状态和 Space Policy 的交集。
- 原始代码、原始文件、本地凭据和原始 Agent Memory 数据库不上传；本地先做整理、冲突处理和敏感信息检查。

## Obsidian 插件约束

- 插件仓库与 AgentWiki 主仓独立发布、独立版本化。
- 插件通过公开 HTTP API、同步协议或未来公开 SDK 访问 AgentWiki，不直接导入 NestJS 服务或 `packages/local-sync` 的内部文件。
- 若需要复用协议类型，应优先推动 AgentWiki 发布稳定契约包，而不是在插件仓库复制源码。
- 服务地址必须可配置；不得把生产地址、凭据或设备授权码写入源码。
- 自动同步前必须有清晰预览；删除、覆盖和冲突解决必须保持显式确认。
- 开发和测试不得使用用户的主 Vault，使用独立测试 Vault。

## 工作方式

1. 先读本文件了解稳定边界。
2. 再读 `.codex-memory/current.md` 获取当前版本和活跃状态。
3. 按任务读取架构、同步规则以及相关源码和测试。
4. 发现插件需要主项目改动时，在插件项目先记录 API 契约与影响，不直接跨仓实现。

## 信息安全

不得把以下信息复制到本项目：

- 生产服务器登录信息和部署密码
- 用户、Agent 或 MCP 的访问令牌
- 数据库连接串、备份地址和未脱敏日志
- 用户 Vault 原始内容及未经确认的本地文件
