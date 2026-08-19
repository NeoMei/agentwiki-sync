# AgentWiki Readable Sync Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AgentWiki allocate stable human-readable canonical Markdown paths, rename paths when titles change, and atomically migrate legacy `pages/p-<64 hex>.md` paths without changing page bodies or identities.

**Architecture:** Add one shared sync-path allocator under the existing global SyncModule, then route Web and ChangeSet page creation/title updates through it while holding the existing per-Space advisory lock. Add a one-shot, idempotent migration that reuses the allocator and `SpaceRevisionWriterService`, so Snapshot/Delta continue exposing one authoritative path without a protocol-version change.

**Tech Stack:** NestJS 10, TypeScript, Prisma 5/PostgreSQL, `@neomei/agentwiki-sync-protocol`, Jest, Node test runner, pnpm 11.

## Global Constraints

- Work in `/Users/neomei/项目/codexprojects/AgentWiki /agentwiki`; the directory name contains a trailing space before `/agentwiki`.
- The primary checkout is dirty and contains unrelated user work. At execution time, use `superpowers:using-git-worktrees`, branch from the agreed committed base, and never modify or stage the primary checkout's existing changes.
- `path` remains the authoritative shared `Page.syncPath`; do not add client-local path aliases or change sync protocol v1 fields.
- Default Web-created paths are `pages/<safe-title>.md`; collisions use the smallest available suffix starting at ` (2)` under Unicode 15.1 full casefold.
- A title change renames the basename inside the existing directory. A path stays stable when the sanitized basename is unchanged.
- Obsidian-supplied legal paths and legal knowledge-pipeline `sourcePath` values remain authoritative on creation.
- Page body, title, knowledgeKey/pageId, content hash semantics, source provenance, and Markdown heading lines are not rewritten by the path migration.
- All page/path/PageVersion/Revision mutations for one operation occur in one transaction under the existing Space advisory lock.
- No production deploy, database mutation, npm publication, tag, or release is authorized by this plan alone.

---

### Task 1: Shared readable path allocator

**Files:**
- Create: `apps/server/src/core/sync/readable-sync-path.service.ts`
- Create: `apps/server/src/core/sync/readable-sync-path.service.spec.ts`
- Modify: `apps/server/src/core/sync/sync.module.ts`

**Interfaces:**
- Consumes: `Prisma.TransactionClient`, `validatePortablePath(path)`, and `pathKey(path)` from `@neomei/agentwiki-sync-protocol`.
- Produces: `ReadableSyncPathService.allocate(tx, input): Promise<{ path: string; pathKey: string }>` and `safeMarkdownBasename(title): string`.

- [ ] **Step 1: Write failing allocator tests**

Add tests that instantiate the service with a fake transaction exposing `page.findMany()` and assert readable, portable, stable allocation:

```ts
it.each([
  ['吃饭睡觉打豆豆', '吃饭睡觉打豆豆'],
  ['  A / B  ', 'A B'],
  ['CON', '未命名文章'],
  ['.', '未命名文章'],
])('sanitizes %s to %s', (title, expected) => {
  expect(safeMarkdownBasename(title)).toBe(expected);
});

it('allocates the smallest casefold-safe suffix and excludes the current page', async () => {
  tx.page.findMany.mockResolvedValue([
    { id: 'other-1', syncPathKey: pathKey('pages/Guide.md') },
    { id: 'other-2', syncPathKey: pathKey('pages/guide (2).md') },
    { id: 'current', syncPathKey: pathKey('pages/Old.md') },
  ]);
  await expect(service.allocate(tx, {
    spaceId: 'space-1', directory: 'pages', title: 'GUIDE', excludePageId: 'current',
  })).resolves.toEqual({
    path: 'pages/GUIDE (3).md', pathKey: pathKey('pages/GUIDE (3).md'),
  });
});
```

Also cover NFC-equivalent titles, emoji, a title longer than a 255-byte segment, forbidden characters, empty/control-only titles, and an already-free candidate.

- [ ] **Step 2: Run the allocator tests and verify RED**

Run:

```bash
pnpm --filter @agentwiki/server test -- readable-sync-path.service.spec.ts
```

