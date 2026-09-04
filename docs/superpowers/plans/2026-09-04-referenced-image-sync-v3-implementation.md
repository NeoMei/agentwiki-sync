# AgentWiki 引用驱动图片同步 Sync v3 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 AgentWiki 网页端与 Obsidian 插件只同步 Markdown 实际引用的 `assets/` 图片，并在 Sync v3 中把 Page、Attachment 元数据和 Blob 绑定到同一个可恢复、可验证的发布边界。

**Architecture:** 公开协议包先定义 wire protocol `"3"`、canonical hash、Attachment/Page 引用与 Blob 分块契约；AgentWiki 服务端在现有附件存储上追加 AttachmentVersion、Revision Attachment row、bootstrap、v3 read/push/blob/finalize 和旧协议升级门；网页端只增强编辑器内图片上传、选择、重命名与归档保护；插件通过统一 Tree/Attachment 模型、引用解析、持久化 identity/generation、Blob staging、三方合并与可恢复 Vault transaction 完成 Pull/Push。Blob 可以预写为不可见内容寻址对象，只有 PostgreSQL Finalize 事务能把它链接到可见 Revision。

**Tech Stack:** TypeScript 5.4/5.9、Zod、NestJS 11、Prisma 5/PostgreSQL、React 18/CodeMirror、Obsidian 1.11 Vault/FileManager API、Jest/Vitest/Playwright、内容寻址 Blob 存储

**Spec:** `docs/superpowers/specs/2026-09-04-referenced-image-sync-v3-design.md`

## Global Constraints

- 这是一个紧耦合的跨仓交付链，不拆成彼此独立的功能计划：协议、服务端原子发布和插件恢复语义必须使用同一组 test vectors 与错误码。但 AgentWiki 主仓实现、部署与插件实现仍须在各自独立任务和提交历史中进行。
- AgentWiki 主仓当前工作树有大量用户未完成改动且落后 `origin/master`；执行主仓 Task 前必须获得单独授权，并从用户指定提交创建干净隔离工作树。不得在当前脏工作树中实现、清理、暂存或提交本计划内容。
- 插件仓同样只有在用户授权实施后才能创建分支/工作树。计划阶段只修改本 spec 与本 plan。
- AgentWiki 主仓以 `agentwiki/` 为项目根；下面标注“主仓”的路径均相对于 `/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`。插件路径均相对于 `/Users/neomei/项目/codexprojects/AgentWiki-Obsidian`。
- 主仓必须先发布 `@neomei/agentwiki-sync-protocol@0.5.0`，再部署支持 v3 的服务端；插件只能消费已发布包，禁止复制主仓内部实现或使用 `workspace:*`、tarball、相对路径替代正式依赖。
- 本计划按 AgentWiki `v0.7.0` 发布基线和插件 `0.3.0` 编写。每个仓库开始实施时必须先重读各自 `AGENTS.md`/项目上下文并核对目标 commit；若公开类型、路由或文件已漂移，先更新本计划和对应测试路径，再写业务代码。
- wire v1/v2 保持冻结；v3 使用新文件、新 Schema、新 hash domain 和新 endpoint。绝不把 v3 Attachment 字段塞进 v2 hash 或 v2 JSON。
- 只管理 `pages/**/*.md` 实际引用且解析后位于映射根 `assets/<single-file-name>` 的 PNG/JPEG/WebP/GIF；不读取或传输未引用图片，不同步 PDF/SVG/音视频/网络 URL/data URI。
- 最后引用消失只产生 `detach_attachment`；不归档远端 `SpaceAttachment`，不删除本地 Vault 文件，也不主动清理业务附件。
- 服务端 Finalize 在 Space advisory lock 与单个 PostgreSQL 事务中验证并发布 Page、AttachmentVersion、Revision rows、Delta 与 provenance；文件系统预写 Blob 仅为不可见 staging，失败后由 GC 回收。
- 插件运行时只使用 Obsidian Vault/FileManager API；不得引入 `node:fs`、inode、符号链接或桌面专用路径假设，确保移动端可运行。
- Pull/Push/首次 v3 bootstrap 都必须先预览、解决阻塞项并由用户显式确认。生产 Vault/Space 写入、部署、npm 发布、GitHub Release 和 Obsidian 市场发布都需要各自单独授权。
- 每个持久化 schema 严格拒绝未知未来版本；所有 journal/staging 使用现有 envelope、双候选与 hash 校验模式，不记录 credential、Authorization header、签名 URL、绝对路径或图片原始字节到日志。
- 硬上限固定为：单 Blob 10 MiB、单 Revision 1000 张图片、单次新传输 100 MiB、每块 1 MiB、每 Blob 最多 10 块、单边 10,000 px、解码像素 40,000,000；服务端 capability 只能调低。插件并发默认 2，可降为 1。

---

### Task 1: 在公开协议包定义 Sync v3 的唯一契约

**Repository:** AgentWiki 主仓（需独立授权、干净工作树）

**Files:**

- Create: `packages/sync-protocol/src/sync-v3.ts`
- Create: `packages/sync-protocol/src/sync-v3.spec.ts`
- Create: `packages/sync-protocol/test-vectors/sync-v3.json`
- Modify: `packages/sync-protocol/src/index.ts`
- Modify: `packages/sync-protocol/src/schemas.ts`（只导出既有 `PublicIdSchema`，不改变 v1/v2 wire 规则）
- Modify: `packages/sync-protocol/package.json`
- Modify: `packages/sync-protocol/README.md`

**Interfaces:**

- Consumes: v2 Folder/Page portable-path rules and `canonicalJson`/SHA-256 primitives
- Produces: `SYNC_PROTOCOL_V3`, `SyncAttachmentV3`, `SyncPageV3`, strict response/request schemas, canonical revision/delta/confirmation/batch/blob hashes, capability hard limits and shared test vectors

```ts
export const SYNC_PROTOCOL_V3 = "3" as const;

export interface SyncAttachmentV3 {
  attachmentId: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: string;
  width: number;
  height: number;
  contentHash: string;
  updatedAt: string;
}

export interface SyncPageV3 extends SyncPageV2 {
  referencedAttachmentIds: string[];
}

export type TreeDeltaItemV3 =
  | Exclude<TreeDeltaItemV2, { operation: "upsert_page" }>
  | { operation: "upsert_page"; page: SyncPageV3 }
  | { operation: "upsert_attachment"; attachment: SyncAttachmentV3 }
  | {
      operation: "detach_attachment";
      attachmentId: string;
      previousPath: string;
    };
```

所有 v3 `attachmentId` / `referencedAttachmentIds` / `declaredAttachmentIds` 字段使用与既有 AgentWiki Space/Page/Revision 相同的 Public ID 约束（`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`），同时接受现有 CUID 和新 UUID；不得把它们收窄为 UUID，也不得为 bootstrap 复制一套同步专用附件身份。

- [ ] **Step 1: 写失败测试，锁定 strict schema、路径、引用集合和能力硬上限**

```ts
it("rejects unknown fields and non-flat attachment paths", () => {
  const valid = {
    attachmentId: crypto.randomUUID(),
    path: "assets/photo.png",
    mimeType: "image/png",
    sizeBytes: "4",
    width: 1,
    height: 1,
    contentHash: "a".repeat(64),
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
  expect(() => SyncAttachmentV3Schema.parse({ ...valid, extra: true })).toThrow();
  expect(() =>
    SyncAttachmentV3Schema.parse({ ...valid, path: "assets/nested/photo.png" }),
  ).toThrow();
});

it("requires sorted unique page attachment ids", () => {
  expect(() =>
    SyncPageV3Schema.parse({
      pageId: crypto.randomUUID(),
      folderId: null,
      path: "pages/a.md",
      title: "a",
      body: "![[assets/a.png]]",
      contentHash: "b".repeat(64),
      updatedAt: "2026-09-04T00:00:00.000Z",
      referencedAttachmentIds: ["b", "a", "a"],
    }),
  ).toThrow();
});
```

- [ ] **Step 2: 运行协议测试，确认 v3 导出不存在而失败**

Run: `pnpm --filter @neomei/agentwiki-sync-protocol test -- sync-v3.spec.ts`

Expected: FAIL，`SYNC_PROTOCOL_V3`、`SyncAttachmentV3Schema` 和 v3 hash helper 尚未导出。

- [ ] **Step 3: 实现 strict Zod schema 与固定硬上限**

```ts
export const TREE_SYNC_V3_HARD_LIMITS = Object.freeze({
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxRevisionAttachments: 1_000,
  maxTransferBlobBytes: 100 * 1024 * 1024,
  blobChunkBytes: 1024 * 1024,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
});

export const SyncAttachmentV3Schema = z
  .object({
    attachmentId: PublicIdSchema,
    path: FlatAttachmentPathSchema,
    mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
    sizeBytes: BoundedDecimalSchema,
    width: z.number().int().positive().max(10_000),
    height: z.number().int().positive().max(10_000),
    contentHash: HashSchema,
    updatedAt: Rfc3339Schema,
  })
  .strict();
```

- [ ] **Step 4: 加入 canonical 顺序和 hash domain 测试向量**

测试必须证明 Folder 父先子后、Page 按 `pathKey/id`、Attachment 按 `pathKey/id`；`referencedAttachmentIds` 排序后参与 Revision hash；`upsert_attachment` 先于依赖它的 Page，`detach_attachment` 晚于不再引用它的 Page；v2/v3 同内容 hash 不相等。

Run: `pnpm --filter @neomei/agentwiki-sync-protocol test`

Expected: PASS，JSON test vector 在 ESM/CJS 构建下得到相同 digest。

- [ ] **Step 5: 构建并验证包导出**

Run: `pnpm --filter @neomei/agentwiki-sync-protocol typecheck && pnpm --filter @neomei/agentwiki-sync-protocol build && pnpm --filter @neomei/agentwiki-sync-protocol prepack`

Expected: PASS；`dist/esm/index.d.ts` 与 `dist/cjs/index.js` 都包含 v3 导出且 spec 文件未进入发布包。

- [ ] **Step 6: 提交协议实现，不在此步发布 npm**

```bash
git add packages/sync-protocol
git commit -m "feat(sync): define referenced attachment protocol v3"
```

### Task 2: 扩展数据库为 AttachmentVersion 与 Revision Attachment 行

**Repository:** AgentWiki 主仓

**Files:**

- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/20260904120000_add_sync_v3_attachments/migration.sql`
- Create: `scripts/sync-v3-attachment-schema-db.test.mjs`
- Create: `scripts/sync-v3-test-database.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: `SpaceAttachment`, `SpaceKnowledgeRevision`, `PushSession`, `PushSessionBatch`, `PushSessionChange`
- Produces: `AttachmentVersion`, `SyncRevisionAttachmentRow`, `PushSessionBlob`, `PushSessionBlobChunk`; v3 revision/session counts and relational invariants

