# AgentWiki Sync v1 验证记录

## 自动门禁

- `npm run lint`：TypeScript/JavaScript 静态检查。
- `npm run check:format`：Prettier 格式一致性检查。
- `npm run typecheck`：strict TypeScript，无 emit。
- `npm test`：协议 fixture、路径、Status、merge、storage、Pull、Push、连接和 fake remote E2E。
- `npm run build`：browser platform 单 bundle，`obsidian` external。
- `npm run check:bundle`：禁止 Node 文件系统/子进程、桌面 adapter 和秘密模式；检查发布版本一致性。

最新收口结果（2026-08-19）：29 个测试文件、147 项测试全部通过；Prettier 格式检查、Obsidian 官方 ESLint 推荐规则（0 error）、strict typecheck、production build 与 bundle/release 安全检查通过。覆盖 fixed-revision 分页、非法远端路径拒绝、connection exact replay、pageId/case-only rename、首次绑定和普通冲突、Vault CAS 与回滚故障点、不可变 generation/current pointer、设备隔离、Push 发布后指标验证、响应丢失恢复、凭据轮换 supersede 与设备本地状态 envelope 迁移；另覆盖多 Space 选择/去重、只读 Pull 权限、进度与取消边界、纯归档批量让步、取消上传时先持久化不可重放状态再 abort 远端 session、上传异常与取消竞态下仍保证 supersede 且不可恢复、取消后可安全断开且本地变更保留、UI 交互纯逻辑、Obsidian 适配器契约、协议 conformance、多代 generation 清理、市场设置标题规则、回收站偏好和近 100 MiB 有界内存验收。

## 客户端交付边界

插件客户端、Obsidian 原生安装/配置界面、人工设备凭据、Status/Pull/Push 编排及 fake AgentWiki 验收已经完成。客户端不会假装探测或兼容主项目的内部接口：服务端公开路由不存在时，连接会以结构化 HTTP 错误失败，不会上传未确认正文。

大正文通过下载、Pull result/snapshot/conflict、generation base 与 Push payload sidecar 分离持久化；Snapshot HTTP 客户端按固定 revision 分页生成，运行时只保留页面元数据并按 pageId 读取正文，journal 不内嵌正文。自动门禁以 5,000 页、接近 100 MiB 正文验证流式扫描额外 heap 小于 32 MiB；真实移动设备仍需在上游 API 发布后做 conformance smoke，但不再是客户端结构性缺口。设置页与预览弹窗的失败反馈、离线本地断开、预览产物隔离和 pending identity 严格校验已在本轮收口。

## 上游与联调状态

AgentWiki 主项目三项交付已合并并发布：`@neomei/agentwiki-sync-protocol@0.1.0`、人类设备身份与 `/api/sync/v1`，生产 `agentwiki.quukk.com` 已部署（应用提交 `626af9d`）。插件侧已安装该协议包，新增 conformance 测试验证本地兼容边界与发布包的 canonical、content/confirmation/batch/revision hash、portable path key 与 decimal 解析逐字节一致。

联调发现并修复了 `revisionContentHash` 的跨边界差异：发布包的 `RevisionContentManifest` 包含 `protocolVersion` 与 `spaceId`，插件本地副本此前只有 `pages`，会导致客户端重建的 revision hash 与服务端不一致。现已补齐并统一 `revisionManifestByteLength` 的输入；默认 `maxPageItems` 也对齐到服务端公布的 `100`。

协议一致性已通过 conformance 固化，API 路径、Bearer 凭据认证与 exchange 请求格式均与主项目实现核对一致。真实生产写入联调需要一次性连接码、用户数据清理和生产变更授权，因此作为独立发布验收，不属于当前仓库未完成的实现任务。
