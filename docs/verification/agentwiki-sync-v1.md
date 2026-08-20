# AgentWiki Sync v1 验证记录

## 自动门禁

- `npm run lint`：TypeScript/JavaScript 静态检查。
- `npm run check:format`：Prettier 格式一致性检查。
- `npm run typecheck`：strict TypeScript，无 emit。
- `npm test`：协议 fixture、路径、Status、merge、storage、Pull、Push、连接和 fake remote E2E。
- `npm run build`：browser platform 单 bundle，`obsidian` external。
- `npm run check:bundle`：禁止 Node 文件系统/子进程、桌面 adapter 和秘密模式；检查发布版本一致性。

最新收口结果（2026-08-20，0.2.8）：先执行 `npm ci --ignore-scripts`（新增 375 个 package，0 vulnerability），再执行 `npm run check`。结果为 **30 个测试文件、166 项测试全部通过**；Prettier 通过；Obsidian 官方 ESLint **0 error / 13 个已知 warning**；strict typecheck、production build、bundle safety 和 release metadata 全部通过。bundle safety 记录为 `850506 bytes`，release metadata 确认 `0.2.8`；`git diff --check` 通过。

0.2.8 新增覆盖：库级 schema-v2 映射持久化、0.2.7 local envelope 一次性迁移、重启/禁用启用/无连接/有连接生命周期、v2 对陈旧损坏 envelope 的权威性、敏感身份不进入 `data.json`、缺失/非目录映射根阻断且不删映射、opaque → 标题路径 rename、双向改名 path conflict、`标题.md` / `标题 (2).md` 同时落地，以及正文哈希和 Markdown H1 保留。

真实 Obsidian 桌面验收使用 Obsidian 1.13.7、独立用户数据目录和临时 Vault `/tmp/agentwiki-obsidian-acceptance.cq2VM4/vault`，安装的 `main.js`、`manifest.json`、`styles.css` 与本分支发布产物逐字节相同。插件 0.2.8 成功加载 schema-v2 映射；禁用后重新启用、完整退出后重新启动，`acceptance-space → Wiki` 映射仍保持 `active`。将 `Wiki` 临时改名后，设置页显示“本地文件夹缺失，请重新创建或更改映射”，而 `data.json` 仍保留映射；恢复目录名后提示消失。用户 Vault `/Users/neomei/Obsidian/NeoMei-Docs` 未触碰。

## 客户端交付边界

插件客户端、Obsidian 原生安装/配置界面、人工设备凭据、Status/Pull/Push 编排及 fake AgentWiki 验收已经完成。客户端不会假装探测或兼容主项目的内部接口：服务端公开路由不存在时，连接会以结构化 HTTP 错误失败，不会上传未确认正文。

大正文通过下载、Pull result/snapshot/conflict、generation base 与 Push payload sidecar 分离持久化；Snapshot HTTP 客户端按固定 revision 分页生成，运行时只保留页面元数据并按 pageId 读取正文，journal 不内嵌正文。自动门禁以 5,000 页、接近 100 MiB 正文验证流式扫描额外 heap 小于 32 MiB；真实移动设备仍需在上游 API 发布后做 conformance smoke，但不再是客户端结构性缺口。设置页与预览弹窗的失败反馈、离线本地断开、预览产物隔离和 pending identity 严格校验已在本轮收口。

## 上游与联调状态

AgentWiki 主项目三项交付已合并并发布：`@neomei/agentwiki-sync-protocol@0.1.0`、人类设备身份与 `/api/sync/v1`，生产 `agentwiki.quukk.com` 已部署（应用提交 `626af9d`）。插件侧已安装该协议包，新增 conformance 测试验证本地兼容边界与发布包的 canonical、content/confirmation/batch/revision hash、portable path key 与 decimal 解析逐字节一致。

联调发现并修复了 `revisionContentHash` 的跨边界差异：发布包的 `RevisionContentManifest` 包含 `protocolVersion` 与 `spaceId`，插件本地副本此前只有 `pages`，会导致客户端重建的 revision hash 与服务端不一致。现已补齐并统一 `revisionManifestByteLength` 的输入；默认 `maxPageItems` 也对齐到服务端公布的 `100`。

协议一致性已通过 conformance 固化，API 路径、Bearer 凭据认证与 exchange 请求格式均与主项目实现核对一致。真实生产写入联调需要一次性连接码、用户数据清理和生产变更授权，因此作为独立发布验收，不属于当前仓库未完成的实现任务。

0.2.8 可读路径的服务端伴随分支为 `codex/readable-sync-paths`，验证记录 HEAD `13f9fbb`；其仓库矩阵为 1,173 pass / 40 个明确 DB skip / 0 fail，typecheck、lint、build 与 diff-check 通过。随后在本机 PostgreSQL 16 的明确命名临时库 `agentwiki_codex_readable_sync_20260820_01` 上补跑 31 个真实 DB 同步/迁移门禁，结果为 **31 pass / 0 skip / 0 fail**，包含真实 Prisma、Redis、HTTP、并发、5,000 页及 100 MiB 边界；测试库已删除并确认不存在。服务端分支仍未合并、未迁移生产数据库、未部署。

## 0.2.8 跨仓收口与发布门

- 插件分支：`codex/durable-mappings-0.2.8`，最终行为 HEAD `b87e23bbc4a4`（后续仅更新验证记录）。
- 服务端分支：`codex/readable-sync-paths` @ `13f9fbbb6aa5c96e7a0a89e33a6a947a22acebaf`。
- 本地构建插件 manifest 版本：`0.2.8`。`main.js` 实际文件大小 `850787` bytes，SHA-256 `edcc88e798d2b1ec349b7a447317be8e2ad08485918ed657580820612d59c685`；`manifest.json` SHA-256 `6a909133ff02ab97e8aa71943f0fc08d7ac4b3c69bbc40e9d06bab6b7591e5a7`。`check-bundle.mjs` 按 JavaScript string length 记录 `850506`。
- 需求→代码审查通过：Vault schema-v2 映射持久化、0.2.7 迁移、连接身份分离、缺失根目录保留映射、canonical rename/path conflict、正文/H1 保留和 0.2.8 元数据均有定向或全量自动证据。
- 状态机/数据迁移/恢复二次审查找到并修正了服务端首个 migration revision 遗漏未改名页、O(n²) 路径查询与默认事务超时、以及标题本身等于 `p-<64 hex>` 时的幂等失效；最终静态审查未发现新的 Critical/Important。

以下门禁尚未完成，因此当前结论仍是 **不发布**：

1. 真实 Obsidian 已完成发布产物加载、重启、禁用/启用和缺失/恢复映射根目录矩阵；尚未完成一次性连接码、双重名 Web 页 Pull、Web 改标题、双向改名冲突和离线恢复的真实 UI 联调。原因是发布包按安全契约只接受 HTTPS，而隔离服务仅有 localhost HTTP；本轮没有安装测试 CA、绕过证书校验或使用生产数据。
2. `requesting-code-review` 独立子代理复审因账户 usage limit 失败；非原生备用模型无法解密 worker task。已完成两轮主任务差异审查，但不将其冒充为独立审查。

未执行 merge/cherry-pick、生产 DB 迁移、部署、npm/GitHub Release/tag/push、用户 Vault 安装、Obsidian preview scan 或市场提交。上述每项都需独立授权。