Expected: FAIL because `readable-sync-path.service.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal allocator**

Implement the following public surface. Build the basename by iterating Unicode code points, replacing forbidden/control/path characters with spaces, collapsing whitespace, trimming trailing dots/spaces, protecting Windows device names, and truncating by UTF-8 bytes while reserving room for ` (n).md`:

```ts
export interface ReadableSyncPathInput {
  spaceId: string;
  directory: string;
  title: string;
  excludePageId?: string;
}

export function safeMarkdownBasename(title: string): string;

@Injectable()
export class ReadableSyncPathService {
  async allocate(
    tx: Prisma.TransactionClient,
    input: ReadableSyncPathInput,
  ): Promise<{ path: string; pathKey: string }> {
    const occupied = await tx.page.findMany({
      where: {
        spaceId: input.spaceId,
        deletedAt: null,
        ...(input.excludePageId ? { id: { not: input.excludePageId } } : {}),
      },
      select: { syncPathKey: true },
    });
    const keys = new Set(occupied.map((page) => page.syncPathKey));
    const basename = safeMarkdownBasename(input.title);
    for (let suffix = 1; ; suffix += 1) {
      const name = suffix === 1 ? basename : `${basename} (${suffix})`;
      const candidate = validatePortablePath(`${input.directory}/${name}.md`);
      if (!keys.has(candidate.key))
        return { path: candidate.path, pathKey: candidate.key };
    }
  }
}
```

Register and export `ReadableSyncPathService` from the global `SyncModule`.

- [ ] **Step 4: Run allocator tests, typecheck, and lint**

Run:

```bash
pnpm --filter @agentwiki/server test -- readable-sync-path.service.spec.ts
pnpm --filter @agentwiki/server typecheck
pnpm lint
```

Expected: allocator tests PASS; typecheck and lint exit 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/server/src/core/sync/readable-sync-path.service.ts apps/server/src/core/sync/readable-sync-path.service.spec.ts apps/server/src/core/sync/sync.module.ts
git commit -m "feat(sync): allocate readable canonical page paths"
```

### Task 2: Web page creation and title-driven rename

**Files:**
- Modify: `apps/server/src/core/page/page.service.ts`
- Modify: `apps/server/src/core/page/page.service.spec.ts`

**Interfaces:**
- Consumes: `ReadableSyncPathService.allocate()` from Task 1 and `SpaceRevisionWriterService.lockSpace()`.
- Produces: Web create/update/restore operations whose Page and revision rows use the same readable path.

- [ ] **Step 1: Write failing PageService tests**

Extend the Nest testing module with a mocked `ReadableSyncPathService`. Add exact assertions:

```ts
it('creates a web page at its allocated title path', async () => {
  allocator.allocate.mockResolvedValue({ path: 'pages/吃饭睡觉.md', pathKey: 'pages/吃饭睡觉.md' });
  await service.create({ spaceId: 'space-1', title: '吃饭睡觉', content: '# 吃饭睡觉' }, 'user-1');
  expect(revisionWriter.lockSpace).toHaveBeenCalledWith(expect.anything(), 'space-1');
  expect(tx.page.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ syncPath: 'pages/吃饭睡觉.md' }),
  }));
  expect(revisionWriter.advance).toHaveBeenCalledWith(
    expect.anything(), 'space-1',
    [expect.objectContaining({ path: 'pages/吃饭睡觉.md', body: '# 吃饭睡觉' })],
    expect.anything(),
  );
});
```

Add update cases for: title change renames within the current directory, content-only update preserves path, sanitization-equivalent title preserves path, allocator collision returns `(2)`, PageVersion stores the old `syncPath/syncPathKey`, and revision `path` equals the updated Page path. Add restore coverage proving the restored title receives the corresponding basename while the restored body is unchanged.

- [ ] **Step 2: Run PageService tests and verify RED**

```bash
pnpm --filter @agentwiki/server test -- page.service.spec.ts
```

Expected: FAIL because PageService still constructs an opaque `pages/p-<64 hex>.md` path and does not inject the allocator.

- [ ] **Step 3: Route create/update/restore through the allocator**

Inject the allocator:

```ts
constructor(
  private readonly prisma: PrismaService,
  private readonly searchService: SearchService,
  private readonly revisionWriter: SpaceRevisionWriterService,
  private readonly syncPaths: ReadableSyncPathService,
  private readonly graphMaintenance: GraphMaintenance,
) {}
```