```prisma
model AttachmentVersion {
  id           String   @id @default(cuid())
  attachmentId String
  contentHash  String
  storageKey   String
  mimeType     String
  sizeBytes    BigInt
  width        Int
  height       Int
  createdAt    DateTime @default(now())

  attachment SpaceAttachment @relation(fields: [attachmentId], references: [id], onDelete: Restrict)

  @@unique([attachmentId, contentHash])
  @@unique([id, attachmentId])
  @@index([contentHash])
}

model SyncRevisionAttachmentRow {
  revisionId          String
  spaceId             String
  attachmentId        String
  attachmentVersionId String
  path                String
  pathKey             String
  ordinal             Int

  revision          SpaceKnowledgeRevision @relation(fields: [revisionId, spaceId], references: [id, spaceId], onDelete: Restrict)
  attachment        SpaceAttachment @relation(fields: [attachmentId, spaceId], references: [id, spaceId], onDelete: Restrict)
  attachmentVersion AttachmentVersion @relation(fields: [attachmentVersionId, attachmentId], references: [id, attachmentId], onDelete: Restrict)

  @@id([revisionId, attachmentId])
  @@unique([revisionId, pathKey])
  @@unique([revisionId, ordinal])
}

model PushSessionV3Change {
  sessionId  String
  ordinal    Int
  entityType String
  entityId   String
  operation  String
  payload    Json

  session PushSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@id([sessionId, ordinal])
  @@unique([sessionId, entityType, entityId])
}

model PushSessionBlob {
  sessionId   String
  contentHash String
  sizeBytes   BigInt
  mimeType    String
  width       Int
  height      Int
  status      String
  storageKey  String?
  verifiedAt DateTime?

  session PushSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  chunks  PushSessionBlobChunk[]

  @@id([sessionId, contentHash])
}

model PushSessionBlobChunk {
  sessionId   String
  contentHash String
  chunkIndex  Int
  chunkHash   String
  sizeBytes   Int
  receipt     String
  createdAt   DateTime @default(now())

  blob PushSessionBlob @relation(
    fields: [sessionId, contentHash],
    references: [sessionId, contentHash],
    onDelete: Cascade
  )

  @@id([sessionId, contentHash, chunkIndex])
  @@unique([sessionId, contentHash, receipt])
}
```

- [ ] **Step 1: 写失败的独立数据库契约测试**

```js
test('backfills one immutable version for every active attachment', async () => {
  const rows = await sql`
    SELECT a.id, v."contentHash", v."storageKey"
    FROM "SpaceAttachment" a
    JOIN "AttachmentVersion" v ON v."attachmentId" = a.id
    WHERE a.status = 'active'
  `;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.contentHash && row.storageKey));
});
```

同时断言：同 `attachmentId + contentHash` 不能重复；同 Revision 内 `attachmentId`、`pathKey`、`ordinal` 唯一；AttachmentVersion/Revision row 使用 `RESTRICT`，不能因 Retention 或附件归档误删 Blob 证据；迁移不为历史 v1/v2 Revision 伪造引用行。

- [ ] **Step 2: 运行迁移契约测试，确认缺表失败**

Run: `node -e 'if (!process.env.SYNC_V3_TEST_DATABASE_URL) throw new Error("SYNC_V3_TEST_DATABASE_URL is required")' && node --test scripts/sync-v3-attachment-schema-db.test.mjs`

Expected: FAIL，数据库不存在 `AttachmentVersion` 和 `SyncRevisionAttachmentRow`。

- [ ] **Step 3: 生成 Prisma migration 并人工收紧 SQL**

Run: `pnpm --filter @agentwiki/server exec prisma migrate dev --name add_sync_v3_attachments --create-only`

迁移必须：先建表/索引/外键，再以 `INSERT ... SELECT` 从所有现有 active `SpaceAttachment` 回填一版；不得更新历史 Revision；不得删除原 `contentHash/storageKey` 字段；所有 BigInt 使用非负约束；chunk 序号与总数有边界约束。`SpaceKnowledgeRevision` 与 `SpaceAttachment` 必须提供可被复合外键引用的 `[id, spaceId]` 唯一键，Revision Attachment 行以 `spaceId` 同时约束 Revision 和 Attachment，且以 `[attachmentVersionId, attachmentId]` 保证版本属于该 Attachment。`path` 必须由数据库约束为非空的 `assets/<single-file-name>` 单段路径，拒绝嵌套、`.`、`..` 和反斜杠。

- [ ] **Step 4: 用迁移前快照验证 apply、重复检查与回滚恢复手册**

Run: `node -e 'if (!process.env.SYNC_V3_TEST_DATABASE_URL) throw new Error("SYNC_V3_TEST_DATABASE_URL is required")' && node --test scripts/sync-v3-attachment-schema-db.test.mjs`

Expected: PASS；测试在独立 schema 中验证迁移前两张 active、一张 archived 附件，回填只覆盖 active，旧 Revision 行数不变；通过真实 `prisma migrate deploy` 记录目标 migration 后再次执行并证明 no-op，不以 `psql` 直接执行目标迁移替代 Prisma ledger。数据库凭据不得进入子进程 argv 或错误输出。

- [ ] **Step 5: 生成客户端并跑现有 schema 门**

Run: `pnpm --filter @agentwiki/server exec prisma generate && pnpm test:runtime`

Expected: PASS，现有 Markdown attachment、sync v1/v2 和 retention schema tests 不回归。

- [ ] **Step 6: 提交 schema 与迁移**

```bash
git add apps/server/prisma package.json scripts/sync-v3-attachment-schema-db.test.mjs scripts/sync-v3-test-database.mjs
git commit -m "feat(server): persist sync v3 attachment versions"
```

### Task 3: 建立服务端共享 Markdown 图片引用解析与精确改写内核

**Repository:** AgentWiki 主仓

**Files:**

- Create: `apps/server/src/markdown-resources/attachment-reference.ts`
- Create: `apps/server/src/markdown-resources/attachment-reference.spec.ts`
- Modify: `apps/server/src/markdown-resources/markdown-resource.service.ts`
- Modify: `apps/server/src/markdown-resources/markdown-resource.service.spec.ts`

**Interfaces:**

- Consumes: Page `syncPath`, Markdown body and active Space attachment `{ id, displayName, nameKey }`
- Produces: source-range preserving `ParsedImageReference[]`, authoritative `resolveReferencedAttachments()` and `rewriteAttachmentReferenceRanges()`

```ts
export interface ParsedImageReference {
  syntax: "obsidian" | "markdown";
  rawTarget: string;
  targetStart: number;
  targetEnd: number;
  resolvedPath: string | null;
  classification:
    | "managed_candidate"
    | "external"
    | "unsupported"
    | "invalid_local";
}

export interface ResolvedAttachmentReferences {
  attachmentIds: string[];
  references: Array<ParsedImageReference & { attachmentId: string }>;
  errors: Array<{
    code: "ATTACHMENT_REFERENCE_INVALID" | "ATTACHMENT_MISSING";
    targetStart: number;
    targetEnd: number;
  }>;
}
```

- [ ] **Step 1: 写表驱动失败测试覆盖所有语法和排除项**

```ts
it.each([
  ["![[assets/a.png|320]]", "assets/a.png", "managed_candidate"],
  ["![alt](../assets/a.png \"title\")", "assets/a.png", "managed_candidate"],
  ["![](https://example.com/a.png)", null, "external"],
  ["![](data:image/png;base64,AA==)", null, "external"],
  ["![](../../secret.png)", null, "invalid_local"],
  ["![[assets/a.svg]]", null, "unsupported"],
])("classifies %s", (body, expectedPath, classification) => {
  expect(parseImageReferences(body, "pages/topic/note.md")[0]).toMatchObject({
    resolvedPath: expectedPath,
    classification,
  });
});
```

再加入：转义括号、尖括号 URL、单/双引号/括号 title、Obsidian alias/尺寸、URL 编码、NFC、case-fold 冲突、历史 `![[name.png]]` 唯一/多义/缺失、非图片普通链接、缩进代码、顶层及 blockquote/list 容器中的 fenced code、inline code 和 HTML comment 不误判。标准 Markdown destination 后只允许空白和一个完整合法 title；非法尾随文本、多 title、未闭合 title 均 fail closed。只将 HTTP(S)、FTP 与 protocol-relative 网络 URL 和 `data:` URI归为 external；`file:`、绝对路径及 drive-like 路径仍为非法本地引用。

- [ ] **Step 2: 运行解析测试，确认共享解析器不存在而失败**

Run: `pnpm --filter @agentwiki/server test -- attachment-reference.spec.ts`

Expected: FAIL，模块或导出不存在。

- [ ] **Step 3: 实现单次扫描 parser 和 source-range 改写**

```ts
export function rewriteAttachmentReferenceRanges(
  body: string,
  replacements: ReadonlyArray<{ start: number; end: number; target: string }>,
): string {
  let next = body;
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) {
    if (item.start < 0 || item.end < item.start || item.end > next.length) {
      throw new AttachmentReferenceError("ATTACHMENT_REFERENCE_INVALID");
    }
    next = next.slice(0, item.start) + item.target + next.slice(item.end);
  }
  return next;
}
```

解析器只输出结构证据，不访问磁盘；相对 Markdown 路径按 Page 目录解析，最终必须规整为 `assets/<single-file-name>`。扫描必须保持线性复杂度，转义判断不得对每个字符反向重扫任意长度的反斜线链。

- [ ] **Step 4: 证明改写只改变 path token**

测试 byte-for-byte 断言 alias、尺寸、alt、title、空白、换行和无关 Markdown 均不变；任何重叠/过期 source range 必须抛 `ATTACHMENT_REFERENCE_INVALID`。

Run: `pnpm --filter @agentwiki/server test -- attachment-reference.spec.ts markdown-resource.service.spec.ts`

Expected: PASS。

- [ ] **Step 5: 提交共享解析内核**

```bash
git add apps/server/src/markdown-resources
git commit -m "feat(markdown): resolve managed image references"
```

### Task 4: 实现 v3 Revision writer 与显式 bootstrap

**Repository:** AgentWiki 主仓

**Files:**

- Create: `apps/server/src/core/sync/sync-v3-revision-writer.service.ts`
- Create: `apps/server/src/core/sync/sync-v3-revision-writer.service.spec.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-bootstrap.service.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-bootstrap.service.spec.ts`
- Modify: `apps/server/src/core/sync/space-revision-writer.service.ts`
- Modify: `apps/server/src/core/sync/space-revision-writer.service.spec.ts`
- Modify: `apps/server/src/core/sync/sync.module.ts`
- Modify: `apps/server/src/integrations/obsidian/obsidian.module.ts`

**Interfaces:**

- Consumes: locked Space transaction, v2 immutable Folder/Page rows, active Attachment/AttachmentVersion, shared reference resolver
- Produces: `advanceV3Locked()`, `previewBootstrap()`, `bootstrapConfirmed()` and mode `native_v3 | bootstrap_required | legacy_v2`

