# AgentWiki Sync v1 验证记录

## 自动门禁

- `npm run lint`：TypeScript/JavaScript 静态检查。
- `npm run check:format`：Prettier 格式一致性检查。
- `npm run typecheck`：strict TypeScript，无 emit。
- `npm test`：协议 fixture、路径、Status、merge、storage、Pull、Push、连接和 fake remote E2E。
- `npm run build`：browser platform 单 bundle，`obsidian` external。
- `npm run check:bundle`：禁止 Node 文件系统/子进程、桌面 adapter 和秘密模式；检查发布版本一致性。

最新插件行为收口结果（2026-08-20，0.2.8）：先执行 `npm ci --ignore-scripts`（新增 375 个 package，0 vulnerability），再执行 `npm run check`。插件行为 HEAD 的结果为 **30 个测试文件、168 项测试全部通过**；Prettier 通过；Obsidian 官方 ESLint **0 error / 13 个已知 warning**；strict typecheck、production build、bundle safety 和 release metadata 均通过。服务端完成干净集成（merge commit `2cde6fb`）后，controller 已重新执行完整 `npm run check` 并全部通过（bundle safety 报告 850,682 bytes；release metadata 0.2.8）。当前发布产物指纹：`main.js` 850,963 bytes，SHA-256 `0995a05c8420ff4bab28302343e6b81add509439d0cb475b21b06d1c764349f5`；`manifest.json` 232 bytes，SHA-256 `6a909133ff02ab97e8aa71943f0fc08d7ac4b3c69bbc40e9d06bab6b7591e5a7`；`styles.css` 1,537 bytes，SHA-256 `bfce26fc2e0183c7e43849a7e5d7d59a4e7f50b54c5c57dd7be609f6a0a3ff7a`。

0.2.8 新增覆盖：库级 schema-v2 映射持久化、0.2.7 local envelope 一次性迁移、重启/禁用启用/无连接/有连接生命周期、v2 对陈旧损坏 envelope 的权威性、敏感身份不进入 `data.json`、缺失/非目录映射根阻断且不删映射、opaque → 标题路径 rename、双向改名 path conflict、`标题.md` / `标题 (2).md` 同时落地，以及正文哈希和 Markdown H1 保留。

真实 Obsidian 桌面验收使用 Obsidian 1.13.7、独立用户数据目录和临时 Vault `/tmp/agentwiki-obsidian-acceptance.cq2VM4/vault`，安装的 `main.js`、`manifest.json`、`styles.css` 与本分支发布产物逐字节相同。插件 0.2.8 成功加载 schema-v2 映射；禁用后重新启用、完整退出后重新启动，`acceptance-space → Wiki` 映射仍保持 `active`。将 `Wiki` 临时改名后，设置页显示“本地文件夹缺失，请重新创建或更改映射”，而 `data.json` 仍保留映射；恢复目录名后提示消失。

真实 HTTPS Obsidian 验收使用受信任的临时 localhost CA 和隔离数据库完成。两篇同名页面首次 Pull 后本地状态为零变更；规范 `(2)` 后缀未产生标题 Push。真实本地改名仍产生 path/title upsert；远端改名保持正文并重命名本地文件；双端改名进入显式 path conflict；离线时映射保留，服务恢复后状态可重新加载。验收后临时 CA、数据库、监听进程和活动测试目录均已清理。本轮所有启动参数、CDP target 和文件操作都指向隔离 profile/Vault；结束前对隔离进程执行 `lsof -p 31811`，未发现 `/Users/neomei/Obsidian/NeoMei-Docs` 路径句柄。这是一项结束时的有限只读证据，不单独证明整个运行期间的全部系统活动。

## 客户端交付边界

插件客户端、Obsidian 原生安装/配置界面、人工设备凭据、Status/Pull/Push 编排及 fake AgentWiki 验收已经完成。客户端不会假装探测或兼容主项目的内部接口：服务端公开路由不存在时，连接会以结构化 HTTP 错误失败，不会上传未确认正文。

大正文通过下载、Pull result/snapshot/conflict、generation base 与 Push payload sidecar 分离持久化；Snapshot HTTP 客户端按固定 revision 分页生成，运行时只保留页面元数据并按 pageId 读取正文，journal 不内嵌正文。自动门禁以 5,000 页、接近 100 MiB 正文验证流式扫描额外 heap 小于 32 MiB；真实移动设备仍需在上游 API 发布后做 conformance smoke，但不再是客户端结构性缺口。设置页与预览弹窗的失败反馈、离线本地断开、预览产物隔离和 pending identity 严格校验已在本轮收口。

## 上游与联调状态

AgentWiki 主项目三项交付已合并并发布：`@neomei/agentwiki-sync-protocol@0.1.0`、人类设备身份与 `/api/sync/v1`，生产 `agentwiki.quukk.com` 已部署（应用提交 `626af9d`）。插件侧已安装该协议包，新增 conformance 测试验证本地兼容边界与发布包的 canonical、content/confirmation/batch/revision hash、portable path key 与 decimal 解析逐字节一致。

联调发现并修复了 `revisionContentHash` 的跨边界差异：发布包的 `RevisionContentManifest` 包含 `protocolVersion` 与 `spaceId`，插件本地副本此前只有 `pages`，会导致客户端重建的 revision hash 与服务端不一致。现已补齐并统一 `revisionManifestByteLength` 的输入；默认 `maxPageItems` 也对齐到服务端公布的 `100`。

