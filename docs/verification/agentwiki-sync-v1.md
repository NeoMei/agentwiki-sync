# AgentWiki Sync v1 验证记录

## 自动门禁

- `npm run lint`：TypeScript/JavaScript 静态检查。
- `npm run typecheck`：strict TypeScript，无 emit。
- `npm test`：协议 fixture、路径、Status、merge、storage、Pull、Push、连接和 fake remote E2E。
- `npm run build`：browser platform 单 bundle，`obsidian` external。
- `npm run check:bundle`：禁止 Node 文件系统/子进程、桌面 adapter 和秘密模式；检查发布版本一致性。

## 外部依赖

截至 2026-08-14，npm registry 中不存在 `@neomei/agentwiki-sync-protocol`，AgentWiki 主项目也尚未实现契约中的 `/api/sync/v1` 与人类设备路由。真实服务端联调必须等待该独立上游交付；当前仓的 `src/agentwiki/protocol` 是严格局部兼容边界，服务端包发布后以 conformance tests 替换，不导入主项目内部源码。