At the start of each page transaction call `await this.revisionWriter.lockSpace(tx, spaceId)`. On create allocate under `pages`. On title change derive the existing directory with `syncPath.slice(0, syncPath.lastIndexOf('/'))`, allocate with `excludePageId`, and include the new path fields in `page.update`. Every pre-change PageVersion must include:

```ts
syncPath: page.syncPath,
syncPathKey: page.syncPathKey,
```

Remove `idFileKey` fallback construction from Web create/update/restore. Keep archive `previousPath` unchanged.

- [ ] **Step 4: Run PageService and allocator regression suites**

```bash
pnpm --filter @agentwiki/server test -- page.service.spec.ts readable-sync-path.service.spec.ts
pnpm --filter @agentwiki/server typecheck
```

Expected: all selected tests PASS and typecheck exits 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add apps/server/src/core/page/page.service.ts apps/server/src/core/page/page.service.spec.ts
git commit -m "fix(pages): keep web titles and sync paths aligned"
```

### Task 3: ChangeSet page creation and title-driven rename

**Files:**
- Modify: `apps/server/src/review/review.service.ts`
- Modify: `apps/server/src/review/review.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 allocator; valid portable `sourcePath` remains preferred on create.
- Produces: Agent/ChangeSet-created pages that never fall back to a new opaque path, and title updates that advance a matching readable path revision.

- [ ] **Step 1: Write failing ReviewService tests**

Add tests for four cases:

```ts
it('uses a legal sourcePath without allocating a title path', async () => {
  await service.publish('change-set-with-source-path', 'user-1');
  expect(syncPaths.allocate).not.toHaveBeenCalled();
  expect(tx.page.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      syncPath: 'guides/Setup.md',
      syncPathKey: pathKey('guides/Setup.md'),
    }),
  }));
});

it('allocates a readable path when sourcePath is absent or non-portable', async () => {
  syncPaths.allocate.mockResolvedValue({
    path: 'pages/Guide.md', pathKey: pathKey('pages/Guide.md'),
  });
  await service.publish('change-set-without-source-path', 'user-1');
  expect(syncPaths.allocate).toHaveBeenCalledWith(expect.anything(), {
    spaceId: 'space-1', directory: 'pages', title: 'Guide',
  });
});

it('renames the existing path when an accepted update changes title', async () => {
  syncPaths.allocate.mockResolvedValue({
    path: 'guides/New.md', pathKey: pathKey('guides/New.md'),
  });
  await service.publish('change-set-title-update', 'user-1');
  expect(tx.pageVersion.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ syncPath: 'guides/Old.md' }),
  }));
  expect(tx.page.update).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ title: 'New', syncPath: 'guides/New.md' }),
  }));
  expect(revisionWriter.advance).toHaveBeenCalledWith(
    expect.anything(), 'space-1',
    [expect.objectContaining({ path: 'guides/New.md' })],
    expect.anything(),
  );
});

it('preserves body bytes including a matching H1 during path allocation', async () => {
  await service.publish('change-set-heading-body', 'user-1');
  expect(tx.page.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ content: '# Title\n\nBody' }),
  }));
  expect(revisionWriter.advance).toHaveBeenCalledWith(
    expect.anything(), 'space-1',
    [expect.objectContaining({ body: '# Title\n\nBody' })],
    expect.anything(),
  );
});
```

Implement the named ChangeSet fixtures in the existing `beforeEach` mock data using the same accepted-item shape already used by `review.service.spec.ts`.

Mock `ReadableSyncPathService` in every existing ReviewService test module so unrelated tests keep explicit dependencies.

- [ ] **Step 2: Run ReviewService tests and verify RED**

```bash
pnpm --filter @agentwiki/server test -- review.service.spec.ts
```

Expected: FAIL because missing/invalid source paths still become an opaque `p-<64 hex>.md` path, and title updates do not modify syncPath.

- [ ] **Step 3: Implement ChangeSet path allocation**

Inject `ReadableSyncPathService`. After the existing transaction claims a ChangeSet, acquire the Space lock before page mutation. For create, accept `validatePortablePath(payload.sourcePath)` only when it succeeds; otherwise call the allocator under `pages`. For title updates, allocate in the existing path directory with `excludePageId`. Add `syncPath/syncPathKey` to the PageVersion `data` and to the captured `before` payload. Ensure `revisionWriter.advance()` receives the final Page path and unchanged content.

