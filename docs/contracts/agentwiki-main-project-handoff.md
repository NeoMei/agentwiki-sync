# AgentWiki 主项目交付清单

本文档是从插件仓库交付给 AgentWiki 主项目的实施入口。完整契约见 `docs/contracts/agentwiki-obsidian-sync-api-v1.md`，本文只做索引与顺序说明，不重复字段级细节。

## 结论

插件当前不能接入真实 AgentWiki，主项目需要在独立任务中交付三项内容，按依赖顺序为：浏览器协议包、人类设备身份、sync v1 API 与数据库迁移。三项都完成后，插件仓库用已发布协议包替换本地兼容副本，并执行真实双端 E2E。

## 交付物 1：浏览器兼容协议包

- npm 包名固定为 `@neomei/agentwiki-sync-protocol`。
- 必须提供浏览器 ESM、TypeScript 类型和运行时 Schema，不得依赖 Node 内置模块，不得发起网络请求或保存凭据。
- 导出的稳定符号与 `canonical serialization`、`contentHash`、`revisionContentHash`、`confirmationHash`、`batchHash`、`capabilitiesHash`、`pathKey`、`parseDecimalCount` 的规则以契约第 2、3 节为准。
- 验收基准是契约 3.5 的固定 hash fixture 和 17.3 的 API 契约测试。

插件侧替换点：`src/agentwiki/protocol/` 目前是严格局部兼容副本，协议包发布后改为 package 依赖，并用 conformance tests 替换当前 fake public contract。

## 交付物 2：人类设备身份

- 一次性连接码的创建、交换为人类设备凭据、设备会话查询/激活/撤销，以及用户端设备管理。
- 契约第 6、7、8 节定义字段、状态机和崩溃恢复语义。
- 关键安全边界：凭据代表创建安装码的人类用户而非 Agent；每台设备独立交换、独立撤销、独立审计；provisional 凭据最长 10 分钟；`credentialFamilyId` 用于轮换后同 family 的 exact replay 恢复；`AgentCredential` 不得调用人类设备直接发布路径。

## 交付物 3：sync v1 API 与数据库迁移

- 路由：Space 列表与能力、Revision head、分页 Snapshot、分页 Delta、Push session（create/upload/finalize/query/abort）。
- 数据模型：规范化 Page rows、`pathKey` 唯一约束、按 revision 的 sidecar 与 content blob、`DecimalCount`/`DecimalByteCount` bigint 指标、head 永不被 retention 清理、keyset cursor。
- 发布语义：`SpaceRevisionWriter` 统一推进 revision；finalize 创建来源为 `obsidian_sync` 且状态直接为 `published` 的 ChangeSet，不经过二次审核，也不授予一般审核权限。
- 兼容迁移：契约 5.2 的 Release A（双写与 backfill）/ Release B（contract，允许 legacy JSON 为 null）顺序必须遵守，旧 local-sync Snapshot/Delta 语义不得被静默改变。

## 实施顺序与跨仓边界

1. 先发布协议包，插件仓库可独立完成替换与 conformance。
2. 再实现人类设备身份，插件可独立联调连接与凭据恢复。
3. 最后实现 sync v1 与数据库迁移（Release A 后回归、再 Release B）。
4. 三项都在 AgentWiki 主项目建立独立设计、计划、测试和发布任务；插件仓库保持只读，不复制主项目 controller、service、Prisma 类型或 local-sync 内部实现。

主项目最终路由或字段如需调整，必须先更新本契约文件并同步在插件仓库明确版本迁移影响。