```ts
export interface SyncV3Candidate {
  folders: SyncFolderV3[];
  pages: SyncPageV3[];
  attachments: SyncAttachmentV3[];
}

export interface BootstrapPreview {
  mode: "bootstrap_required";
  baseRevision: string;
  candidateHash: string;
  attachmentCount: string;
  transferBytes: string;
  blockers: Array<{
    pageId: string;
    code: "ATTACHMENT_REFERENCE_INVALID" | "ATTACHMENT_MISSING";
  }>;
}
```

- [ ] **Step 1: 写失败测试锁定“只读预览、确认后一次发布”**

```ts
it("does not create a revision during bootstrap preview", async () => {
  const before = await revisionCount(spaceId);
  const preview = await service.previewBootstrap(spaceId, principal);
  expect(preview.mode).toBe("bootstrap_required");
  expect(await revisionCount(spaceId)).toBe(before);
});

it("publishes the first v3 revision under the same space lock", async () => {
  const preview = await service.previewBootstrap(spaceId, principal);
  const result = await service.bootstrapConfirmed(spaceId, principal, {
    baseRevision: preview.baseRevision,
    confirmationHash: preview.candidateHash,
  });
  expect(result.protocolVersion).toBe("3");
  expect(await visibleBrokenReferenceCount(result.revision)).toBe(0);
});
```

- [ ] **Step 2: 运行 writer/bootstrap tests，确认失败**

Run: `pnpm --filter @agentwiki/server test -- sync-v3-revision-writer.service.spec.ts sync-v3-bootstrap.service.spec.ts`

Expected: FAIL，服务和 v3 revision schema 尚不存在。

- [ ] **Step 3: 实现统一候选校验和 revision 写入**

`advanceV3Locked()` 必须按顺序：验证 Page body hash；权威解析每页引用；比较声明 ID 集合；验证 Attachment 当前状态和 version/blob；计算 canonical v3 manifest/hash；批量写 Folder/Page/Attachment revision rows；写 v3 delta/sidecar/count；更新业务 Page/Attachment 当前字段；创建一条新 head。所有步骤使用调用方已持有的 Space lock transaction。

```ts
if (!sameStringSet(parsedIds, page.referencedAttachmentIds)) {
  throw new SyncApiException(
    "ATTACHMENT_REFERENCE_INVALID",
    "Page attachment references do not match the candidate manifest",
    undefined,
    "3",
  );
}
```

- [ ] **Step 4: 实现无图片 Space 的模式与首次写入合并**

`legacy_v2`：当前/历史均未发布 v3 且当前正文无 managed candidate；`bootstrap_required`：尚无 v3、当前正文有 candidate；`native_v3`：任一 v3 head 已发布。网页 Page 保存或重命名首次触发 v3 时，必须在同一个 `advanceV3Locked()` 中构造“旧 v2 当前状态 + 本次用户变更”的第一个 v3 head，不创建中间 bootstrap revision。

- [ ] **Step 5: 注入事务失败，证明 DB 无部分状态**

测试在 AttachmentVersion、PageVersion、RevisionAttachmentRows、head 创建四个检查点抛错；每次都断言旧 head、业务 Page、SpaceAttachment 当前字段与 Revision 行数不变，预写 Blob 保持不可见。

Run: `pnpm --filter @agentwiki/server test -- sync-v3-revision-writer.service.spec.ts sync-v3-bootstrap.service.spec.ts space-revision-writer.service.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交 v3 writer/bootstrap**

```bash
git add apps/server/src/core/sync apps/server/src/integrations/obsidian
git commit -m "feat(server): publish atomic sync v3 revisions"
```

### Task 5: 提供严格 v3 Read API 与旧协议升级门

**Repository:** AgentWiki 主仓

**Files:**

- Create: `apps/server/src/integrations/obsidian/sync-v3.controller.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-revision.service.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-revision.service.spec.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3.http.integration.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v1.controller.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v1.http.integration.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v2.controller.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v2.http.integration.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-error.ts`
- Modify: `apps/server/src/integrations/obsidian/obsidian.module.ts`

**Interfaces:**

- Consumes: immutable v3 rows, v3 schemas/hash helpers, Human Device Credential
- Produces: `/api/sync/v3/capabilities|spaces|spaces/:spaceId/head|snapshot|delta|bootstrap-preview|bootstrap`; safe v1/v2 projection or `SYNC_PROTOCOL_UPGRADE_REQUIRED`

- [ ] **Step 1: 写 HTTP 失败测试锁定能力、分页、固定 Revision 与模式**

```ts
expect(await get("/api/sync/v3/spaces")).toMatchObject({
  protocolVersion: "3",
  spaces: [
    expect.objectContaining({
      spaceId,
      syncMode: "bootstrap_required",
      attachmentCount: "1",
    }),
  ],
});

const fixed = await get(
  `/api/sync/v3/spaces/${spaceId}/snapshot?revision=${revisionId}&limit=1`,
);
expect(fixed.protocolVersion).toBe("3");
expect(fixed.revision).toBe(revisionId);
```

覆盖非法 cursor、跨 Space revision、响应超限、正文 hash/manifest hash 损坏、未知 schema marker、credential 撤销、角色移除和删除 Space。

- [ ] **Step 2: 写 v1/v2 兼容矩阵失败测试**

```ts
it.each(["1", "2"])(
  "blocks protocol %s when the fixed endpoint contains attachments",
  async (protocol) => {
    const response = await requestProtocol(protocol, attachedRevisionId);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SYNC_PROTOCOL_UPGRADE_REQUIRED");
  },
);
```

同时断言：当前/固定终点无 Attachment 时 v1/v2 返回 protocol-specific projection hash；投影 hash 与权威 v3 hash 不相等；Delta 起点无图但终点有图仍拒绝；旧协议 Push session 对 `native_v3` Space 拒绝。

- [ ] **Step 3: 运行聚焦测试，确认路由与 gate 不存在而失败**

Run: `pnpm --filter @agentwiki/server test -- sync-v3.http.integration.spec.ts sync-v2.http.integration.spec.ts sync-v1.http.integration.spec.ts`

Expected: FAIL，v3 routes 为 404 且旧协议未阻止含图终点。

- [ ] **Step 4: 实现 v3 controller/service 与协议专属投影 hash**

```ts
private assertLegacyProjectionAllowed(
  target: { attachmentCount: bigint; protocolVersion: string },
  requestedProtocol: "1" | "2",
): void {
  if (target.attachmentCount > 0n) {
    throw new SyncApiException(
      "SYNC_PROTOCOL_UPGRADE_REQUIRED",
      "This revision requires Sync v3",
      undefined,
      requestedProtocol,
    );
  }
}
```

Snapshot/Delta pagination cursor必须绑定 `spaceId + revision + object kind + last canonical key + protocolVersion`，下一页重复返回固定 metadata，不能在分页间漂移到新 head。

- [ ] **Step 5: 跑完整 read/compatibility 测试**

Run: `pnpm --filter @agentwiki/server test -- sync-v3-revision.service.spec.ts sync-v3.http.integration.spec.ts sync-v2.http.integration.spec.ts sync-v1.http.integration.spec.ts`

Expected: PASS；所有响应通过公开包 strict schema 解析。

- [ ] **Step 6: 提交 read API 与 upgrade gate**

```bash
git add apps/server/src/integrations/obsidian
git commit -m "feat(server): expose sync v3 snapshots and upgrade gates"
```

### Task 6: 实现受 Push session 约束的 Blob 上传与固定 Revision 下载

**Repository:** AgentWiki 主仓

**Files:**

- Create: `apps/server/src/integrations/obsidian/sync-v3-blob.service.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-blob.service.spec.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-blob.storage.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-blob.storage.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v3.controller.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v3.http.integration.spec.ts`
- Modify: `apps/server/src/attachments/attachment-storage.ts`
- Modify: `apps/server/src/attachments/attachment-validator.ts`
- Modify: `apps/server/src/integrations/obsidian/obsidian.module.ts`

**Interfaces:**

- Consumes: v3 Push session blob requirements, existing protected content-addressed storage, image validator, Human Device Credential
- Produces: idempotent chunk receipt, blob completion result and fixed-Revision authorized download stream

```ts
export interface BlobChunkReceiptV3 {
  contentHash: string;
  chunkIndex: number;
  chunkHash: string;
  receipt: string;
}

export interface CompletedBlobV3 {
  contentHash: string;
  sizeBytes: string;
  mimeType: SyncAttachmentV3["mimeType"];
  width: number;
  height: number;
  verifiedAt: string;
}
```

- [ ] **Step 1: 写失败测试覆盖 hash 绑定、分块幂等和授权**

```ts
it("accepts the same chunk twice but rejects different bytes", async () => {
  const first = await service.putChunk(principal, sessionId, hash, 0, bytes);
  const retry = await service.putChunk(principal, sessionId, hash, 0, bytes);
  expect(retry.receipt).toBe(first.receipt);
  await expect(
    service.putChunk(principal, sessionId, hash, 0, otherBytes),
  ).rejects.toMatchObject({ code: "ATTACHMENT_CONTENT_INVALID" });
});
```

覆盖：非 session-required hash、跨 Space/session、过期 session、超过 1 MiB chunk、超过 10 chunks、总量超过 100 MiB、组合 hash/size/MIME/魔数/扩展名/宽高/像素不匹配、符号链接与路径穿越、credential 撤销和非固定 Revision 下载。

- [ ] **Step 2: 运行 Blob tests，确认服务不存在而失败**

Run: `pnpm --filter @agentwiki/server test -- sync-v3-blob.service.spec.ts sync-v3-blob.storage.spec.ts`

Expected: FAIL。

- [ ] **Step 3: 实现只接受 `application/octet-stream` 的分块入口**

路由固定为：

- `PUT /api/sync/v3/spaces/:spaceId/push-sessions/:sessionId/blobs/:contentHash/chunks/:chunkIndex`
- `POST /api/sync/v3/spaces/:spaceId/push-sessions/:sessionId/blobs/:contentHash/complete`
- `GET /api/sync/v3/spaces/:spaceId/revisions/:revisionId/attachments/:attachmentId/content`

每个 chunk 写入 session 私有 staging，落盘后 fsync/close，再记录唯一 `(sessionId, contentHash, chunkIndex, chunkHash)` receipt；重复同 bytes 返回原 receipt，不同 bytes 返回冲突。`complete` 组合后重新执行现有 attachment validator，最终移动/去重到受保护 content-addressed storage。

- [ ] **Step 4: 实现固定 Revision 下载绑定**

```ts
const row = await tx.syncRevisionAttachmentRow.findUnique({
  where: {
    revisionId_attachmentId: { revisionId, attachmentId },
  },
  include: { attachmentVersion: true },
});
if (!row || row.attachmentVersion.contentHash !== requestedHash) {
  throw new SyncApiException(
    "ATTACHMENT_MISSING",
    "Attachment is not part of the requested revision",
    undefined,
    "3",
  );
}
```

响应必须 `private, no-store`、`nosniff`，不得暴露 storage key 或生成可持久化公开 URL。

- [ ] **Step 5: 跑单元与 HTTP 集成测试**

Run: `pnpm --filter @agentwiki/server test -- sync-v3-blob.service.spec.ts sync-v3-blob.storage.spec.ts sync-v3.http.integration.spec.ts attachment-validator.spec.ts`

Expected: PASS；内存峰值受 chunk 上限约束，不把整批 100 MiB Blob 聚合进 JSON 或日志。

- [ ] **Step 6: 提交 Blob 通道**

```bash
git add apps/server/src/integrations/obsidian apps/server/src/attachments
git commit -m "feat(server): transfer sync v3 image blobs"
```

### Task 7: 实现 v3 Push session、原子 Finalize 与崩溃后幂等终态

**Repository:** AgentWiki 主仓

**Files:**

- Create: `apps/server/src/integrations/obsidian/sync-v3-push-session.service.ts`
- Create: `apps/server/src/integrations/obsidian/sync-v3-push-session.service.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v3.controller.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-v3.http.integration.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/push-session.service.ts`
- Modify: `apps/server/src/integrations/obsidian/push-session.service.spec.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-capabilities.service.ts`
- Modify: `apps/server/src/integrations/obsidian/sync-error.ts`

**Interfaces:**

- Consumes: v3 confirmation manifest, canonical batches, verified blob receipts, `SyncV3RevisionWriterService`
- Produces: create/upload/finalize/status/abort state machine with `missingContentHashes`, terminal idempotency and actionable v3 errors

```ts
type SyncV3PushState =
  | "uploading"
  | "ready_to_finalize"
  | "finalizing"
  | "published"
  | "aborted"
  | "expired";