- [ ] **Step 4: Run Review, Page, allocator, and module graph tests**

```bash
pnpm --filter @agentwiki/server test -- review.service.spec.ts page.service.spec.ts readable-sync-path.service.spec.ts app.module.spec.ts
pnpm --filter @agentwiki/server typecheck
```

Expected: all selected tests PASS and the production Nest module graph compiles.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/server/src/review/review.service.ts apps/server/src/review/review.service.spec.ts
git commit -m "fix(review): publish readable page sync paths"
```

### Task 4: Idempotent opaque-path migration

**Files:**
- Create: `scripts/migrate-readable-sync-paths.mjs`
- Create: `scripts/readable-sync-path-migration-db.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: compiled `ReadableSyncPathService`, `SpaceRevisionWriterService`, and Prisma Client.
- Produces: exported `migrateReadablePathsForSpace(prisma, spaceId, batchId)` plus CLI script `pnpm migrate:readable-sync-paths`.

- [ ] **Step 1: Write a failing real-DB migration test**

Reuse the isolated-schema setup and teardown functions from `scripts/sync-v1-backfill-failure-db.test.mjs`, then seed one Space with:

```js
[
  { knowledgeKey: 'page-a', title: '吃饭睡觉', syncPath: `pages/p-${'a'.repeat(64)}.md`, content: '# 吃饭睡觉' },
  { knowledgeKey: 'page-b', title: '吃饭睡觉', syncPath: `pages/p-${'b'.repeat(64)}.md`, content: '正文' },
  { knowledgeKey: 'page-c', title: 'Keep', syncPath: 'custom/Keep.md', content: 'keep' },
]
```

Assert one run produces `pages/吃饭睡觉.md`, `pages/吃饭睡觉 (2).md`, and unchanged `custom/Keep.md`; bodies, titles, knowledgeKeys and content hashes remain unchanged; one migration Revision contains path-only upserts; PageVersions record old paths and the fixed batch ID. Run the migration again and assert no additional PageVersion or Revision. Inject a forced update failure and assert every path/version/revision rolls back.

- [ ] **Step 2: Run the DB test and verify RED**

```bash
node --test scripts/readable-sync-path-migration-db.test.mjs
```

Expected with `DATABASE_URL`: FAIL because the migration module does not exist. Without `DATABASE_URL`: one explicit SKIP, not a false PASS.

- [ ] **Step 3: Implement the one-shot migration**

Export:

```js
export async function migrateReadablePathsForSpace(prisma, spaceId, batchId) {
  return prisma.$transaction(async (tx) => {
    const writer = new SpaceRevisionWriterService(prisma);
    const allocator = new ReadableSyncPathService();
    await writer.lockSpace(tx, spaceId);
    const pages = (await tx.page.findMany({
      where: { spaceId, deletedAt: null },
      orderBy: { knowledgeKey: 'asc' },
    })).filter((page) => /^pages\/p-[0-9a-f]{64}\.md$/u.test(page.syncPath));
    if (pages.length === 0) return { migrated: 0, revisionId: null };
    const changes = [];
    for (const page of pages) {
      const allocated = await allocator.allocate(tx, {
        spaceId,
        directory: 'pages',
        title: page.title,
        excludePageId: page.id,
      });
      await tx.pageVersion.upsert({
        where: { pageId_migrationBatchId: { pageId: page.id, migrationBatchId: batchId } },
        create: {
          pageId: page.id,
          title: page.title,
          content: page.content,
          authorId: page.authorId,
          slug: page.slug,
          format: page.format,
          parentId: page.parentId,
          syncPath: page.syncPath,
          syncPathKey: page.syncPathKey,
          migrationBatchId: batchId,
        },
        update: {},
      });
      await tx.page.update({
        where: { id: page.id },
        data: { syncPath: allocated.path, syncPathKey: allocated.pathKey },
      });
      changes.push({
        operation: 'upsert',
        pageId: page.knowledgeKey,
        path: allocated.path,
        title: page.title,
        body: page.content,
      });
    }
    const revision = await writer.advance(tx, spaceId, changes, {
      origin: 'migration', migrationBatchId: batchId,
    });
    return { migrated: pages.length, revisionId: revision.revisionId };
  });
}
```