协议一致性已通过 conformance 固化，API 路径、Bearer 凭据认证与 exchange 请求格式均与主项目实现核对一致。真实生产写入联调需要一次性连接码、用户数据清理和生产变更授权，因此作为独立发布验收，不属于当前仓库未完成的实现任务。

`13f9fbb` 是可读路径实现链上的历史祖先，不再代表最终服务端候选。原服务端分支 `codex/readable-sync-paths` 当前仍停在 `294b694`；它在 Fix 3 之前完成过扩展真实 PostgreSQL 门禁 **32 pass / 0 skip / 0 fail**（更早的明确命名临时库为 31/31），测试 schema/数据库均按当次记录清理。

Fix 3A/3B/3C 及 post-completion follow-up 曾只存在于临时仓 `codex/final-readiness-fixes`（产品行为 HEAD `961c8eb`、docs evidence HEAD `b09ac37`）。该候选已与当前主干 `origin/master`（`647c7f8`）在干净集成分支 `codex/integrate-readable-sync-paths` 完成语义合并，merge commit 为 `2cde6fb`（父提交 `647c7f8` + `b09ac37`）：归档来源页恢复/回滚与可读路径分配、共享 Space 锁、PageVersion 快照、乐观 CAS、审计 provenance 和 fail-closed revert 校验两侧语义同时保留。集成后的 fresh 门禁全部通过：真实 PostgreSQL runtime 为 **122 pass / 1 个需显式授权的外部 CodeGraph skip / 0 fail**（此前 41 个 DB skip 全部实跑通过，测试 schema 清理后残留为 0）；完整 server Jest 为 **61 suites / 647 tests** 全过（含此前因沙箱 `EPERM` 阻塞的四个 loopback HTTP suites）；客户端 203/203、协议 22/22、本地同步 718/718；根 typecheck、配置 lint 与完整多包 build 均通过；独立语义复审结论 **Ready: Yes**（0 Critical / 0 Important / 0 Minor）。completed-batch retry/original-revision 契约与 CLI 聚合单复数行为继续保有定向覆盖。

语义合并已在干净本地集成分支完成；含 48 项未提交修改的原主工作区未被触碰。未推送远端、未迁移生产数据库、未部署。

## 0.2.8 跨仓收口与发布门

- 插件分支：`codex/durable-mappings-0.2.8`。产品行为 HEAD 仍为 `83a437690e3fd304f6471e314f2e19b818c73e1a`；本次证据对账前的文档 HEAD 为 `662b712`，其后改动仍仅限验证记录。
- 服务端权威候选：干净集成分支 `codex/integrate-readable-sync-paths`，merge commit `2cde6fb`（父提交 `647c7f8` + `b09ac37`）。历史链路：原分支 `codex/readable-sync-paths` HEAD `294b694`；临时候选 `codex/final-readiness-fixes` HEAD `961c8eb` / docs `b09ac37`。
- 服务端集成 Git bundle 已重建为 `.superpowers/sdd/agentwiki-integration-647c7f8..2cde6fb.bundle`（88,902 bytes）。`git bundle verify` 确认包含 ref `refs/heads/codex/integrate-readable-sync-paths @ 2cde6fb`，prerequisites 为 `647c7f8` 与 `8ae615c`（两者均在当前主干历史内，目标仓库具备当前 master 即可解开）；SHA-256 为 `f673fcde5b63aeeaf219f45cbb79109cba02225d8cb5928680a7e8fd9eda8312`。旧 `294b694..b09ac37` bundle 保留为历史制品；该 ignored 本地 bundle 不是 Obsidian 插件发布产物。
- 需求→代码审查通过：Vault schema-v2 映射持久化、0.2.7 迁移、连接身份分离、缺失根目录保留映射、canonical rename/path conflict、正文/H1 保留和 0.2.8 元数据均有定向或全量自动证据。
- 状态机/数据迁移/恢复审查先后修正了服务端首个 migration revision 遗漏未改名页、O(n²) 路径查询与默认事务超时、不同 hash 的 opaque-looking 标题幂等失效、已完成固定 batch 被新增 opaque-looking 页面重新打开、restore/reorder 同毫秒竞争及 2,000 次顺序写风险、archive CAS/审计 provenance、revert 字段白名单/无效日期/空更新假成功。定向回归在集成分支全部通过，且此前缺失的真实 PostgreSQL 与 loopback HTTP 证据已在上文集成门禁中补齐。

跨仓技术门禁已全部关闭；以下发布动作尚未执行，当前结论仍是 **不发布（待授权）**：

1. 远端状态复核与推送：当前沙箱无法解析 GitHub（`ls-remote` 被 DNS 阻断），须在可联网环境确认 `origin/master` 仍为 `647c7f8` 后，再授权推送 `2cde6fb`。
2. 生产发布：先完成只读预检（migration 状态、数据量、磁盘/备份空间），再做经过恢复验证的数据库备份与应用回滚包，然后执行 `20260820010000_allow_multiple_changeset_revisions` 迁移与部署；迁移脚本先 dry-run 再 `--apply`。
3. 插件发布：提交本验证记录 working diff，按上方指纹发布 0.2.8 产物到 GitHub Release/BRAT 仓库，并完成市场提交与真实生产冒烟。

未执行 merge/cherry-pick、生产 DB 迁移、部署、npm/GitHub Release/tag/push、用户 Vault 安装、Obsidian preview scan 或市场提交。上述每项都需独立授权。
