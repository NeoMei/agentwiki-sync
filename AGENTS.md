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