export interface CreateSyncV3PushSessionResult {
  protocolVersion: "3";
  sessionId: string;
  status: SyncV3PushState;
  expiresAt: string;
  missingContentHashes: string[];
}
```

- [ ] **Step 1: 写失败测试覆盖 session 状态机和错误映射**

```ts
it("returns only missing content hashes in canonical order", async () => {
  await seedVerifiedBlob(existingHash);
  const result = await service.create(principal, spaceId, requestFor([
    missingHash,
    existingHash,
  ]));
  expect(result.missingContentHashes).toEqual([missingHash]);
});

it("returns the stored terminal result after a lost finalize response", async () => {
  const first = await service.finalize(principal, spaceId, sessionId, request);
  const retry = await service.finalize(principal, spaceId, sessionId, request);
  expect(retry).toEqual(first);
  expect(await revisionCount(spaceId)).toBe(2);
});
```

覆盖：`BASE_STALE`、`CAPABILITIES_CHANGED`、confirmation/batch receipt mismatch、重复 entity、path 冲突、引用缺失、Blob 缺失/过期、权限在 create 后撤销、并发网页写入、session 过期/abort、finalizing 后禁止 cancel。

- [ ] **Step 2: 运行 Push tests，确认 v3 service 不存在而失败**

Run: `pnpm --filter @agentwiki/server test -- sync-v3-push-session.service.spec.ts sync-v3.http.integration.spec.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 create 与 canonical batch upload**

create 严格绑定 credential family、credential id、user、Space、base Revision、idempotency key、capability hash、confirmation hash、change/blob counts 和 bytes；upload 只接受 manifest 中实体，每批 receipt 持久化后才能响应。相同 idempotency key + 相同请求返回原 session，不同请求返回 `IDEMPOTENCY_CONFLICT`。

- [ ] **Step 4: 实现不可取消 Finalize**

Finalize 进入 `finalizing` 后，在同一 serializable transaction 和 Space lock 内重新检查：credential/成员/角色、base head、capability hash、所有 batch receipts、所有 blob receipts、candidate limits、Page 引用集合与 AttachmentVersion。验证成功后调用 `advanceV3Locked()` 并将 terminal result 一同持久化。

```ts
if (session.status === "published") {
  return TreeFinalizePushResponseV3Schema.parse(session.result);
}
if (session.status !== "ready_to_finalize") {
  throw this.error("SESSION_STATE_INVALID", "Session cannot be finalized");
}
```

- [ ] **Step 5: 执行故障注入与并发测试**

在 Finalize 响应前断连、事务 serialization retry、同 base 两个 session 并发、网页 Page save 抢先四种场景下，断言最多一个新 head、无 Page 引用缺失 Blob、失败 session 可查询确定终态。

Run: `pnpm --filter @agentwiki/server test -- sync-v3-push-session.service.spec.ts sync-v3.http.integration.spec.ts push-session.service.spec.ts`

Expected: PASS。

- [ ] **Step 6: 提交 v3 Push/Finalize**

```bash
git add apps/server/src/integrations/obsidian
git commit -m "feat(server): finalize sync v3 atomically"
```

### Task 8: 补齐 Retention、Blob GC、归档保护与安全门

**Repository:** AgentWiki 主仓

**Files:**

- Modify: `apps/server/src/core/sync/revision-retention.service.ts`
- Modify: `apps/server/src/core/sync/revision-retention.service.spec.ts`
- Modify: `apps/server/src/attachments/attachment-cleanup.worker.ts`
- Modify: `apps/server/src/attachments/attachment-cleanup.worker.spec.ts`
- Modify: `apps/server/src/attachments/attachment.service.ts`
- Modify: `apps/server/src/attachments/attachment.service.spec.ts`
- Modify: `apps/server/src/core/filters/business-error.ts`
- Modify: `apps/server/src/core/filters/business-error.spec.ts`
- Modify: `scripts/attachment-deployment-contract.test.mjs`
- Create: `scripts/sync-v3-retention-db.test.mjs`

**Interfaces:**

- Consumes: readable Revision window, unexpired Push sessions, current SpaceAttachment and AttachmentVersion references
- Produces: reference-aware retention/GC and `ATTACHMENT_REFERENCED` archive response with impacted Pages

- [ ] **Step 1: 写失败测试证明仍可读/暂存中的 Blob 不会被删**

```ts
it.each([
  "readable_revision",
  "unexpired_push_session",
  "current_space_attachment",
  "attachment_version",
])("retains blobs referenced by %s", async (owner) => {
  const fixture = await seedBlobOwner(owner);
  await cleanup.tick();
  await expect(storage.open(fixture.storageKey)).resolves.toBeDefined();
});
```

另测：过期 session 的无引用 staging blob 只在宽限期后删除；Revision 过期不触发业务附件归档；archive 当前 Revision 引用的 Attachment 返回 `ATTACHMENT_REFERENCED` 和去重 Page 摘要。

- [ ] **Step 2: 运行 retention/cleanup tests，确认旧逻辑误判而失败**

Run: `pnpm --filter @agentwiki/server test -- revision-retention.service.spec.ts attachment-cleanup.worker.spec.ts attachment.service.spec.ts`

Expected: FAIL，旧 GC 不认识 v3 owner，archive 不检查 Revision references。

- [ ] **Step 3: 实现单一“是否仍被引用”查询并复用**

GC 删除前必须在同一次数据库读中排除：active/current attachment、任一保留 Revision row、任一 unexpired session blob；删除采用 storage lease 和再次确认，避免检查与 unlink 之间产生新引用。

- [ ] **Step 4: 实现 archive guard 与脱敏错误**

```ts
if (referencedPages.length > 0) {
  throw new BusinessException("ATTACHMENT_REFERENCED", {
    pages: referencedPages.map(({ id, title }) => ({ id, title })),
  });
}
```

错误 payload 不含 Markdown body、storageKey、绝对路径、credential 或 Blob 内容；全局 filter 对 v3 error 保留稳定 code/protocol/retryable 字段。

- [ ] **Step 5: 跑独立数据库与部署契约门**

Run: `SYNC_V3_TEST_DATABASE_URL="$SYNC_V3_TEST_DATABASE_URL" node --test scripts/sync-v3-retention-db.test.mjs && node --test scripts/attachment-deployment-contract.test.mjs`

Expected: PASS；部署根与持久化 attachment root 分离，GC 无法越界。

- [ ] **Step 6: 提交 retention/security 修复**

```bash
git add apps/server/src/core/sync apps/server/src/core/filters apps/server/src/attachments scripts
git commit -m "fix(server): retain referenced sync v3 blobs"
```

### Task 9: 让网页端使用规范 `assets/` 引用并提供轻量重命名

**Repository:** AgentWiki 主仓

**Files:**

- Modify: `apps/server/src/attachments/attachment.controller.ts`
- Modify: `apps/server/src/attachments/attachment.controller.spec.ts`
- Modify: `apps/server/src/attachments/attachment.dto.ts`
- Modify: `apps/server/src/attachments/attachment.dto.spec.ts`
- Modify: `apps/server/src/attachments/attachment.service.ts`
- Modify: `apps/server/src/attachments/attachment.service.spec.ts`
- Modify: `apps/server/src/core/page/page.service.ts`
- Modify: `apps/server/src/core/page/page.service.spec.ts`
- Modify: `apps/client/src/features/attachments/attachmentApi.ts`
- Modify: `apps/client/src/features/attachments/attachmentApi.spec.ts`
- Modify: `apps/client/src/features/attachments/attachmentTypes.ts`
- Modify: `apps/client/src/features/attachments/AttachmentPickerDialog.tsx`
- Modify: `apps/client/src/features/attachments/AttachmentPickerDialog.spec.tsx`
- Modify: `apps/client/src/features/page/PageEditor.tsx`
- Modify: `apps/client/src/features/page/PageEditor.spec.tsx`
- Modify: `apps/client/src/components/MarkdownWorkspace.tsx`
- Modify: `apps/client/src/components/MarkdownWorkspace.spec.tsx`
- Modify: `apps/client/src/i18n/messages.ts`
- Modify: `apps/client/e2e/markdown-attachments.spec.ts`

**Interfaces:**

- Consumes: existing upload/list/archive REST, shared reference parser, v3 writer
- Produces: canonical insertion `![[assets/<authoritative-name>]]`, `POST /api/spaces/:spaceId/attachments/:attachmentId/rename`, impacted-page confirmation and archive protection UI

- [ ] **Step 1: 写失败的 client tests 锁定所有插入入口**

```tsx
it.each(["picker", "paste", "drop"])(
  "inserts an assets-qualified reference from %s",
  async (entry) => {
    const editor = await renderEditorWithUpload(entry, "photo (2).png");
    expect(editor.markdown()).toContain("![[assets/photo (2).png]]");
    expect(editor.markdown()).not.toContain("![[photo (2).png]]");
  },
);
```

- [ ] **Step 2: 写失败的 server tests 锁定 rename 原子语义**

```ts
it("renames an attachment and rewrites every current page in one revision", async () => {
  const result = await service.rename(spaceId, attachmentId, {
    displayName: "renamed.png",
    expectedUpdatedAt,
    expectedTreeRevision,
  }, principal);
  expect(result.path).toBe("assets/renamed.png");
  expect(result.impactedPages.map((page) => page.id)).toEqual([pageA, pageB]);
  expect(await currentBrokenReferenceCount(spaceId)).toBe(0);
});
```

覆盖目标 nameKey 冲突、过期 `expectedUpdatedAt`、stale tree revision、不可精确改写、无权限、Page A/B 任一写入失败时全部回滚。

