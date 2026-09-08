# 图片解析器生产部署验证（2026-09-08）

## 结论

用户恢复 SSH 后，已完成此前批准的服务端解析器修正部署。服务端版本号仍为 0.9.1；此次为已审查的窄范围修正，不是新 npm 或 GitHub Release。

- 来源：独立服务端分支 `codex/image-parser-final-20260908`，冻结提交 `287bcd803d52cf1153fe446fe4d681db58ed1652`。
- 配套插件产品冻结提交：`81b4293b5ad8300d944a874000910a8d0a2b3ffc`；插件本轮未安装到真实 Vault/手机，也未发布。
- 生产目录 `/root/agentwiki` 没有 Git 元数据，因此使用候选文件哈希核验，不冒称生产 git HEAD 已更新。

## 更新前核验

- SSH 实际返回 root / vm；API、worker、frontend 三服务 active。
- 比对候选 416 个 server/shared/package/dependency/config 文件，差异仅 `attachment-reference.ts` 与中立 conformance JSON；Prisma 迁移、依赖和其余业务代码一致。该比对排除 spec.ts、tests 目录和 Markdown 文档。
- 生产旧 parser SHA-256：`b74e402422200d1bc4e31a331c9bee3df7d0c30ddedaeac14d5812f7e05cf41c`。
- 已批准的 6 个源码/测试文件及用于核对的迁移文件暂存到 `/root/agentwiki-release.6KZeo0`。首次暂存传输因一个测试路径写错返回 23；按 git 实际文件列表纠正后重传返回 0，尚未触及 live 文件。

## 配套备份与更新

- 使用既有经审查的 production backup helper，持有部署锁、核对应用 TCP 与 postgres socket 指向同一目标、迁移 checksum、附件目录和空间。
- 停止三服务后，数据库 custom-format dump、附件副本、应用 tar、systemd tar 均校验成功。
- 新备份：`/var/backups/agentwiki/space-name-v091.UWrU3V`，时间 `2026-09-08T08:54:40.454Z`。
- 已完成迁移 56，pending 0。完整历史记录为 58 条（含非成功历史），更新后逐条与备份相同；不能把 58 解释为成功迁移数。
- MANIFEST SHA-256：`a3bca7de93210f16b2aaa1b08378e51287d7d12a832dc5c037b588e2292119b6`。
- application tar SHA-256：`022511dc4158d64f790b58ebcc9f6f8e1ae06d395aab738eedf0599fd0f50c53`。
- systemd tar SHA-256：`3e1e23867df6df38ab3201fd751f80a158568de0b8b2be83aba02532bcfaca3d`。
- 再次持有部署锁并核对 writers inactive、旧源码哈希及两份 env 哈希后，仅同步暂存的 6 个源码/测试文件到 live src。未复制迁移到 live、未执行数据库迁移、未安装依赖、未改 env。
- 在 `/root/agentwiki/apps/server` 执行 `pnpm exec prisma generate`、`pnpm exec nest build` 均 exit 0，再启动三服务。
- 未运行灾难恢复或覆盖数据库；所有备份及暂存目录保留。

## 更新后证据

- 生产源码 parser SHA-256：`db576792ffce5f829092e0de0f0ac745ae23db6165af233ae5a8c661a57ce967`，与候选相同。
- 生产编译 parser JS SHA-256：`a54d1e3df58f9ec618f77c07411d5f19ba23d5c330886f330c22fef7d0894ed8`。
- 416 个部署文件重新比较，差异 0。
- 在生产 Node 进程中直接加载新编译 parser，输入合成中立样例：44 个解析结果及 4 个稳定引用 ID 场景全部通过。此为实际部署产物测试，不是通过 HTTP 执行真实用户同步。
- `http://127.0.0.1:3000/api/health` 及 `https://agentwiki.quukk.com/api/health` 均返回 status/database/redis/auditPersistence/attachmentStorage 全部 ok。
- API / worker / frontend 均 active/running，NRestarts 0，新 MainPID 分别为 3831741 / 3831743 / 3831744。
- `2026-09-08T08:57:17.036Z` 再核对：两份 env 哈希未变、数据库身份通过校验、完整迁移历史逐条未变。

## 仍未完成

Task 7 的同候选桌面/Android 全链路、公网 upgrade/recovery 及发布资产验证仍需独立执行。本轮没有真实同步写入、插件安装、GitHub push/tag/release 或 npm 发布。ADB 结束时识别到已授权 Android 设备；这不等于真机同步验收通过。
