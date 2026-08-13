# AgentWiki Project Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 AgentWiki-Obsidian 根目录建立一套仅服务当前电脑的项目说明，让开发 Agent 能定位并正确读取 AgentWiki 主项目，同时遵守跨仓与数据安全边界。

**Architecture:** 根目录 `AGENTS.md` 只承载自动生效的工作指令和读取入口，详细且可能扩展的 AgentWiki 背景放入 `docs/agentwiki-context.md`。两个文件使用当前电脑的绝对路径；AgentWiki 主项目保持只读，插件通过公开 API、同步协议或已发布包集成。

**Tech Stack:** Markdown、Codex `AGENTS.md` 项目指令、AgentWiki `.codex-memory`

## Global Constraints

- 当前 AgentWiki 产品代码路径固定为 `/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`。
- 当前 AgentWiki 项目记忆路径固定为 `/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory`。
- `AgentWiki ` 目录名末尾包含一个空格，所有 shell 引用必须使用完整单引号。
- AgentWiki 主项目默认只读；未经用户明确授权不得跨仓修改。
- 不复制生产凭据、令牌、部署密码或一次性发布状态。
- 不初始化 Git，不搭建插件代码，不修改 AgentWiki 主项目。

---

### Task 1: 建立插件项目的 AgentWiki 上下文入口

**Files:**
- Create: `AGENTS.md`
- Create: `docs/agentwiki-context.md`
- Reference: `docs/superpowers/specs/2026-08-13-agentwiki-project-context-design.md`

**Interfaces:**
- Consumes: 当前电脑上的 AgentWiki 主项目、`.codex-memory` 权威文档和 AgentWiki 公开集成边界。
- Produces: Codex 自动读取的根级项目指令，以及供插件开发按需读取的 AgentWiki 详细上下文。

- [ ] **Step 1: 创建根级 `AGENTS.md`**

使用以下完整内容创建 `AGENTS.md`：

```markdown
# Project Instructions

## 沟通与执行

- 默认使用中文沟通，先给结论，再给必要步骤。
- 本项目是独立的 AgentWiki Obsidian 插件项目。
- 优先采用最直接、可验证的实现；不要复制 AgentWiki 主项目中容易漂移的内部实现。

## AgentWiki 主项目

- 产品代码绝对路径：`/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`
- 项目记忆绝对路径：`/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory`
- `AgentWiki ` 目录名末尾包含一个空格；在 shell 命令中必须用单引号包住完整路径。
- 开始涉及 AgentWiki 接口、同步、权限或数据模型的任务前，先完整阅读 `docs/agentwiki-context.md`。

## 权威信息读取顺序

需要核对 AgentWiki 当前状态时，依次读取：

1. `/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/current.md`
2. `/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/index.md`
3. `/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/agentwiki-architecture.md`
4. `/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/local-knowledge-sync.md`
5. 按任务需要读取 `/Users/neomei/项目/codexprojects/AgentWiki /agentwiki/docs/`、相关源码和测试

默认不要读取 `.codex-memory/archive/`；只有追溯历史或当前信息不足时才按需查阅。

## 跨仓边界

- AgentWiki 主项目默认只读。未经用户明确授权，不得修改主项目文件、配置、数据库或部署状态。
- 需要主项目新增 API 或修改协议时，先在本项目记录需求、契约和影响，再通过独立任务处理主项目。
- 插件只依赖公开 API、稳定同步协议、公开类型或已发布包，不直接导入主项目内部服务代码。
- 不读取、复制或提交主项目中的凭据、访问令牌、部署密码及其他秘密信息。
- 原始本地文件、凭据和未审查内容不得被插件自动上传。
```

- [ ] **Step 2: 创建 `docs/agentwiki-context.md`**

使用以下完整内容创建 `docs/agentwiki-context.md`：

```markdown
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
```

- [ ] **Step 3: 验证文件内容与本机路径**

运行：

```bash
test -f AGENTS.md
test -f docs/agentwiki-context.md
test -d '/Users/neomei/项目/codexprojects/AgentWiki /agentwiki'
test -f '/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/current.md'
test -f '/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/index.md'
test -f '/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/agentwiki-architecture.md'
test -f '/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory/spec/local-knowledge-sync.md'
```

Expected: 命令退出码为 `0`，没有输出。

- [ ] **Step 4: 检查占位符、秘密模式和跨仓误改**

运行：

```bash
if rg -n '\b(TBD|TODO)\b|待定|<placeholder>' AGENTS.md docs/agentwiki-context.md; then exit 1; fi
if rg -ni 'BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|password\s*[:=]|token\s*[:=]|secret\s*[:=]' AGENTS.md docs/agentwiki-context.md; then exit 1; fi
test ! -d .git
```

Expected: 命令退出码为 `0`，没有输出；插件目录仍未初始化 Git。

- [ ] **Step 5: 人工核对职责边界**

逐项确认：

- `AGENTS.md` 只包含自动生效的工作指令、读取顺序和跨仓边界。
- `docs/agentwiki-context.md` 包含产品背景、源码入口、同步语义、权限和安全约束。
- 两个文件都明确记录目录名末尾空格，并使用完整绝对路径。
- 两个文件没有包含主项目的生产秘密或一次性发布状态。
- 没有创建 `.git`，没有修改 AgentWiki 主项目。

Expected: 五项全部满足。