- [ ] **Step 3: 运行聚焦 web/server tests，确认失败**

Run: `pnpm --filter @agentwiki/server test -- attachment.service.spec.ts attachment.controller.spec.ts page.service.spec.ts && pnpm --filter @agentwiki/client test -- AttachmentPickerDialog.spec.tsx PageEditor.spec.tsx MarkdownWorkspace.spec.tsx`

Expected: FAIL，现有 PageEditor 插入 `![[displayName]]` 且没有 rename API。

- [ ] **Step 4: 实现规范插入与 rename preview/confirm**

```ts
export const attachmentMarkdown = (displayName: string) =>
  `![[assets/${displayName}]]`;
```

Picker 中“重命名”先请求 server preview，显示受影响 Page 标题/数量；用户确认后发送 expected attachment timestamp 与 expected tree revision。服务端在 Space lock 中用共享 source ranges 重写所有当前 Page、写 PageVersion/Attachment 当前名/v3 Revision；不做全文 replace。

- [ ] **Step 5: 让普通 Page save 同步写 v3 引用集合**

Page create/update/restore 路径在持锁事务内调用共享 resolver；有 managed candidate 时写 v3 head，歧义/缺失时整次保存失败；URL/data URI 不构成 Attachment blocker。已是 `native_v3` 的 Space 即使引用集合变空也继续写 v3。

- [ ] **Step 6: 实现 archive protection UI**

API 返回 `ATTACHMENT_REFERENCED` 时，Picker 展示引用 Page 列表并保留附件 active 状态；不提供“强制删除引用”或附件管理中心。

- [ ] **Step 7: 跑 client/server/e2e tests**

Run: `pnpm --filter @agentwiki/server test -- attachment.service.spec.ts page.service.spec.ts sync-v3-revision-writer.service.spec.ts && pnpm --filter @agentwiki/client test && pnpm --filter @agentwiki/client exec playwright test e2e/markdown-attachments.spec.ts`

Expected: PASS；上传、选择、粘贴、拖放均插入规范路径，rename 与 archive guard 可见且键盘可操作。

- [ ] **Step 8: 提交网页端完整行为**

```bash
git add apps/server/src/attachments apps/server/src/core/page apps/client/src apps/client/e2e/markdown-attachments.spec.ts
git commit -m "feat(web): manage referenced images inside markdown editing"
```

### Task 10: 验证主仓交付物并按授权顺序发布协议、部署服务端

**Repository:** AgentWiki 主仓

**Files:**

- Create: `docs/contracts/agentwiki-obsidian-sync-api-v3.md`
- Create: `docs/operations/sync-v3-attachments.md`
- Create: `docs/verification/sync-v3-referenced-images-2026-09-04.md`
- Modify: `packages/sync-protocol/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/server/.env.example`
- Modify: `deploy/systemd/agentwiki-api.service`
- Modify: `deploy/systemd/agentwiki-worker.service`
- Modify: `docker-compose.yml`
- Modify: `scripts/smoke-test.mjs`
- Create: `scripts/sync-v3-http-db.test.mjs`

**Interfaces:**

- Consumes: Tasks 1–9 and an explicit user authorization for npm publish/deploy
- Produces: immutable public package `@neomei/agentwiki-sync-protocol@0.5.0`, deployed v3 server capability and rollback evidence; no plugin release yet

- [ ] **Step 1: 写发布前 smoke 断言并确认部署前失败**

```js
const capabilities = await api('/sync/v3/capabilities', credential);
assert.equal(capabilities.protocolVersion, '3');
assert.equal(capabilities.capabilities.blobChunkBytes, 1024 * 1024);
assert.ok(capabilities.capabilitiesHash.match(/^[0-9a-f]{64}$/u));
```

Smoke 还要创建隔离 Space，网页上传一张最小 PNG、保存规范引用、读取 v3 head/snapshot、验证固定 Revision Blob 下载、用旧 v2 head 确认收到 upgrade gate，最后删除隔离数据。

- [ ] **Step 2: 跑主仓全部静态、单元和独立数据库门**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

Run: `SYNC_V3_TEST_DATABASE_URL="$SYNC_V3_TEST_DATABASE_URL" node --test scripts/sync-v3-attachment-schema-db.test.mjs scripts/sync-v3-retention-db.test.mjs scripts/sync-v3-http-db.test.mjs`

Expected: 全部 PASS；验证文档记录命令、提交 SHA、数据库 schema、失败注入结果和未执行的外部发布项。

- [ ] **Step 3: 检查 package tarball，不发布**

Run: `pnpm --filter @neomei/agentwiki-sync-protocol pack --pack-destination /tmp/agentwiki-sync-v3-pack`

Expected: tarball 仅含 dist/README/LICENSE；ESM、CJS、types 和 v3 test-vector consumer smoke 均通过；不含 source spec、凭据或主仓内部代码。

- [ ] **Step 4: 提交可发布的协议、服务端、部署合同与候选验证记录**

在外部发布前把 `packages/sync-protocol/package.json` 固定为 `0.5.0`，确认 lockfile 与生成资产一致，并把验证文档状态标为“本地通过，npm/生产待授权”。

```bash
git add docs/contracts/agentwiki-obsidian-sync-api-v3.md docs/operations/sync-v3-attachments.md docs/verification/sync-v3-referenced-images-2026-09-04.md packages/sync-protocol/package.json pnpm-lock.yaml apps/server/.env.example deploy/systemd/agentwiki-api.service deploy/systemd/agentwiki-worker.service docker-compose.yml scripts/smoke-test.mjs scripts/sync-v3-http-db.test.mjs
git commit -m "docs(sync): prepare sync v3 server release"
```

Expected: 发布 commit 的工作树干净，`git show HEAD:packages/sync-protocol/package.json` 显示 `0.5.0`，tarball 从该 commit 构建。

- [ ] **Step 5: 在用户明确授权 npm 发布后发布 0.5.0 并核对 registry**

Run: `pnpm --filter @neomei/agentwiki-sync-protocol publish --access public --no-git-checks`

Run: `npm view @neomei/agentwiki-sync-protocol@0.5.0 version dist.integrity --json`

Expected: registry 返回 `0.5.0` 和非空 integrity。若 npm 需要 OTP，使用交互式 TTY 授权，不记录 OTP/授权 URL。

- [ ] **Step 6: 在用户明确授权部署后迁移并部署 server-first**

先备份数据库与附件持久化根，应用 migration，部署 API/worker/web；不得先发布插件。迁移或 health/smoke 任一失败，按部署手册回滚二进制并保留可恢复数据库备份，不执行破坏性 down migration。

- [ ] **Step 7: 验证生产通道各自状态**

分别记录：本地 commit、`origin/master`、npm 0.5.0 integrity、生产 `/api/sync/v3/capabilities`、生产 migration、网页真实上传/保存/固定 Revision 下载；任何一个 PASS 不替代其他通道。

- [ ] **Step 8: 回填并提交发布后的验证记录**

```bash
git add docs/verification/sync-v3-referenced-images-2026-09-04.md
git commit -m "docs(sync): record sync v3 production evidence"
```

### Task 11: 插件只消费已发布 v3 包并完成安全协议协商

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/application/protocol-negotiator.ts`
- Modify: `src/storage/protocol-selection.ts`
- Modify: `src/application/connection-service.ts`
- Modify: `src/ports/tree-remote.ts`
- Modify: `tests/unit/protocol-negotiator.test.ts`
- Modify: `tests/integration/client-connection.test.ts`
- Modify: `tests/integration/protocol-conformance.test.ts`

**Interfaces:**

- Consumes: registry-published `@neomei/agentwiki-sync-protocol@0.5.0`
- Produces: `SyncProtocolSelection` supporting `"3" | "2" | "1"`, server-scoped v3 capabilities and `SYNC_PROTOCOL_UPGRADE_REQUIRED` fail-closed behavior

```ts
export type SyncProtocolSelection =
  | {
      version: "3";
      capabilities: TreeSyncCapabilitiesV3;
      capabilitiesHash: string;
    }
  | {
      version: "2";
      capabilities: TreeSyncCapabilitiesV2;
      capabilitiesHash: string;
    }
  | { version: "1"; reason: "endpoint_missing" | "protocol_unsupported" };
```

- [ ] **Step 1: 写失败的 registry conformance 与协商测试**

```ts
it("selects v3 before probing v2", async () => {
  const client = fakeClientWithV3Capabilities();
  const selection = await negotiator(client).select(identity);
  expect(selection.version).toBe("3");
  expect(client.calls).toEqual(["/api/sync/v3/capabilities"]);
});

it("does not hide a v3 authentication or schema failure by downgrading", async () => {
  const client = fakeClientRejectingV3(401);
  await expect(negotiator(client).select(identity)).rejects.toMatchObject({
    status: 401,
  });
});
```

- [ ] **Step 2: 安装精确正式版本并确认旧代码测试失败**

Run: `npm install --save-exact @neomei/agentwiki-sync-protocol@0.5.0`

Run: `npx vitest run tests/integration/protocol-conformance.test.ts tests/unit/protocol-negotiator.test.ts`

Expected: v3 conformance 可加载，但 negotiator/port 不接受 `"3"` 而失败。

- [ ] **Step 3: 实现 v3-first、显式 legacy fallback**

只有 v3 endpoint 404/`PROTOCOL_UNSUPPORTED` 才探测 v2；只有 v2 endpoint 同样明确不支持才落到 v1。401/403/409/429/5xx、网络、malformed JSON、unknown fields、hash mismatch 或响应超限都停止，不降级。

- [ ] **Step 4: 绑定协议选择到 server identity 和插件版本**

持久化 key 使用 normalized server origin + `serverInstanceId` + plugin version；已提交 v3 generation 的 Space 不允许使用 v2/v1 selection。connection 恢复时 credential 更换不复用旧 capabilities hash。

- [ ] **Step 5: 跑协商、连接与 conformance tests**

Run: `npx vitest run tests/integration/protocol-conformance.test.ts tests/unit/protocol-negotiator.test.ts tests/integration/client-connection.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交插件依赖与协商**

```bash
git add package.json package-lock.json src/application/protocol-negotiator.ts src/storage/protocol-selection.ts src/application/connection-service.ts src/ports/tree-remote.ts tests
git commit -m "feat(sync): negotiate published protocol v3"
```

### Task 12: 在插件中解析引用并只扫描被引用图片

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Create: `src/core/attachment-reference.ts`
- Create: `src/core/image-metadata.ts`
- Modify: `src/core/tree-model.ts`
- Modify: `src/core/tree-scan.ts`
- Modify: `src/ports/vault.ts`
- Modify: `src/obsidian/adapters.ts`
- Create: `tests/unit/attachment-reference.test.ts`
- Create: `tests/unit/image-metadata.test.ts`
- Modify: `tests/unit/tree-scan.test.ts`
- Modify: `tests/unit/obsidian-adapters.test.ts`
- Modify: `tests/fakes/memory-vault.ts`

