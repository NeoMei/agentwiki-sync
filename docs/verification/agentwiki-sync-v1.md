# AgentWiki Sync v1 验证记录

## 自动门禁

- `npm run lint`：TypeScript/JavaScript 静态检查。
- `npm run typecheck`：strict TypeScript，无 emit。
- `npm test`：协议 fixture、路径、Status、merge、storage、Pull、Push、连接和 fake remote E2E。
- `npm run build`：browser platform 单 bundle，`obsidian` external。
- `npm run check:bundle`：禁止 Node 文件系统/子进程、桌面 adapter 和秘密模式；检查发布版本一致性。

本轮收口结果（2026-08-14）：20 个测试文件、59 项测试全部通过；strict typecheck、ESLint、production build 与 714,059-byte bundle 安全检查通过。覆盖了 fixed-revision 分页、非法远端路径拒绝、connection exact replay、pageId rename、首次绑定冲突、Vault CAS、不可变 generation/current pointer、设备隔离、Push 发布后基线提交和响应丢失恢复。

## 客户端交付边界

插件客户端、Obsidian 原生安装/配置界面、人工设备凭据、Status/Pull/Push 编排及 fake AgentWiki 验收已经完成。客户端不会假装探测或兼容主项目的内部接口：服务端公开路由不存在时，连接会以结构化 HTTP 错误失败，不会上传未确认正文。

大正文仍通过 payload/generation 文件与 journal 元数据分离持久化；当前 fake Snapshot 适配器会在最终 preview 阶段物化正文数组。因此 32 MiB 峰值目标必须在上游发布流式分页协议包后执行真实设备 conformance/heap 验收，不能由小正文 fake 测试冒充完成。

## 外部依赖

截至 2026-08-14，npm registry 中不存在 `@neomei/agentwiki-sync-protocol`，AgentWiki 主项目也尚未实现契约中的 `/api/sync/v1` 与人类设备路由。真实服务端联调必须等待该独立上游交付；当前仓的 `src/agentwiki/protocol` 是严格局部兼容边界，服务端包发布后以 conformance tests 替换，不导入主项目内部源码。

所以“AgentWiki 服务端 API/数据库迁移”和“真实双端联调”不是本仓已经完成的功能，也不能在 AgentWiki 主项目只读约束下由本任务补写。它们是发布前唯一外部阻塞项。
