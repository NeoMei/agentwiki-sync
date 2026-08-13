# AgentWiki Sync

AgentWiki Sync 是一个移动端兼容的 Obsidian 社区插件，用 Git 风格的 Status、Pull、Push 将映射目录与 AgentWiki Space 同步。

## 当前状态

插件核心、事务恢复、原生 UI 和公开 API 客户端已实现。AgentWiki 服务端的人类设备同步 API v1 与 `@neomei/agentwiki-sync-protocol` 仍未发布，因此当前版本默认不会把连接码发送到不支持该契约的服务端。仓库使用独立 fake AgentWiki 验证端到端客户端流程，不复制 AgentWiki 主项目内部实现。

## 开发

要求 Node.js 24 LTS：

```bash
npm ci
npm run check
```

产物为 `main.js`、`manifest.json`、`styles.css`。开发和测试只能使用独立测试 Vault。

## 安全边界

- 插件只在用户执行连接、Status、Pull、Push 时联网。
- Push 必须先确认预览，远端 head 领先时被阻止。
- credential 与连接码只进入 Obsidian Secret Storage，不进入 Vault 或诊断。
- `.agentwiki/` 控制状态按 device/space 隔离，通过 DataAdapter 相对路径访问；基线采用不可变 generation + current pointer，不使用 Node `fs` 或桌面专属 API。
- 所有远端 Markdown 路径须先通过 NFC/casefold 可移植路径校验，Vault 适配器写入时再次执行 mapping-root containment。
- Secret Storage 不防御用户主动安装的恶意 Obsidian 插件。