**Interfaces:**

- Consumes: `VaultPort.listTree()`, Page path/body and identity state
- Produces: `TreeAttachment`, `TreePage.referencedAttachmentIds`, parsed source ranges and bounded local image metadata without reading unreferenced bytes

```ts
export interface TreeAttachment {
  attachmentId: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: string;
  width: number;
  height: number;
  contentHash: string;
  updatedAt: string;
}

export interface LocalTreeScan {
  rootPath: string;
  folders: TreeFolder[];
  pages: TreePage[];
  attachments: TreeAttachment[];
  blockers: AttachmentScanBlocker[];
}
```

- [ ] **Step 1: 写与服务端 test vector 对称的失败解析测试**

```ts
it("preserves source ranges for exact target rewriting", () => {
  const body = "before ![[assets/a.png|320]] after";
  const reference = parseAttachmentReferences(body, "pages/note.md")[0]!;
  expect(body.slice(reference.targetStart, reference.targetEnd)).toBe(
    "assets/a.png",
  );
});
```

必须复用公开协议 test vectors 的规范路径与 NFC/case-fold 预期；服务端和插件各自实现解析器，但同一输入分类/路径/ID 集合一致。

- [ ] **Step 2: 写未引用图片不得 read 的失败测试**

```ts
it("does not read bytes for images absent from markdown references", async () => {
  vault.seedFile("assets/unused.png", pngBytes);
  vault.seedMarkdown("pages/note.md", "no image");
  await scanLocalTree(vault, "", emptyBaseV3(), identities, limits);
  expect(vault.readPaths).not.toContain("assets/unused.png");
});
```

另测两页引用同图只读一次、URL/data URI 零读取、历史裸名唯一时读取、多义/缺失/逃出/不支持扩展产生 blocker。

- [ ] **Step 3: 运行 parsing/scan tests，确认失败**

Run: `npx vitest run tests/unit/attachment-reference.test.ts tests/unit/image-metadata.test.ts tests/unit/tree-scan.test.ts`

Expected: FAIL，当前 scanner 忽略所有 `kind: "file"`。

- [ ] **Step 4: 实现两阶段扫描和纯浏览器图片验证**

阶段一只读取 `pages/**/*.md` 并收集候选 target；阶段二仅对去重后的 `assets/` 路径调用 `vault.read()`。先检查 `byteLength <= capability.maxAttachmentBytes`，再解析 PNG/JPEG/WebP/GIF header 获取 MIME/width/height/decoded pixels；不得创建 DOM Image、object URL 或 Node native dependency。

- [ ] **Step 5: 绑定稳定 ID 并生成规范引用集合**

解析次序：active identity → pending identity → base v3 Attachment → detached hint 的 path+hash 精确匹配 → 生成 UUID。Page 的 `referencedAttachmentIds` 去重排序；一个 pathKey 对应多 ID 或同 ID 对应多 path 时 blocker，不静默选取。

- [ ] **Step 6: 跑 parser、scan、adapter tests**

Run: `npx vitest run tests/unit/attachment-reference.test.ts tests/unit/image-metadata.test.ts tests/unit/tree-scan.test.ts tests/unit/obsidian-adapters.test.ts`

Expected: PASS；fixture 包含最小 PNG/JPEG/WebP/GIF 和损坏/超限 header。

- [ ] **Step 7: 提交引用驱动扫描**

```bash
git add src/core src/ports/vault.ts src/obsidian/adapters.ts tests
git commit -m "feat(sync): scan only referenced vault images"
```

### Task 13: 持久化 v3 generation、附件身份、Blob staging 与恢复证据

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `src/storage/tree-identities.ts`
- Modify: `src/storage/tree-generation.ts`
- Modify: `src/storage/tree-baseline.ts`
- Create: `src/storage/blob-staging.ts`
- Modify: `src/storage/migration.ts`
- Modify: `src/storage/pointer.ts`
- Modify: `tests/unit/storage.test.ts`
- Modify: `tests/unit/tree-generation.test.ts`
- Modify: `tests/integration/tree-baseline-upgrade.test.ts`
- Create: `tests/integration/blob-staging.test.ts`
- Create: `tests/fakes/blob-staging-fixture.ts`

**Interfaces:**

- Consumes: v1/v2 generation and v3 Folder/Page/Attachment snapshot metadata
- Produces: strict `TreeGenerationManifestV3`, `TreeIdentityStateV2`, inactive detached hints and bounded `BlobStagingJournal`

```ts
export interface TreeAttachmentIdentity {
  attachmentId: string;
  path: string;
  pathKey: string;
  baseContentHash: string;
  active: boolean;
}

export interface TreeGenerationManifestV3 {
  schemaVersion: 3;
  protocolVersion: "3";
  generationId: string;
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  baseRevisionContentHash: string;
  baseFolderCount: number;
  basePageCount: number;
  baseAttachmentCount: number;
  baseRevisionManifestByteLength: number;
  baseRevisionBodyBytes: number;
  baseRevisionAttachmentBytes: number;
  lastSuccessfulSyncAt: string;
  folders: Record<string, TreeFolder>;
  pages: Record<string, Omit<TreePage, "body">>;
  attachments: Record<string, TreeAttachment>;
}
```

- [ ] **Step 1: 写失败测试覆盖 schema、候选、升级与 detach hint**

```ts
it("rejects a future v3 generation schema", async () => {
  await store.write(path, JSON.stringify({ schemaVersion: 4 }));
  await expect(repo.verify(generationId)).rejects.toThrow(
    "Unknown tree generation schema version",
  );
});

it("keeps a detached identity inactive without owning the file", async () => {
  const state = detachAttachment(identityState, attachmentId);
  expect(state.attachments[attachmentId]?.active).toBe(false);
  expect(state.pendingAttachments[attachmentId]).toBeUndefined();
});
```

- [ ] **Step 2: 运行 storage tests，确认 v3 schema 不支持而失败**

Run: `npx vitest run tests/unit/storage.test.ts tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts tests/integration/blob-staging.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 v3 generation 与 hash 复核**

generation 只存 Attachment metadata，不存 Blob bytes；verify 从 Page body sidecar 水化 Page，使用公开 `treeRevisionContentHashV3()` 复算 hash/count/manifest/body/attachment bytes。pointer 只有在 generation 完整验证后 CAS 切换。

- [ ] **Step 4: 实现 v1/v2 到 v3 的单向升级**

旧 generation 作为零 Attachment base 保留只读证据；只有 confirmed bootstrap/Pull 成功后创建 v3 generation。迁移中断仍选择旧 pointer，不产生半 v3；一旦 pointer 指向 v3，negotiator 禁止降回 v2/v1。

- [ ] **Step 5: 实现受限 Blob staging**

路径使用 hash 派生的不透明 key，journal 记录 expected size/hash、received chunk indexes/chunk hashes、complete hash、expiry；每次写入执行总量与 chunk 上限，complete 后重新 read/hash。清理只操作当前 mapping root 的私有 `.agentwiki` 控制存储。

- [ ] **Step 6: 跑损坏、双候选、断电 checkpoint 与跨设备恢复 tests**

Run: `npx vitest run tests/unit/storage.test.ts tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts tests/integration/blob-staging.test.ts`

Expected: PASS；任何 ambiguous 双候选阻止同步并保留恢复证据。

- [ ] **Step 7: 提交本地状态模型**

```bash
git add src/storage tests/unit/storage.test.ts tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts tests/integration/blob-staging.test.ts
git commit -m "feat(sync): persist attachment generations and staging"
```

### Task 14: 实现 v3 Remote Adapter 与流式 Blob 传输

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Create: `src/agentwiki/v3-tree-remote.ts`
- Create: `src/application/blob-transfer.ts`
- Modify: `src/agentwiki/client.ts`
- Modify: `src/ports/http.ts`
- Modify: `src/ports/tree-remote.ts`
- Modify: `src/obsidian/adapters.ts`
- Create: `tests/integration/v3-tree-remote.test.ts`
- Create: `tests/integration/blob-transfer.test.ts`
- Modify: `tests/fakes/fake-http.ts`
- Modify: `tests/fakes/fake-tree-remote.ts`

**Interfaces:**

- Consumes: strict v3 public schemas, Obsidian `requestUrl`, Blob staging repository
- Produces: `V3TreeRemote`, fixed snapshot/delta iteration, missing-hash upload, fixed-Revision download, bounded retry/concurrency

```ts
export interface TreeRemotePortV3 extends TreeRemotePort {
  readonly protocolVersion: "3";
  uploadBlobChunk(
    sessionId: string,
    contentHash: string,
    chunkIndex: number,
    bytes: Uint8Array,
  ): Promise<BlobChunkReceiptV3>;
  completeBlob(
    sessionId: string,
    contentHash: string,
  ): Promise<CompletedBlobV3>;
  downloadBlob(input: {
    revision: string;
    attachmentId: string;
    contentHash: string;
  }): Promise<Uint8Array>;
}
```

- [ ] **Step 1: 写失败测试覆盖 fixed metadata、严格响应和丢包恢复**

```ts
it("rejects snapshot pages that change revision metadata", async () => {
  http.enqueue(snapshotPage("r1", 0));
  http.enqueue(snapshotPage("r2", 1));
  await expect(collect(remote.snapshotPages("r1"))).rejects.toThrow(
    "SNAPSHOT_METADATA_CHANGED",
  );
});
```

Blob tests 覆盖首块响应丢失后重试得到同 receipt、第二块 503 指数退避、401 不重试、complete hash mismatch 清理 staging、下载 body 超限在复制前拒绝、并发始终不超过 2。

- [ ] **Step 2: 运行 adapter/transfer tests，确认模块不存在而失败**

Run: `npx vitest run tests/integration/v3-tree-remote.test.ts tests/integration/blob-transfer.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现 strict v3 adapter 与分页 budget**

每页在 JSON parse 前检查 response bytes，strict schema 后累加 Folder/Page/Attachment 数量、manifest/body/attachment bytes；cursor 必须前进且不重复 entity。最终复算 Revision hash，与固定 head 比较。

- [ ] **Step 4: 实现 Blob 上传/下载调度器**

上传只处理 create-session 返回的 `missingContentHashes`，每次从 Vault 读取单图并切 1 MiB chunk，receipt 立刻写 journal；下载一次只保留当前 Blob 的 response bytes，验证后写 staging。AbortSignal 仅在 transfer/finalize 前生效；并发 worker 固定 `Math.min(2, serverLimit)`。

- [ ] **Step 5: 跑 adapter、retry 与资源边界 tests**

Run: `npx vitest run tests/integration/v3-tree-remote.test.ts tests/integration/blob-transfer.test.ts tests/unit/retry.test.ts tests/performance/bounded-space.test.ts`

Expected: PASS；1000 Attachment manifest 和 100 MiB transfer limit 不产生无界 Promise/数组复制。

- [ ] **Step 6: 提交 v3 adapter**

```bash
git add src/agentwiki src/application/blob-transfer.ts src/ports src/obsidian/adapters.ts tests
git commit -m "feat(sync): transfer v3 blobs through the remote port"
```