Instantiate writer with the transaction-compatible Prisma root in the same pattern as existing DB scripts. The CLI enumerates non-deleted Spaces in stable ID order and uses fixed batch ID `readable-sync-path-v1:<spaceId>`.

Add:

```json
"migrate:readable-sync-paths": "pnpm --filter @agentwiki/server build && node scripts/migrate-readable-sync-paths.mjs"
```

- [ ] **Step 4: Run migration and existing sync DB gates**

```bash
pnpm --filter @agentwiki/server build
node --test scripts/readable-sync-path-migration-db.test.mjs
node --test scripts/sync-v1-writer-db.test.mjs scripts/sync-v1-snapshot-fixed-revision-db.test.mjs
```

Expected: all configured DB tests PASS; unavailable DB is reported only as explicit skips.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/migrate-readable-sync-paths.mjs scripts/readable-sync-path-migration-db.test.mjs package.json
git commit -m "feat(sync): migrate opaque page paths atomically"
```

### Task 5: Contract alignment and full verification

**Files:**
- Modify: `docs/contracts/agentwiki-obsidian-sync-api-v1.md`
- Modify: `docs/verification/obsidian-sync-v1-acceptance-matrix.md`
- Create: `docs/verification/readable-sync-paths-2026-08-20.md`

**Interfaces:**
- Consumes: Tasks 1-4 behavior and test evidence.
- Produces: updated authoritative contract and a release-ready, non-deployment verification record for the plugin plan.

- [ ] **Step 1: Update the contract with exact path rules**

Replace the rule forbidding title-derived fallback paths with the approved allocator rules: safe title basename, stable `pages/Title.md`, minimum collision suffix, original-directory rename on title edit, valid source/local paths preserved, and strict opaque migration matching. State explicitly that body bytes and Markdown H1 lines are not changed by path allocation.

- [ ] **Step 2: Run the complete repository matrix**

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all commands exit 0; record exact pass/skip counts rather than paraphrasing.

- [ ] **Step 3: Run configured real-DB sync suites**

```bash
node --test scripts/readable-sync-path-migration-db.test.mjs scripts/sync-v1-*.test.mjs
```

Expected: all suites with available `DATABASE_URL` PASS; any unavailable external dependency is an explicit documented SKIP.

- [ ] **Step 4: Write verification evidence**

Record branch/commit, Node/pnpm versions, commands, exact test counts, migration dry-run output on an isolated database, known warnings, and confirmation that no production database or deployment was touched.

- [ ] **Step 5: Commit Task 5**

```bash
git add docs/contracts/agentwiki-obsidian-sync-api-v1.md docs/verification/obsidian-sync-v1-acceptance-matrix.md docs/verification/readable-sync-paths-2026-08-20.md
git commit -m "docs(sync): specify and verify readable page paths"
```

### Task 6: Independent review and integration handoff

**Files:**
- Review only: all commits produced by Tasks 1-5.

**Interfaces:**
- Consumes: clean feature branch and verification record.
- Produces: reviewed commit range ready to reconcile with the user's dirty primary AgentWiki branch; no automatic merge or deploy.

- [ ] **Step 1: Request correctness review**

Use `superpowers:requesting-code-review` against the feature-base commit. Require review of collision allocation, transaction locks, PageVersion audit fields, migration idempotency, content preservation, and revision hashes.

- [ ] **Step 2: Address every Critical/Important finding with TDD**

For each finding, add a failing regression test, confirm RED, apply the smallest fix, and rerun the targeted plus full matrix. Do not batch unrelated reviewer suggestions.

- [ ] **Step 3: Verify the primary checkout was untouched**

```bash
git -C '/Users/neomei/项目/codexprojects/AgentWiki /agentwiki' status --short
```

Expected: exactly the pre-existing dirty paths captured before execution; no feature files appear in the primary checkout.

- [ ] **Step 4: Prepare handoff metadata**

Report the feature branch, base SHA, final SHA, commit list, tests, and overlapping primary-checkout files (`page.service.ts`, `review.service.ts`, and related specs/modules). Stop before cherry-pick, merge, deploy, or database migration unless separately authorized against a clean integration target.
