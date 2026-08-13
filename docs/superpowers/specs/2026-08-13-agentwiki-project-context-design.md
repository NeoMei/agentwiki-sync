# AgentWiki 项目上下文落盘设计

## 目标

让在 `AgentWiki-Obsidian` 目录中工作的 Codex 或其他开发 Agent，能够在当前电脑上直接定位 AgentWiki 主项目，按正确顺序读取权威信息，并在实现插件时遵守 AgentWiki 的同步、权限和数据安全边界。

## 文件结构

采用双文件结构：

- 根目录 `AGENTS.md`：保存工作规则、主项目绝对路径、必读顺序和跨仓修改边界。内容保持简短，以便 Agent 每次进入项目时自动获得关键约束。
- `docs/agentwiki-context.md`：保存 AgentWiki 的产品定位、技术栈、目录结构、权威文档索引、插件相关源码入口、同步语义、权限模型和安全边界。

## 主项目定位

当前电脑上的 AgentWiki 产品代码固定定位为：

`/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`

路径中的 `AgentWiki ` 目录名末尾包含一个空格，文档中的命令示例必须使用完整引号，避免路径被错误解析。

AgentWiki 项目级结构化记忆位于其父级仓库：

`/Users/neomei/项目/codexprojects/AgentWiki /.codex-memory`

## 必读顺序

插件项目需要主项目信息时，按以下顺序读取：

1. `.codex-memory/current.md`
2. `.codex-memory/spec/index.md`
3. `.codex-memory/spec/agentwiki-architecture.md`
4. `.codex-memory/spec/local-knowledge-sync.md`
5. 按具体任务读取 `agentwiki/docs/`、相关源码和测试

默认不读取 `.codex-memory/archive/`；只有追溯历史或当前信息不足时才按需读取。

## 上下文内容边界

`docs/agentwiki-context.md` 只记录对 Obsidian 插件长期有用的信息：

- AgentWiki 是 Space 隔离的协作式知识平台。
- 当前产品栈为 React/Vite、NestJS、Prisma/PostgreSQL。
- 插件通过公开 API、稳定同步协议或未来公开 SDK 集成，不直接依赖 AgentWiki 内部服务实现。
- 服务端 Revision 是权威版本；Push 前 Pull，冲突使用 base/local/remote 三方合并，禁止静默覆盖。
- Agent 权限由 Credential Scope、Space Grant、Agent 状态和 Space Policy 共同限制。
- 原始本地文件、凭据和未审查内容不得被插件自动上传。
- 破坏性变更和 Agent 产生的内容写入继续遵守 ChangeSet 与人工审核规则。

文档不复制生产凭据、访问令牌、部署密码或仅适用于一次发布的状态信息。

## 跨仓工作规则

- AgentWiki 主项目默认为只读参考源。
- 在插件项目任务中，不得未经用户明确授权修改 AgentWiki 主项目。
- 需要主项目配合的 API 或协议变更，应先在插件项目中记录需求和影响，再由独立任务处理主项目修改。
- 不从主项目复制容易漂移的实现代码；优先引用公开契约、类型定义或已发布包。

## 验证方式

落盘后需要验证：

1. 两个文件都能从插件项目根目录发现。
2. 文档中的两个绝对路径真实存在。
3. 所列四份权威记忆文件均可读取。
4. `AGENTS.md` 能引导 Agent 找到详细上下文文档。
5. 文档不包含秘密信息、占位符或互相矛盾的路径。

## 不在本次范围

- 不初始化 Git 仓库。
- 不搭建 Obsidian 插件代码。
- 不修改 AgentWiki 主项目。
- 不设计插件功能、认证界面或发布流程。