### Task 15: 扩展三方合并为 Attachment 身份、路径、内容与引用改写

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `src/core/merge.ts`
- Create: `src/core/attachment-merge.ts`
- Modify: `src/application/tree-diff.ts`
- Modify: `src/application/tree-preview.ts`
- Modify: `src/core/tree-validation.ts`
- Modify: `tests/unit/merge.test.ts`
- Create: `tests/unit/attachment-merge.test.ts`
- Modify: `tests/unit/tree-diff.test.ts`
- Modify: `tests/unit/tree-validation.test.ts`

**Interfaces:**

- Consumes: base/local/remote Attachment sets and parsed Page source ranges
- Produces: attachment merge plan, deterministic actions/blockers, explicit `local | remote | keep_both` resolution and rewritten Page bodies

```ts
export interface AttachmentConflict {
  conflictId: string;
  attachmentId: string;
  kind: "content" | "path" | "path_occupied";
  base: TreeAttachment | null;
  local: TreeAttachment | null;
  remote: TreeAttachment | null;
  affectedPageIds: string[];
}

export type AttachmentConflictResolution =
  | { choice: "local" }
  | { choice: "remote" }
  | {
      choice: "keep_both";
      primary: "local" | "remote";
      secondaryAttachmentId: string;
      secondaryPath: string;
      redirectPageIds: string[];
    };
```

- [ ] **Step 1: 写表驱动失败测试覆盖确认矩阵**

```ts
it.each([
  ["same path and hash", "bind"],
  ["local content only", "take_local_version"],
  ["remote content only", "take_remote_version"],
  ["local rename only", "rename_remote"],
  ["remote rename only", "rename_local"],
  ["different content both sides", "conflict"],
  ["different rename both sides", "conflict"],
])("merges %s as %s", (fixture, expected) => {
  expect(classifyAttachmentFixture(fixture).kind).toBe(expected);
});
```

另测目标 path 被另一 ID 占用、最后引用消失 detach、detach 后本地文件仍存在、不相关 Page body byte-for-byte 不变。

- [ ] **Step 2: 运行 merge/diff tests，确认 Tree 模型不识别 Attachment 而失败**

Run: `npx vitest run tests/unit/attachment-merge.test.ts tests/unit/tree-diff.test.ts tests/unit/tree-validation.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现独立 path/content 三方比较与自动场景**

同一个 `attachmentId` 分别比较 base/local/remote 的 `pathKey` 和 `contentHash`；只有一侧改变时自动采用；两侧同值改变自动合并；两侧不同值生成 conflict。首次绑定仅当 pathKey+hash 唯一匹配时自动复用远端 ID。

- [ ] **Step 4: 实现 keep-both，不猜测 Page 分流**

用户必须选择 primary 和明确的 `redirectPageIds`；secondary 获得新 UUID 和经协议验证的 `assets/name (2).ext`。任何未覆盖引用或路径占用保持 pending decision，确认按钮禁用。

- [ ] **Step 5: 用 source ranges 精确生成 Page rewrite action**

按 range 倒序改 path token；Obsidian alias/尺寸、Markdown alt/title/escaping 保持不变；标准 Markdown 对每个 Page 目录重算相对路径。range 与当前 body 不匹配时返回 blocker，不尝试全文替换。

- [ ] **Step 6: 跑合并、拓扑顺序和 invariant tests**

Run: `npx vitest run tests/unit/attachment-merge.test.ts tests/unit/merge.test.ts tests/unit/tree-diff.test.ts tests/unit/tree-validation.test.ts`

Expected: PASS；action order 保证 create/write image → rewrite Page → remove old image path → detach identity。

- [ ] **Step 7: 提交 Attachment merge**

```bash
git add src/core src/application/tree-diff.ts src/application/tree-preview.ts tests/unit
git commit -m "feat(sync): merge attachment identity path and content"
```

### Task 16: 将图片下载、Markdown 改写与旧路径清理纳入可恢复 Pull transaction

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `src/core/merge.ts`
- Modify: `src/application/tree-transaction.ts`
- Modify: `src/application/sync-runtime.ts`
- Modify: `src/application/progress.ts`
- Modify: `tests/integration/tree-transaction.test.ts`
- Modify: `tests/integration/sync-runtime.test.ts`
- Modify: `tests/fakes/fake-tree-remote.ts`
- Modify: `tests/fakes/memory-vault.ts`

**Interfaces:**

- Consumes: resolved v3 Pull preview and verified Blob staging
- Produces: journaled image create/replace/rename/detach operations, deterministic dependency order, safe rollback/ambiguous terminal state and committed v3 generation

```ts
export type AttachmentPullAction =
  | {
      kind: "write_attachment";
      attachmentId: string;
      path: string;
      stagedContentHash: string;
    }
  | {
      kind: "move_attachment";
      attachmentId: string;
      fromPath: string;
      toPath: string;
      contentHash: string;
    }
  | {
      kind: "detach_attachment";
      attachmentId: string;
      path: string;
    };
```

将 `AttachmentPullAction` 逐项加入现有 `TreePullAction` 联合类型；不重命名或复制既有 Folder/Page variants。

- [ ] **Step 1: 写失败测试锁定执行顺序和 before/after 恢复**

```ts
it("creates the new image before rewriting markdown and removes the old path last", async () => {
  await transaction.prepare(renameImagePull, "tx-1");
  await transaction.apply();
  expect(vault.operations).toEqual([
    "write:assets/new.png",
    "write:pages/note.md",
    "remove:assets/old.png",
  ]);
});
```

故障注入点：Blob staging verify 后、图片 write 后、Markdown write 后、旧路径 remove 后、generation write 后、pointer CAS 前。每点重启后只能达到完整 commit、完整 rollback 或 `TREE_TRANSACTION_AMBIGUOUS`。

- [ ] **Step 2: 运行 transaction/runtime tests，确认新 action 不支持而失败**

Run: `npx vitest run tests/integration/tree-transaction.test.ts tests/integration/sync-runtime.test.ts`

Expected: FAIL。

- [ ] **Step 3: 将 journal schema 升到 3 并记录每个受影响路径**

每个图片/Markdown path 记录 before/after `{ kind, hash }`；图片 before bytes 与下载 Blob 使用私有 sidecar，不内联 journal JSON。prepare 完成所有 before image 和 staged Blob 验证后才能进入 applying。

- [ ] **Step 4: 实现依赖顺序与安全回滚**

执行：创建 parent/新图片 → 写改写后的 Page → 删除仅属于受管 rename 的旧图片路径。`detach_attachment` 不触碰 Vault file。回滚仅当当前 hash 等于记录的 after hash；用户中途编辑任何 path 时标记 ambiguous，禁止覆盖。

- [ ] **Step 5: 在 `SyncRuntime.previewPull()` 中先下载、再合并、后确认**

固定 v3 Snapshot 校验完后只下载本地缺失或 hash 不同的 AttachmentVersion；总下载超过 capability 立即 blocker，不分批应用 Revision。bootstrap preview 用户确认后先调用 server bootstrap，随后固定新 v3 Revision 下载并再次展示实际 Pull preview。

当 Remote 只支持 v2/v1 时，先解析本地 Page 与固定远端 Snapshot 的 Page body。任一端出现 managed local-image candidate（即使文件缺失、路径歧义或扩展名不支持）都抛 `SYNC_PROTOCOL_UPGRADE_REQUIRED`，不得只同步 Markdown；两端都没有 candidate 时才继续现有 v2/v1 流程。HTTP(S)/data URI 仍按 external 忽略。

- [ ] **Step 6: 提交 generation/identity 的唯一原子切换**

Vault action 全部复核后写 v3 generation、验证 Revision hash，再 CAS pointer 和 active identity；任一步失败由 pull-control-after journal 恢复，旧 generation 仍可读。成功后才清理 staging/sidecars。

- [ ] **Step 7: 跑故障注入与重复 Pull 零操作测试**

Run: `npx vitest run tests/integration/tree-transaction.test.ts tests/integration/sync-runtime.test.ts tests/e2e/manual-sync-flow.test.ts`

Expected: PASS；同一 Revision 第二次 Pull 为零下载、零 Vault 写入、零冲突。

- [ ] **Step 8: 提交 v3 Pull**

```bash
git add src/core/merge.ts src/application/tree-transaction.ts src/application/sync-runtime.ts src/application/progress.ts tests
git commit -m "feat(sync): apply referenced images in recoverable pulls"
```

### Task 17: 将缺失 Blob 分块、change batches 与 Finalize 终态纳入 Push journal

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `src/application/tree-push-service.ts`
- Modify: `src/application/sync-runtime.ts`
- Modify: `src/application/progress.ts`
- Modify: `tests/integration/tree-push-service.test.ts`
- Modify: `tests/integration/sync-runtime.test.ts`
- Modify: `tests/fakes/fake-tree-remote.ts`
- Modify: `tests/performance/bounded-space.test.ts`

**Interfaces:**

- Consumes: confirmed v3 preview, local Attachment paths/hashes, v3 remote Blob methods
- Produces: `TreePushJournalV3`, resumable chunk receipts, confirmation revalidation and terminal local commit

```ts
interface TreePushJournalV3 {
  schemaVersion: 3;
  protocolVersion: "3";
  spaceId: string;
  baseRevision: string;
  idempotencyKey: string;
  confirmationHash: string;
  capabilitiesHash: string;
  changes: PreparedTreePushChangeV3[];
  requiredBlobs: Record<string, {
    vaultPath: string;
    sizeBytes: number;
    chunkReceipts: Record<string, string>;
    completed: boolean;
  }>;
  sessionId: string | null;
  remoteState:
    | "not_created"
    | "uploading_blobs"
    | "uploading_changes"
    | "finalizing"
    | "published"
    | "superseded";
  result: TreeFinalizeResult | null;
  localCommitPhase: "not_started" | "verified";
}
```

- [ ] **Step 1: 写失败测试覆盖 resume、取消与本地漂移**

```ts
it("resumes at the first unreceipted blob chunk", async () => {
  remote.failAfterChunk = 1;
  await expect(service.publishPrepared(preview)).rejects.toThrow();
  remote.failAfterChunk = null;
  await service.resumePending();
  expect(remote.uploadedChunkIndexes).toEqual([0, 1, 1, 2]);
  expect(remote.finalizeCalls).toBe(1);
});
```

覆盖：用户在 create 前取消会清 journal；上传期取消会 abort session；finalizing 后取消按钮失效；Blob 上传中本地图片改变停止 Finalize；Page/引用改变使 confirmation hash 失效；Finalize 响应丢失后只 query/retry terminal result。

- [ ] **Step 2: 运行 Push tests，确认 v2 journal/action 无法水化 Attachment 而失败**

Run: `npx vitest run tests/integration/tree-push-service.test.ts tests/integration/sync-runtime.test.ts`

Expected: FAIL。

- [ ] **Step 3: 扩展 prepared changes 与 confirmation manifest**

`upsert_attachment` 只保存 metadata + `vaultPath` sidecar reference，不把 bytes 放 JSON；Page upsert 包含 sorted unique `referencedAttachmentIds`。preview 确认时生成 exact v3 manifest/hash，journal 落盘并 verify 后才调用 create session。

- [ ] **Step 4: 先上传 server 声明缺失的 Blob，再上传 canonical change batches**

每次读取 Vault 前检查 path 当前 hash 与 preview；每个 chunk receipt 立刻持久化。`CAPABILITIES_CHANGED` 只允许清理 session 后完整重建 preview 一次；`BASE_STALE` 标记 superseded 并回到 Pull，不复用旧 confirmation。

- [ ] **Step 5: Finalize 前重扫并进入不可取消态**

重扫 Folder/Page/Attachment，复算 confirmation hash；不一致立即 abort。设置 journal `finalizing` 并持久化后调用 Finalize；此后只允许查询/重试相同 idempotent request，禁止重新上传或构造新 changes。

- [ ] **Step 6: 成功后验证已发布固定 Revision再提交本地 generation**

读取 Finalize 结果指向的 v3 head/snapshot，比较 revision hash/counts；本地再扫描仍等于已确认状态后提交 generation/identity。若本地在 Finalize 后变化，保留 published terminal result，不错误标记本地已同步，下一轮显示本地新改动。

- [ ] **Step 7: 跑恢复、资源上限和重复 Push 测试**

Run: `npx vitest run tests/integration/tree-push-service.test.ts tests/integration/sync-runtime.test.ts tests/performance/bounded-space.test.ts tests/e2e/manual-sync-flow.test.ts`

Expected: PASS；相同状态第二次 Push 不创建 session、不读未引用图片、不上传 Blob。

- [ ] **Step 8: 提交 v3 Push**

```bash
git add src/application/tree-push-service.ts src/application/sync-runtime.ts src/application/progress.ts tests
git commit -m "feat(sync): resume image blobs and atomic v3 pushes"
```

### Task 18: 在现有同步中心呈现统一图片预览与冲突选择

**Repository:** AgentWiki Obsidian 插件

**Files:**

- Modify: `src/application/sync-runtime.ts`
- Modify: `src/obsidian/sync-center-modal.ts`
- Modify: `src/obsidian/preview-modal.ts`
- Modify: `src/obsidian/preview-logic.ts`
- Modify: `src/core/user-errors.ts`
- Modify: `styles.css`
- Modify: `tests/unit/preview-logic.test.ts`
- Modify: `tests/unit/preview-modal-layout.test.ts`
- Modify: `tests/unit/user-errors.test.ts`
- Modify: `tests/integration/plugin-settings-lifecycle.test.ts`

**Interfaces:**

- Consumes: Pull/Push attachment actions, blockers, transfer bytes and conflict resolutions
- Produces: `Sync v3` unified summary, per-image rows, `local | server | keep both` choices, disabled confirmation until complete, bounded narrow-screen rendering

```ts
export interface AttachmentSyncDiff {
  uploads: number;
  downloads: number;
  replacements: number;
  renames: number;
  detached: number;
  uploadBytes: number;
  downloadBytes: number;
  transferLimitBytes: number;
  items: Array<{
    attachmentId: string;
    path: string;
    operation: string;
    sizeBytes: number;
    affectedPageCount: number;
  }>;
}
```

- [ ] **Step 1: 写失败 UI logic tests 锁定摘要和确认门**

```ts
it("keeps confirmation disabled while an attachment blocker is unresolved", () => {
  const preview = previewWithMissingAttachment();
  expect(pendingPreviewDecisionCount(preview)).toBe(1);
  expect(canRunSyncStrategy(preview)).toBe(false);
});
```

另测：协议标签为 `Sync v3`；上传/下载 bytes 与 capability 同时显示；detach 明确说明“两端文件保留”；keep-both 必须选 primary、secondary path 和 redirect Pages；错误文本不展示绝对路径/Blob URL。

- [ ] **Step 2: 运行 preview tests，确认现有 UI 仅支持 Folder/Page 而失败**

Run: `npx vitest run tests/unit/preview-logic.test.ts tests/unit/preview-modal-layout.test.ts tests/unit/user-errors.test.ts`

Expected: FAIL。

- [ ] **Step 3: 扩展现有 modal，不创建平行附件页**

`SyncDiff.protocolLabel` 增加 `"Sync v3"`，摘要加入图片动作与 bytes；详细区按路径稳定排序并分页/折叠，不加载缩略图原始 bytes。所有 blocker 顶部汇总、对象行可定位，确认按钮以 pending count 驱动。

- [ ] **Step 4: 映射可行动错误**

为八个 v3 错误码提供中文动作：修复引用、恢复文件、重命名、压缩图片、升级服务端/插件、重新 Pull。不得把 409 一律显示为普通冲突。

- [ ] **Step 5: 验证窄屏、键盘、取消边界**

360px 宽下不横向溢出；冲突选择、Page redirect 多选、确认/取消可键盘操作；扫描/校验/传输可取消，Finalize/Vault transaction 阶段显示不可取消原因。

Run: `npx vitest run tests/unit/preview-logic.test.ts tests/unit/preview-modal-layout.test.ts tests/unit/user-errors.test.ts tests/integration/plugin-settings-lifecycle.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交同步中心 UI**

```bash
git add src/application/sync-runtime.ts src/obsidian src/core/user-errors.ts styles.css tests
git commit -m "feat(ui): preview referenced image synchronization"
```

### Task 19: 完成兼容、故障注入、真实双端验收与插件发布证据

**Repository:** 先插件仓，再按授权读取已部署 AgentWiki；不得直接修改生产数据之外的范围

**Files:**

- Modify: `tests/e2e/manual-sync-flow.test.ts`
- Modify: `tests/performance/bounded-space.test.ts`
- Create: `tests/e2e/referenced-image-sync-v3.test.ts`
- Create: `docs/verification/referenced-image-sync-v3-2026-09-04.md`
- Modify: `README.md`
- Modify: `manifest.json`
- Modify: `versions.json`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**

- Consumes: deployed v3 server, published protocol package, isolated test Space/Vault, real Obsidian desktop and one mobile runtime
- Produces: full automated/real acceptance evidence and, only after separate release authorization, immutable plugin `0.4.0` artifacts

- [ ] **Step 1: 写端到端兼容矩阵并先看到缺口**

```ts
it.each([
  ["v3 server", "v3 plugin", "with images", "sync"],
  ["v3 server", "v3 plugin", "without images", "sync"],
  ["v2 server", "v3 plugin", "without candidates", "fallback"],
  ["v2 server", "v3 plugin", "with local candidate", "block"],
  ["v2 server", "v3 plugin", "with remote candidate", "block"],
  ["v1 server", "v3 plugin", "without candidates", "fallback"],
  ["v1 server", "v3 plugin", "with remote candidate", "block"],
  ["v3 attached revision", "v2 plugin", "with images", "upgrade"],
  ["v3 empty projection", "v2 plugin", "without images", "sync"],
])("handles %s + %s + %s as %s", async (server, plugin, fixture, result) => {
  expect(await runCompatibilityFixture(server, plugin, fixture)).toBe(result);
});
```

- [ ] **Step 2: 跑插件完整质量门**

Run: `npm run check`

Expected: format、lint、typecheck、全部 Vitest、build、bundle/release checks 全 PASS；bundle 无 `node:fs`、server internal import 或测试 fixture。

- [ ] **Step 3: 跑自动化 v3 E2E 与故障注入**

Run: `npx vitest run tests/e2e/referenced-image-sync-v3.test.ts tests/e2e/manual-sync-flow.test.ts tests/performance/bounded-space.test.ts`

覆盖网页→Obsidian、Obsidian→网页、内容替换、双端冲突、单/双端重命名、keep-both、detach、未引用图零传输；在 Blob upload/download、Finalize response、Vault image write、Markdown write、generation switch 注入失败并重启恢复。

- [ ] **Step 4: 在隔离 Space/Vault 做真实桌面验收**

用户单独确认执行后：网页上传 PNG/JPEG/WebP/GIF 并引用，真实插件 Pull 后断网仍可见；Vault 新增引用图 Push 后网页可见；浏览器网络面板确认 Blob 无公开 URL；重复 Pull/Push 零操作。记录 Space/Vault 标识的脱敏摘要、版本、时间和截图，不记录 credential。

- [ ] **Step 5: 在至少一个移动端运行时验证 Vault/FileManager 路径**

验证扫描、下载、写入、rename、恢复 journal 和 360px modal；若没有可用移动环境，验收状态必须明确为“未完成”，不能用桌面模拟或单元测试替代。

- [ ] **Step 6: 做发布前复查并提交源码/文档**

Run: `git status --short && git diff --check && npm run check`

Expected: 只有本功能预期文件；主仓用户改动未进入插件提交；验证文档分别列出本地、npm 协议、生产 API、GitHub、Obsidian 市场和真实安装 bundle 状态。

```bash
git add src tests docs/verification/referenced-image-sync-v3-2026-09-04.md README.md package.json package-lock.json styles.css
git commit -m "test(sync): verify referenced image sync v3"
```

- [ ] **Step 7: 仅在用户明确授权插件发布后升级到 0.4.0 并生成不可变资产**

同步更新 `manifest.json`、`versions.json`、`package.json` 和 lockfile；重新 `npm ci && npm run check`，然后先提交 release metadata，再创建新 tag，不覆写旧 tag/Release。

```bash
git add manifest.json versions.json package.json package-lock.json
git commit -m "chore(release): prepare AgentWiki Sync 0.4.0"
git tag v0.4.0
```

推送 `main` 与 `v0.4.0` 后只观察 tag-triggered workflow；GitHub Release 至少包含 `main.js`、`manifest.json`、`styles.css`，三者必须来自 tag checkout 并逐一核对 SHA-256/attestation，不手工创建重复 Release。

- [ ] **Step 8: 分渠道核对发布结果**

分别验证：本地分支/commit、`origin/main`、tag/GitHub Release/assets、Obsidian community list PR/合入状态、桌面搜索可见性、真实安装目录 bundle 版本、生产 v3 server。只有所有计划内渠道都有证据后，才能声明“完整发布”；市场审核未完成时必须单列为 pending。

---

## 完成定义

- 协议 v3 的公开包、服务端、网页端和插件都通过各自完整质量门与共享 test vectors。
- 任一可见 v3 Page Revision 都不存在缺失/未验证 Blob；任一失败只留下不可见、可 GC 的 Blob 或可恢复的本地 journal。
- 未引用图片不读取字节、不进入 manifest/preview、不上传/下载；detach 不删除或归档两端文件。
- v1/v2/v3 兼容矩阵无静默漏图路径，已进入 v3 的 Space/本地 generation 不自动降级。
- 真实桌面和移动端验收完成；本地、GitHub、npm、生产、市场与安装 bundle 状态分别有证据。
- 主仓和插件仓提交边界清晰，不包含用户当前脏工作树中的无关改动。
