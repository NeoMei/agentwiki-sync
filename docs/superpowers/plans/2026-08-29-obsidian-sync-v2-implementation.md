# AgentWiki Sync v2 Obsidian Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade AgentWiki Sync for Obsidian to automatically use Sync API v2 on upgraded servers and safely synchronize the full Folder/Page tree, including empty folders, without a protocol selector.

**Architecture:** A server-scoped negotiator selects v2 when `/api/sync/v2/capabilities` is available and selects v1 only for an explicitly legacy server. Both HTTP adapters expose one `TreeRemotePort`; the application runtime, baseline, diff, transaction, preview, and recovery layers operate only on the common tree model. Existing v1 state is imported as a zero-folder tree and retained as read-only recovery evidence until a confirmed v2 transaction commits.

**Tech Stack:** TypeScript 5.9, Obsidian 1.11 Vault/FileManager APIs, Zod, Vitest, esbuild, `@neomei/agentwiki-sync-protocol@0.4.0`

**Spec:** `docs/superpowers/specs/2026-08-29-obsidian-sync-v2-design.md`

## Global Constraints

- AgentWiki main repository and production remain read-only throughout implementation.
- Use `@neomei/agentwiki-sync-protocol@0.4.0` as the public v2 contract; do not import AgentWiki server or `packages/local-sync` internals.
- Upgraded servers always use protocol `"2"`, including Spaces with zero folders; the UI has no protocol selector.
- Fall back to protocol `"1"` only when `/api/sync/v2/capabilities` explicitly returns endpoint missing or `PROTOCOL_UNSUPPORTED`; authentication, permission, network, schema, hash, cursor, and other v2 failures must stop.
- Managed remote paths stay under `pages/`; `.agentwiki/`, credentials, journals, previews, and mapping-root-external files never enter a remote manifest.
- Use Obsidian Vault and FileManager APIs only; do not add `node:fs`, inode, symlink, or platform-specific runtime dependencies.
- Pull and Push remain preview-first and require explicit user confirmation; production Vault/Space validation stops before confirmation unless separately authorized.
- Every persistent schema rejects unknown future versions and uses the existing envelope/candidate atomic-write pattern.
- Do not push GitHub, publish npm/Obsidian assets, or deploy in this plan.

---

### Task 1: Install the public v2 protocol and restore a clean test boundary

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.ts`
- Modify: `tests/integration/protocol-conformance.test.ts`

**Interfaces:**

- Consumes: published package exports from `@neomei/agentwiki-sync-protocol@0.4.0`
- Produces: verified exports `SYNC_PROTOCOL_V2`, `TreeCapabilitiesResponseV2Schema`, `TreeRevisionHeadResponseV2Schema`, `TreeSnapshotPageV2Schema`, `TreeDeltaPageV2Schema`, `treeRevisionContentHashV2`, `treeConfirmationHashV2`, and `partitionTreePushChangesV2`

- [ ] **Step 1: Add a failing v2 conformance test and a test-runner boundary assertion**

```ts
import {
  SYNC_PROTOCOL_V2,
  TreeCapabilitiesResponseV2Schema,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";

it("loads the published v2 tree contract", async () => {
  expect(SYNC_PROTOCOL_V2).toBe("2");
  expect(
    TreeCapabilitiesResponseV2Schema.parse({
      protocolVersion: "2",
      capabilities: {
        maxPageBytes: 1,
        maxBatchBytes: 1,
        maxBatchItems: 1,
        maxChangeCount: 1,
        maxConfirmationBytes: 1,
        maxClientSpacePages: 1,
        maxClientSpaceFolders: 1,
        maxSnapshotObjects: 2,
        maxClientManifestBytes: 1,
        maxClientTotalBodyBytes: 1,
        maxDeltaItems: 1,
        maxResponseBytes: 1,
        maxPageItems: 1,
        pushSessionTtlSeconds: 1,
      },
      capabilitiesHash: "0".repeat(64),
    }).protocolVersion,
  ).toBe("2");
  expect(
    await treeRevisionContentHashV2({
      protocolVersion: "2",
      spaceId: "space",
      folders: [],
      pages: [],
    }),
  ).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: Run the focused test and verify the installed `0.1.0` package cannot satisfy it**

Run: `npx vitest run tests/integration/protocol-conformance.test.ts`

Expected: FAIL because the v2 exports are absent.

- [ ] **Step 3: Upgrade the dependency and exclude generated worktrees from Vitest**

Run: `npm install --save-exact @neomei/agentwiki-sync-protocol@0.4.0`

```ts
// vitest.config.ts
test: {
  environment: "node",
  setupFiles: ["./tests/setup.ts"],
  exclude: ["**/node_modules/**", "**/.git/**", "**/.worktrees/**"],
},
```

- [ ] **Step 4: Run protocol conformance and the whole current suite**

Run: `npx vitest run tests/integration/protocol-conformance.test.ts && npm test`

Expected: v2 conformance passes and the existing 32-file suite no longer discovers `.worktrees/**`.

- [ ] **Step 5: Commit the dependency/test-boundary change**

```bash
git add package.json package-lock.json vitest.config.ts tests/integration/protocol-conformance.test.ts
git commit -m "build: adopt AgentWiki sync protocol v2"
```

### Task 2: Negotiate v2 once per server identity without a protocol choice

**Files:**

- Create: `src/application/protocol-negotiator.ts`
- Create: `src/storage/protocol-selection.ts`
- Modify: `src/application/connection-service.ts`
- Test: `tests/unit/protocol-negotiator.test.ts`
- Test: `tests/integration/client-connection.test.ts`

**Interfaces:**

- Consumes: `AgentWikiClient.raw()`, normalized server origin, `serverInstanceId`, and `TreeCapabilitiesResponseV2Schema`
- Produces: `SyncProtocolSelection`, `ProtocolSelectionRepository.readFor()`, and `ProtocolNegotiator.select()`

```ts
export type SyncProtocolSelection =
  | {
      version: "2";
      capabilities: TreeSyncCapabilitiesV2;
      capabilitiesHash: string;
    }
  | { version: "1"; reason: "endpoint_missing" | "protocol_unsupported" };

export interface ProtocolProbeIdentity {
  serverOrigin: string;
  serverInstanceId: string;
  pluginVersion: string;
}
```

- [ ] **Step 1: Write negotiation tests for v2, explicit legacy, and forbidden fallback**

```ts
it("uses v1 only when the v2 endpoint is absent", async () => {
  const client = fakeClientRejecting(new AgentWikiHttpError(404, {}));
  await expect(negotiator(client).select(identity)).resolves.toEqual({
    version: "1",
    reason: "endpoint_missing",
  });
});

it("uses v1 when the server explicitly rejects protocol v2", async () => {
  const client = fakeClientRejecting(
    syncHttpError(400, "PROTOCOL_UNSUPPORTED"),
  );
  await expect(negotiator(client).select(identity)).resolves.toEqual({
    version: "1",
    reason: "protocol_unsupported",
  });
});

it.each([401, 403, 409, 500])(
  "does not downgrade a real v2 failure (%s)",
  async (status) => {
    const client = fakeClientRejecting(new AgentWikiHttpError(status, {}));
    await expect(negotiator(client).select(identity)).rejects.toMatchObject({
      status,
    });
  },
);

it("does not downgrade malformed capabilities", async () => {
  const client = fakeClientReturning({
    protocolVersion: "2",
    capabilities: {},
  });
  await expect(negotiator(client).select(identity)).rejects.toThrow();
});
```

- [ ] **Step 2: Run the tests and verify the negotiator is missing**

Run: `npx vitest run tests/unit/protocol-negotiator.test.ts tests/integration/client-connection.test.ts`

Expected: FAIL with missing module/symbol errors.

- [ ] **Step 3: Implement strict selection and an envelope-backed cache**

```ts
export class ProtocolNegotiator {
  constructor(
    private readonly client: AgentWikiClient,
    private readonly repository: ProtocolSelectionRepository,
  ) {}

  async select(
    identity: ProtocolProbeIdentity,
  ): Promise<SyncProtocolSelection> {
    const cached = await this.repository.readFor(identity);
    if (cached) return cached;
    try {
      const parsed = TreeCapabilitiesResponseV2Schema.parse(
        (await this.client.raw("GET", "/api/sync/v2/capabilities")).json,
      );
      if (
        (await capabilitiesHash(parsed.capabilities)) !==
        parsed.capabilitiesHash
      )
        throw new Error("Sync v2 capability hash mismatch");
      const selected = {
        version: "2" as const,
        capabilities: parsed.capabilities,
        capabilitiesHash: parsed.capabilitiesHash,
      };
      await this.repository.write(identity, selected);
      return selected;
    } catch (error) {
      const code = syncErrorCode(error);
      if (
        !(error instanceof AgentWikiHttpError) ||
        !(error.status === 404 || code === "PROTOCOL_UNSUPPORTED")
      )
        throw error;
      const selected = {
        version: "1" as const,
        reason:
          code === "PROTOCOL_UNSUPPORTED"
            ? ("protocol_unsupported" as const)
            : ("endpoint_missing" as const),
      };
      await this.repository.write(identity, selected);
      return selected;
    }
  }
}
```

`ProtocolSelectionRepository` stores schema version `1`, server origin, server instance ID, plugin version, selection, and v2 capability hash in `ObsidianLocalControlStore`. A server identity or plugin-version mismatch returns `null`; an unknown schema version throws. This forces a fresh probe after reconnect, server replacement, or plugin upgrade.

- [ ] **Step 4: Advertise both supported versions during credential exchange**

```ts
supportedProtocolVersions: ["2", "1"],
```

Keep the onboarding request's `requestedProtocolVersion: "1"`; it is the stable credential bootstrap contract, not the selected sync protocol.

- [ ] **Step 5: Run the focused tests and commit**

Run: `npx vitest run tests/unit/protocol-negotiator.test.ts tests/integration/client-connection.test.ts`

```bash
git add src/application/protocol-negotiator.ts src/storage/protocol-selection.ts src/application/connection-service.ts tests/unit/protocol-negotiator.test.ts tests/integration/client-connection.test.ts
git commit -m "feat: negotiate sync v2 automatically"
```

### Task 3: Define the protocol-neutral tree model and validation boundary

**Files:**

- Create: `src/core/tree-model.ts`
- Create: `src/core/tree-validation.ts`
- Test: `tests/unit/tree-validation.test.ts`

**Interfaces:**

- Produces: `TreeFolder`, `TreePage`, `TreeSnapshot`, `TreeDeltaItem`, `TreePushChange`, `validateTreeSnapshot()`, `sortTreeChanges()`

```ts
export interface TreeFolder {
  folderId: string;
  parentFolderId: string | null;
  name: string;
  path: string;
  sortOrder: number;
  updatedAt: string;
}

export interface TreePage {
  pageId: string;
  folderId: string | null;
  path: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}

export interface TreeSnapshot {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  revisionContentHash: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

export type TreeDeltaItem =
  | { operation: "upsert_folder"; folder: TreeFolder }
  | { operation: "archive_folder"; folderId: string; previousPath: string }
  | { operation: "upsert_page"; page: TreePage }
  | { operation: "archive_page"; pageId: string; previousPath: string };
export type TreePushChange = TreeDeltaItem;
```

- [ ] **Step 1: Write failures for duplicate IDs, case/Unicode collisions, unknown parents, cycles, and file/directory collisions**

```ts
it("rejects a folder cycle", () => {
  expect(() =>
    validateTreeSnapshot(
      snapshot({
        folders: [folder("a", "b", "pages/A"), folder("b", "a", "pages/B")],
      }),
    ),
  ).toThrow(/cycle|循环/);
});

it("rejects a page colliding with a directory pathKey", () => {
  expect(() =>
    validateTreeSnapshot(
      snapshot({
        folders: [folder("f", null, "pages/Guide.md")],
        pages: [page("p", null, "pages/guide.md")],
      }),
    ),
  ).toThrow(/PATH_COLLISION/);
});
```

- [ ] **Step 2: Run the test and verify the tree boundary is absent**

Run: `npx vitest run tests/unit/tree-validation.test.ts`

Expected: FAIL with missing module.

- [ ] **Step 3: Implement validation entirely with the published portable-path helpers**

```ts
export function validateTreeSnapshot(input: TreeSnapshot): TreeSnapshot {
  const folders = input.folders.map((folder) => ({
    ...folder,
    path: validatePortableDirectoryPath(folder.path).path,
  }));
  const pages = input.pages.map((page) => ({
    ...page,
    path:
      input.protocolVersion === "2"
        ? validatePortableMarkdownPath(page.path).path
        : validatePortablePath(page.path).path,
  }));
  if (input.protocolVersion === "2")
    assertManagedRoot(folders, pages, "pages/");
  else if (folders.length > 0)
    throw new TypeError("Sync v1 cannot contain folders");
  assertUniqueIdsAndPathKeys(folders, pages);
  assertParentsAndNoCycles(folders, pages);
  return { ...input, folders, pages };
}
```

`sortTreeChanges()` orders archive pages, child-first archive folders, parent-first upsert folders, then upsert pages. Its tie breaker is `pathKey`, stable object ID, and operation.

- [ ] **Step 4: Run the test and commit**

Run: `npx vitest run tests/unit/tree-validation.test.ts`

```bash
git add src/core/tree-model.ts src/core/tree-validation.ts tests/unit/tree-validation.test.ts
git commit -m "feat: add validated sync tree model"
```

### Task 4: Add directory-aware Vault scanning and stable local folder identities

**Files:**

- Modify: `src/ports/vault.ts`
- Modify: `src/obsidian/adapters.ts`
- Modify: `tests/fakes/memory-vault.ts`
- Modify: `tests/fakes/obsidian-mock.ts`
- Create: `src/core/tree-scan.ts`
- Create: `src/storage/tree-identities.ts`
- Test: `tests/unit/obsidian-adapters.test.ts`
- Test: `tests/unit/tree-scan.test.ts`

**Interfaces:**

- Extends `VaultPort` with `listTree()`, `pathStatus()`, `createDirectory()`, and `trashDirectory()`
- Produces: `LocalTreeScan`, `TreeIdentityState`, and `scanLocalTree()`

```ts
export interface VaultTreeEntry {
  relativePath: string;
  kind: "directory" | "markdown";
  bytes?: Uint8Array;
}

export interface VaultPort {
  listTree(rootPath: string): AsyncIterable<VaultTreeEntry>;
  pathStatus(path: string): Promise<"directory" | "file" | "missing">;
  createDirectory(path: string): Promise<void>;
  trashDirectory(path: string): Promise<void>;
  // existing file methods remain
}
```

- [ ] **Step 1: Write failing adapter tests for empty folders and FileManager trash**

```ts
it("enumerates empty directories and markdown files under the mapping root", async () => {
  vault.folders.add("Wiki/pages/Empty");
  vault.files.set("Wiki/pages/A.md", "a");
  expect(await collect(port.listTree("Wiki"))).toEqual([
    { kind: "directory", relativePath: "pages" },
    {
      kind: "markdown",
      relativePath: "pages/A.md",
      bytes: encoder.encode("a"),
    },
    { kind: "directory", relativePath: "pages/Empty" },
  ]);
});

it("trashes a directory through FileManager", async () => {
  await port.trashDirectory("Wiki/pages/Empty");
  expect(manager.trashed).toEqual(["Wiki/pages/Empty"]);
});
```

- [ ] **Step 2: Run adapter/tree-scan tests and verify they fail**

Run: `npx vitest run tests/unit/obsidian-adapters.test.ts tests/unit/tree-scan.test.ts`

Expected: FAIL because directory methods and scanner do not exist.

- [ ] **Step 3: Implement Vault traversal using `TFolder.children` and mapping-root checks**

```ts
async *listTree(rootPath: string): AsyncIterable<VaultTreeEntry> {
  const root = this.vault.getAbstractFileByPath(this.safe(rootPath));
  if (!(root instanceof TFolder)) return;
  const visit = async function* (folder: TFolder): AsyncIterable<VaultTreeEntry> {
    for (const child of [...folder.children].sort((a, b) => a.path.localeCompare(b.path))) {
      if (child instanceof TFolder) {
        yield { kind: "directory", relativePath: relative(child.path) };
        yield* visit(child);
      } else if (child instanceof TFile && child.extension.toLowerCase() === "md") {
        yield { kind: "markdown", relativePath: relative(child.path), bytes: new Uint8Array(await vault.readBinary(child)) };
      }
    }
  };
  yield* visit(root);
}
```

`trashDirectory()` resolves a `TFolder` and passes it to `FileManager.trashFile()`. `MemoryVault` tracks directories separately so empty directories survive scans and fault injection. The Obsidian mock gives `TFolder` a `children: Array<TFile | TFolder>` collection so adapter tests exercise the same traversal shape as Obsidian.

- [ ] **Step 4: Implement folder identity resolution**

```ts
export interface TreeIdentityState {
  schemaVersion: 1;
  folders: Record<string, { folderId: string; path: string; pathKey: string }>;
  pendingFolders: Record<
    string,
    { folderId: string; path: string; pathKey: string }
  >;
  pendingPages: Record<
    string,
    { pageId: string; path: string; contentHash: string }
  >;
}

export async function scanLocalTree(
  vault: VaultPort,
  rootPath: string,
  base: TreeSnapshot,
  identities: TreeIdentityState,
  limits: TreeScanLimits,
): Promise<LocalTreeScan>;
```

Known folders resolve by `folderId -> pathKey`; an observed rename/move keeps the ID through the identity state. New directories/pages receive UUID v4 and are written to pending identities before preview construction.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/obsidian-adapters.test.ts tests/unit/tree-scan.test.ts`

```bash
git add src/ports/vault.ts src/obsidian/adapters.ts tests/fakes/memory-vault.ts tests/fakes/obsidian-mock.ts src/core/tree-scan.ts src/storage/tree-identities.ts tests/unit/obsidian-adapters.test.ts tests/unit/tree-scan.test.ts
git commit -m "feat: scan Vault folder trees"
```

### Task 5: Persist v2 tree generations and import the v1 baseline safely

**Files:**

- Create: `src/storage/tree-generation.ts`
- Create: `src/storage/tree-baseline.ts`
- Modify: `src/storage/baseline.ts`
- Test: `tests/unit/tree-generation.test.ts`
- Test: `tests/integration/tree-baseline-upgrade.test.ts`

**Interfaces:**

- Consumes: current `BaselineRepository.read()` as read-only v1 evidence
- Produces: `TreeGenerationManifestV2`, `TreeBaselineRepository.read()`, `prepare()`, `commit()`, `recover()`, and `readLegacyEvidence()`

```ts
export interface TreeGenerationManifestV2 {
  schemaVersion: 2;
  protocolVersion: "2";
  generationId: string;
  spaceId: string;
  rootPath: string;
  baseRevision: string;
  baseRevisionContentHash: string;
  baseFolderCount: number;
  basePageCount: number;
  baseRevisionManifestByteLength: number;
  baseRevisionBodyBytes: number;
  lastSuccessfulSyncAt: string;
  folders: Record<
    string,
    Omit<TreeFolder, "updatedAt"> & { updatedAt: string }
  >;
  pages: Record<string, Omit<TreePage, "body">>;
}
```

- [ ] **Step 1: Write failing storage tests for empty folders, corruption, and future schemas**

```ts
it("round-trips an empty folder in a v2 generation", async () => {
  const tree = snapshot({
    folders: [folder("f1", null, "pages/Empty")],
    pages: [],
  });
  await repository.prepare(tree, "initialize");
  await repository.commit();
  expect((await repository.read()).folders.f1.path).toBe("pages/Empty");
});

it("rejects a future manifest schema", async () => {
  await store.write(manifestPath, JSON.stringify({ schemaVersion: 3 }));
  await expect(repository.read()).rejects.toThrow(/更新|版本/);
});
```

- [ ] **Step 2: Run the storage tests and verify they fail**

Run: `npx vitest run tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts`

- [ ] **Step 3: Implement v2 generation verification with public tree hashes**

```ts
const revisionHash = await treeRevisionContentHashV2({
  protocolVersion: "2",
  spaceId: manifest.spaceId,
  folders: Object.values(manifest.folders),
  pages: await hydratePages(manifest.pages),
});
if (revisionHash !== manifest.baseRevisionContentHash)
  throw new Error("基线损坏: 树修订哈希不匹配");
```

Bodies remain separate readable control files; folder metadata is in the manifest. Pointer and journal paths live under the existing per-device/per-Space root with `tree-v2/`, leaving v1 `current.json` and generations untouched.

- [ ] **Step 4: Read v1 state as zero-folder upgrade evidence**

```ts
async readLegacyEvidence(legacy: BaselineRepository): Promise<TreeSnapshot | null> {
  const base = await legacy.read();
  if (base.revision === "0" && Object.keys(base.pages).length === 0) return null;
  return validateTreeSnapshot({
    protocolVersion: "1",
    spaceId: this.spaceId,
    revision: base.revision,
    revisionContentHash: "",
    folders: [],
    pages: await Promise.all(Object.values(base.pages).map(async (page) => ({
      pageId: page.pageId,
      folderId: null,
      path: page.relativePath,
      title: page.title,
      body: await legacy.readBody(page.pageId, base.generationId, page.contentHash),
      contentHash: page.contentHash,
      updatedAt: EPOCH_RFC3339,
    }))),
  });
}
```

`readLegacyEvidence()` is used only for Page-ID/path reconciliation against the authoritative remote v2 Snapshot. It never writes or activates the v2 pointer; only the validated remote v2 tree can become the active v2 baseline after the confirmed pull transaction commits. This also handles old v1 paths that were valid portable Markdown paths but were not yet under `pages/`.

- [ ] **Step 5: Run focused tests and commit**

Run: `npx vitest run tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts`

```bash
git add src/storage/tree-generation.ts src/storage/tree-baseline.ts src/storage/baseline.ts tests/unit/tree-generation.test.ts tests/integration/tree-baseline-upgrade.test.ts
git commit -m "feat: persist versioned tree baselines"
```

### Task 6: Implement v1 and v2 HTTP adapters behind one tree remote port

**Files:**

- Create: `src/ports/tree-remote.ts`
- Create: `src/agentwiki/v1-tree-remote.ts`
- Create: `src/agentwiki/v2-tree-remote.ts`
- Modify: `src/agentwiki/client.ts`
- Modify: `tests/fakes/fake-agentwiki.ts`
- Test: `tests/integration/tree-remote.test.ts`

**Interfaces:**

- Produces: `TreeRemotePort`, `V1TreeRemote`, `V2TreeRemote`, `AgentWikiClient.treeSpaces()`

```ts
export interface TreeRemotePort {
  readonly protocolVersion: "1" | "2";
  readonly capabilitiesHash: string;
  capabilities(): Promise<TreeSyncLimits>;
  spaces(): Promise<TreeSpaceSummary[]>;
  head(): Promise<TreeHead>;
  snapshotPages(revision?: string): AsyncIterable<TreeSnapshotSegment>;
  delta(fromRevision: string): Promise<TreeDelta>;
  createPushSession(input: TreeCreatePushSession): Promise<TreePushSession>;
  uploadBatch(
    sessionId: string,
    batch: TreePushBatch,
  ): Promise<{ receipt: string }>;
  finalize(
    sessionId: string,
    confirmationHash: string,
  ): Promise<TreeFinalizeResult>;
  getSession(sessionId: string): Promise<TreePushSessionStatus>;
  abort(sessionId: string): Promise<void>;
}
```

- [ ] **Step 1: Write adapter tests for zero-folder v1 conversion and paginated v2 metadata pinning**

```ts
it("converts v1 pages into a zero-folder tree", async () => {
  const snapshot = await collectSnapshot(new V1TreeRemote(client, "space"));
  expect(snapshot.folders).toEqual([]);
  expect(snapshot.pages[0]).toMatchObject({
    folderId: null,
    path: "pages/A.md",
  });
});

it("rejects changed v2 pagination metadata", async () => {
  http.queue(v2SnapshotPage({ revision: "r1", nextCursor: "next" }));
  http.queue(v2SnapshotPage({ revision: "r2", nextCursor: null }));
  await expect(
    collectSnapshot(new V2TreeRemote(client, "space", selection)),
  ).rejects.toThrow(/分页元数据/);
});
```

- [ ] **Step 2: Run the adapter test and verify the unified port is missing**

Run: `npx vitest run tests/integration/tree-remote.test.ts`

- [ ] **Step 3: Implement `V2TreeRemote` with strict published schemas**

```ts
const page = TreeSnapshotPageV2Schema.parse(
  (
    await client.raw(
      "GET",
      `/api/sync/v2/spaces/${encodeURIComponent(spaceId)}/snapshot?${query}`,
    )
  ).json,
);
```

Use the v2 schemas for capabilities, head, snapshot, delta, session creation, batch receipt, status, finalize, and canonical bodies. Track seen cursors and fail on replay. Parse decimal limits before retaining arrays or bodies.

The published package does not export the v2 Space-list response schema, so define one strict local schema beside `V2TreeRemote` and parse `/api/sync/v2/spaces` before returning `TreeSpaceSummary[]`:

```ts
const TreeSpaceListResponseV2Schema = z
  .object({
    protocolVersion: z.literal("2"),
    spaces: z.array(
      z
        .object({
          spaceId: z.string().min(1),
          displayName: z.string(),
          role: z.enum(["viewer", "editor", "admin", "owner"]),
          canRead: z.literal(true),
          canPublish: z.boolean(),
          currentRevision: z.string().min(1),
          folderCount: DecimalCountSchema,
          pageCount: DecimalCountSchema,
          revisionManifestByteLength: DecimalByteCountSchema,
          revisionBodyBytes: DecimalByteCountSchema,
        })
        .strict(),
    ),
  })
  .strict();
```

- [ ] **Step 4: Implement `V1TreeRemote` as the compatibility adapter**

Convert v1 operations as follows:

```ts
const toTreePage = (page: SyncPage): TreePage => ({ ...page, folderId: null });
const toTreeDelta = (item: DeltaItem): TreeDeltaItem =>
  item.operation === "upsert"
    ? { operation: "upsert_page", page: toTreePage(item.page) }
    : {
        operation: "archive_page",
        pageId: item.pageId,
        previousPath: item.previousPath,
      };
```

Reject any folder change before calling v1. Translate page changes back to existing v1 requests and preserve existing v1 hashes.

- [ ] **Step 5: Add a v2-capable fake server and commit**

`FakeAgentWiki` stores folders and pages, defaults to protocol `"2"`, exposes `setProtocol("1" | "2")`, records batches, and computes v2 hashes with the public package.

Run: `npx vitest run tests/integration/tree-remote.test.ts tests/integration/protocol-conformance.test.ts`

```bash
git add src/ports/tree-remote.ts src/agentwiki/v1-tree-remote.ts src/agentwiki/v2-tree-remote.ts src/agentwiki/client.ts tests/fakes/fake-agentwiki.ts tests/integration/tree-remote.test.ts
git commit -m "feat: add sync v1 and v2 tree adapters"
```

### Task 7: Build three-way tree diff and Folder conflict resolution

**Files:**

- Create: `src/application/tree-diff.ts`
- Create: `src/application/tree-preview.ts`
- Modify: `src/core/merge.ts`
- Test: `tests/unit/tree-diff.test.ts`

**Interfaces:**

- Produces: `TreePullPreview`, `TreePullAction`, `FolderConflict`, `resolveFolderConflict()`, and `pendingTreeDecisionCount()`

```ts
export type TreePullAction =
  | { kind: "create_directory"; folderId: string; path: string }
  | { kind: "move_directory"; folderId: string; fromPath: string; path: string }
  | { kind: "trash_directory"; folderId: string; path: string }
  | {
      kind: "create_page" | "write_page";
      pageId: string;
      path: string;
      bodyPath: string;
    }
  | {
      kind: "move_page";
      pageId: string;
      fromPath: string;
      path: string;
      bodyPath: string;
    }
  | { kind: "trash_page"; pageId: string; path: string };

export interface FolderConflict {
  conflictId: string;
  objectType: "folder";
  folderId: string;
  baseParentPath: string | null;
  localParentPath: string | null;
  remoteParentPath: string | null;
  basePath: string;
  localPath: string;
  remotePath: string;
}
```

- [ ] **Step 1: Write failing tests for moves, empty folders, cycles, and dependency order**

```ts
it("keeps one folder identity when local and remote agree on a move", async () => {
  const preview = await buildTreePullPreview(base, localMoved, remoteMoved);
  expect(preview.actions).toContainEqual(
    expect.objectContaining({
      kind: "move_directory",
      folderId: "f1",
      fromPath: "pages/A",
      path: "pages/B",
    }),
  );
});

it("blocks different local and remote parents for the same folder", async () => {
  const preview = await buildTreePullPreview(base, localToA, remoteToB);
  expect(preview.folderConflicts).toHaveLength(1);
  expect(pendingTreeDecisionCount(preview)).toBe(1);
});
```

- [ ] **Step 2: Run the tests and verify the planner is missing**

Run: `npx vitest run tests/unit/tree-diff.test.ts`

- [ ] **Step 3: Implement ID-first three-way comparison**

```ts
export async function buildTreePullPreview(
  base: TreeSnapshot,
  local: LocalTreeScan,
  remote: TreeSnapshot,
): Promise<TreePullPreview> {
  const folderPlan = mergeFoldersById(
    base.folders,
    local.folders,
    remote.folders,
  );
  const pagePlan = await mergePagesById(base.pages, local.pages, remote.pages);
  const candidate = validateResolvedTree(folderPlan, pagePlan);
  return orderPreviewActions(candidate);
}
```

All selected manual paths pass portable directory validation, existing-parent validation, cycle detection, and file/directory collision detection immediately.

- [ ] **Step 4: Verify action ordering and commit**

Run: `npx vitest run tests/unit/tree-diff.test.ts`

```bash
git add src/application/tree-diff.ts src/application/tree-preview.ts src/core/merge.ts tests/unit/tree-diff.test.ts
git commit -m "feat: plan folder-aware sync previews"
```

### Task 8: Replace file-only Pull apply with a recoverable tree transaction

**Files:**

- Create: `src/application/tree-transaction.ts`
- Modify: `src/application/pull-transaction.ts`
- Test: `tests/integration/tree-transaction.test.ts`

**Interfaces:**

- Produces: `TreeTransaction.prepare()`, `apply()`, `recover()`, and `inspect()`

```ts
export interface TreeTransactionJournal {
  schemaVersion: 2;
  transactionId: string;
  baseRevision: string;
  targetRevision: string;
  targetTreeHash: string;
  state:
    | "prepared"
    | "applying"
    | "committed"
    | "rolling_back"
    | "rolled_back"
    | "ambiguous";
  nextOperation: number;
  operations: Array<{
    action: TreePullAction;
    paths: Array<{
      path: string;
      before: { kind: "directory" | "file" | "missing"; hash: string | null };
      after: { kind: "directory" | "file" | "missing"; hash: string | null };
    }>;
  }>;
}
```

- [ ] **Step 1: Write one fault-injection test for every operation boundary**

```ts
it.each([0, 1, 2, 3, 4, 5])(
  "recovers a folder/page plan after fault %s",
  async (fault) => {
    vault.failAfterOperations = fault;
    await expect(tx.apply()).rejects.toThrow();
    vault.failAfterOperations = null;
    await tx.recover();
    expect(await tx.inspect()).toMatchObject({
      state: expect.stringMatching(/committed|rolled_back/),
    });
    expect(vault.hasUnexpectedTemporaryPaths()).toBe(false);
  },
);
```

Also test that a user edit made after interruption changes neither to the recorded before nor after hash, causing `ambiguous` without overwrite.

- [ ] **Step 2: Run the transaction test and verify it fails**

Run: `npx vitest run tests/integration/tree-transaction.test.ts`

- [ ] **Step 3: Implement checkpointed before/after classification**

```ts
const state = await classifyOperation(vault, operation);
if (state === "before") await executeOperation(vault, operation.action);
else if (state !== "after") {
  journal.state = "ambiguous";
  await save(journal);
  throw new Error("TREE_TRANSACTION_AMBIGUOUS");
}
journal.nextOperation = index + 1;
await save(journal);
```

Directory archives and page archives use FileManager trash. Before images for page bytes remain in private control sidecars. Rollback verifies the current after hash before restoring a before image and never deletes or overwrites an unrecorded user object.

- [ ] **Step 4: Keep the v1 `PullTransaction` only as migration/recovery support**

Existing unfinished schema-1 Pull journals continue through `PullTransaction.recover()`. New previews always create `TreeTransactionJournal.schemaVersion = 2`.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/integration/tree-transaction.test.ts tests/integration/pull-transaction.test.ts`

```bash
git add src/application/tree-transaction.ts src/application/pull-transaction.ts tests/integration/tree-transaction.test.ts
git commit -m "feat: apply recoverable tree transactions"
```

### Task 9: Publish tree changes with capability-bound v2 recovery

**Files:**

- Create: `src/application/tree-push-service.ts`
- Modify: `src/application/push-service.ts`
- Test: `tests/integration/tree-push-service.test.ts`

**Interfaces:**

- Produces: `PreparedTreePushChange`, `TreePushPreview`, `TreePushService.publishPrepared()`, `resume()`, `supersede()`, and `markVerified()`

- [ ] **Step 1: Write failing tests for mixed folder/page Push and capability changes**

```ts
it("publishes parent folders before their pages", async () => {
  const result = await service.publishPrepared(
    prepared([
      upsertPage("p1", "f1", "pages/A/P.md"),
      upsertFolder("f1", null, "pages/A"),
    ]),
  );
  expect(remote.receivedOperations()).toEqual(["upsert_folder", "upsert_page"]);
  expect(result.protocolVersion).toBe("2");
});

it("rebuilds once after CAPABILITIES_CHANGED and fails on a second change", async () => {
  remote.changeCapabilitiesOnCreate = 2;
  await expect(service.publishPrepared(input)).rejects.toThrow(
    /CAPABILITIES_CHANGED/,
  );
  expect(remote.createCount).toBe(2);
});
```

- [ ] **Step 2: Run the test and verify the tree push service is absent**

Run: `npx vitest run tests/integration/tree-push-service.test.ts`

- [ ] **Step 3: Implement schema-2 journals and public v2 hashing/partitioning**

```ts
const manifest: TreePushConfirmationManifestV2 = {
  protocolVersion: "2",
  spaceId: input.spaceId,
  baseRevision: input.baseRevision,
  changes: manifestChanges(input.changes),
};
const confirmationHash = await treeConfirmationHashV2(manifest);
const batches = await partitionTreePushChangesV2(
  await hydrate(input.changes),
  input.capabilities,
);
```

Persist protocol version, capabilities hash, exact manifest changes, body sidecar paths, session ID, received batches, result, credential ID, and local-commit phase. A capability change discards the old preview/session artifacts and fully rebuilds once; a second change is terminal.

- [ ] **Step 4: Preserve v1 journal recovery**

`PushService` continues to resume schema-1 journals created by plugin `0.2.12`. `TreePushService` owns all new schema-2 journals and delegates page-only legacy publication through `TreeRemotePort`.

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run tests/integration/tree-push-service.test.ts tests/integration/push-service.test.ts`

```bash
git add src/application/tree-push-service.ts src/application/push-service.ts tests/integration/tree-push-service.test.ts
git commit -m "feat: publish capability-bound tree changes"
```

### Task 10: Move `SyncRuntime` onto the common tree pipeline

**Files:**

- Modify: `src/application/sync-runtime.ts`
- Modify: `src/main.ts`
- Modify: `src/agentwiki/push-remote.ts`
- Test: `tests/integration/sync-runtime.test.ts`

**Interfaces:**

- Consumes: `TreeRemotePort`, `TreeBaselineRepository`, `scanLocalTree()`, `buildTreePullPreview()`, `TreeTransaction`, and `TreePushService`
- Produces: existing public runtime methods plus `protocolVersion` and Folder-aware diff fields

```ts
interface RuntimeStatus {
  protocolVersion: "1" | "2";
  baseRevision: string;
  remoteRevision: string;
  local: TreeLocalStatus;
}
```

- [ ] **Step 1: Convert integration fixtures to assert folders without removing v1 cases**

```ts
it("pulls, moves, pushes, and re-pulls an empty folder tree", async () => {
  await remote.seedTree({
    folders: [folder("f1", null, "pages/A")],
    pages: [],
  });
  await runtime.applyPull(await runtime.previewPull());
  expect(vault.hasDirectory("Wiki/pages/A")).toBe(true);
  await vault.rename("Wiki/pages/A", "Wiki/pages/B");
  await runtime.applyPush(await runtime.previewPush());
  expect((await remote.tree()).folders[0]?.path).toBe("pages/B");
});
```

- [ ] **Step 2: Run the runtime test and verify current file-only behavior fails**

Run: `npx vitest run tests/integration/sync-runtime.test.ts`

- [ ] **Step 3: Refactor runtime construction to negotiate before choosing an adapter**

```ts
const selection = await negotiator.select({
  serverOrigin: this.settings.serverUrl,
  serverInstanceId: state.serverInstanceId,
  pluginVersion: this.manifest.version,
});
const remote: TreeRemotePort =
  selection.version === "2"
    ? new V2TreeRemote(client, mapping.spaceId, selection)
    : new V1TreeRemote(client, mapping.spaceId, session.capabilities);
```

The runtime cache key includes selected protocol and v2 capability hash. `listAccessibleSpaces()` uses the same selected adapter, so mapping setup and sync cannot disagree about protocol.

- [ ] **Step 4: Replace page-only scan/diff/apply/publish calls with tree services**

Keep method names `recover`, `status`, `remoteDelta`, `previewPull`, `applyPull`, `previewPush`, `applyPush`, `discardPullPreview`, `discardPushPreview`, and `hasUnfinishedPush` so command/UI callers stay stable. Remove protocol branches from business logic; branches remain only inside `V1TreeRemote`/`V2TreeRemote` and legacy journal recovery.

- [ ] **Step 5: Verify v1 baseline import activates only after confirmation**

```ts
const before = await treeBaseline.readOptional();
expect(before).toBeNull();
const preview = await runtime.previewPull();
expect(await treeBaseline.readOptional()).toBeNull();
await runtime.applyPull(preview);
expect((await treeBaseline.read()).protocolVersion).toBe("2");
expect(await legacyBaseline.read()).toBeDefined();
```

- [ ] **Step 6: Run focused tests and commit**

Run: `npx vitest run tests/integration/sync-runtime.test.ts tests/integration/plugin-settings-lifecycle.test.ts`

```bash
git add src/application/sync-runtime.ts src/main.ts src/agentwiki/push-remote.ts tests/integration/sync-runtime.test.ts
git commit -m "feat: run sync through the unified tree pipeline"
```

### Task 11: Present Folder changes and conflicts without a protocol selector

**Files:**

- Modify: `src/obsidian/sync-center-modal.ts`
- Modify: `src/obsidian/preview-modal.ts`
- Modify: `src/obsidian/preview-logic.ts`
- Modify: `src/core/user-errors.ts`
- Modify: `src/main.ts`
- Modify: `styles.css`
- Test: `tests/unit/preview-logic.test.ts`
- Test: `tests/unit/preview-modal-layout.test.ts`
- Test: `tests/integration/plugin-settings-lifecycle.test.ts`

**Interfaces:**

- Extends `SyncDiff` with protocol label, local/remote Folder changes, and Folder/Page counts
- Extends preview resolution logic with `FolderConflictResolution`

```ts
export interface SyncDiff {
  protocolLabel: "Sync v2" | "Legacy v1";
  localFoldersAdded: string[];
  localFoldersMoved: string[];
  localFoldersDeleted: string[];
  remoteFoldersUpdated: string[];
  remoteFoldersArchived: string[];
  folderCount: number;
  pageCount: number;
  // existing Page fields remain
}
```

- [ ] **Step 1: Write failing UI logic tests for Folder decisions and no selector**

```ts
it("counts unresolved Folder and Page conflicts together", () => {
  expect(
    pendingTreeDecisionCount(previewWithOneFolderAndOnePageConflict()),
  ).toBe(2);
});

it("does not render a protocol dropdown", async () => {
  const modal = openSyncCenter({ protocolLabel: "Sync v2" });
  expect(modal.text()).toContain("Sync v2");
  expect(modal.dropdownLabels()).not.toContain("协议");
});
```

- [ ] **Step 2: Run UI tests and verify Folder information is absent**

Run: `npx vitest run tests/unit/preview-logic.test.ts tests/unit/preview-modal-layout.test.ts tests/integration/plugin-settings-lifecycle.test.ts`

- [ ] **Step 3: Render Folder conflicts in the existing paginated preview**

```ts
setting
  .setName(`目录：${conflict.folderId}`)
  .setDesc(
    `原位置：${conflict.basePath} · 本地：${conflict.localPath} · 服务器：${conflict.remotePath}`,
  )
  .addDropdown((dropdown) =>
    dropdown
      .addOption("", "请选择…")
      .addOption("local", "保留本地位置")
      .addOption("remote", "使用服务器位置")
      .addOption("manual", "手动输入最终路径"),
  );
```

The manual input validates immediately and shows the exact validation error. The sticky confirmation remains disabled while any Folder/Page decision is unresolved or invalid.

- [ ] **Step 4: Add clear protocol/folder summaries and v2 error messages**

Add messages for `SYNC_PROTOCOL_UPGRADE_REQUIRED`, `TREE_TRANSACTION_AMBIGUOUS`, `FOLDER_ID_CONFLICT`, `FOLDER_CYCLE`, and v2 payload/hash failures. `Sync v2`/`Legacy v1` is read-only diagnostic text, never a control.

- [ ] **Step 5: Verify narrow-width layout and commit**

Run: `npx vitest run tests/unit/preview-logic.test.ts tests/unit/preview-modal-layout.test.ts tests/integration/plugin-settings-lifecycle.test.ts`

Expected: controls stay inside 420px and 620px modal fixtures; long Windows paths wrap without horizontal overflow.

```bash
git add src/obsidian/sync-center-modal.ts src/obsidian/preview-modal.ts src/obsidian/preview-logic.ts src/core/user-errors.ts src/main.ts styles.css tests/unit/preview-logic.test.ts tests/unit/preview-modal-layout.test.ts tests/integration/plugin-settings-lifecycle.test.ts
git commit -m "feat: show folder-aware sync previews"
```

### Task 12: Verify complete v2 behavior, bounded resources, and real isolated round trip

**Files:**

- Modify: `tests/e2e/manual-sync-flow.test.ts`
- Modify: `tests/performance/bounded-space.test.ts`
- Create: `docs/verification/agentwiki-sync-v2.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: executable regression evidence for v2 Pull/Push, legacy v1, crash recovery, Windows layout, and release-safety checks

- [ ] **Step 1: Add the complete two-device v2 E2E scenario**

```ts
it("syncs a mixed folder/page tree across desktop and mobile", async () => {
  await desktop.createDirectory("Wiki/pages/Empty");
  await desktop.createDirectory("Wiki/pages/Guides");
  await desktop.writeText("Wiki/pages/Guides/A.md", "desktop");
  await desktopRuntime.applyPush(await desktopRuntime.previewPush());
  await mobileRuntime.applyPull(await mobileRuntime.previewPull());
  await mobile.rename("Wiki/pages/Guides", "Wiki/pages/Manuals");
  await mobile.writeText("Wiki/pages/Manuals/A.md", "mobile");
  await mobileRuntime.applyPush(await mobileRuntime.previewPush());
  await desktopRuntime.applyPull(await desktopRuntime.previewPull());
  expect(desktop.tree()).toEqual(mobile.tree());
  expect(desktop.hasDirectory("Wiki/pages/Empty")).toBe(true);
});
```

- [ ] **Step 2: Add bounded-limit failures before unbounded retention**

Test `maxClientSpaceFolders = 10_000`, `maxSnapshotObjects = 15_000`, `maxDeltaItems = 15_000`, `maxResponseBytes = 4 MiB`, `maxDocumentTreeBytes = 2 MiB`, and `maxPushChanges = 100`. Assert the scanner/downloader fails before retaining object `limit + 1` or allocating a body beyond the advertised bound.

- [ ] **Step 3: Run fresh automated verification**

Run: `npm run check`

Expected: formatting, lint, typecheck, all unit/integration/E2E/performance tests, production build, bundle safety, and release metadata checks pass with zero failures.

- [ ] **Step 4: Run a real isolated Obsidian/v2 round trip**

Use a separate test Vault and non-production AgentWiki Space:

1. Connect and verify the sync center displays `Sync v2` without a selector.
2. Pull a tree containing nested folders, an empty folder, and Pages; inspect the preview before confirming.
3. Confirm Pull, then rename/move a folder, edit a Page, and create an empty folder locally.
4. Preview and confirm Push.
5. Pull from a second isolated Vault and verify Folder IDs, paths, empty folders, Page bodies, and clean status.
6. Interrupt one Pull after a checkpoint and verify restart reaches committed/rolled-back or stops ambiguous without overwriting a post-interruption edit.

- [ ] **Step 5: Probe production read-only and document evidence**

Against the configured production credential, perform connection, capabilities, status, and Pull preview only. Record protocol selection, server instance, Folder/Page counts, preview result, and the fact that no confirmation was executed in `docs/verification/agentwiki-sync-v2.md`. Do not include credentials, bodies, or sensitive paths.

- [ ] **Step 6: Update user-facing documentation and commit**

Document automatic v2 selection, legacy v1 behavior, Folder mapping, empty-folder support, confirmation/recovery behavior, and the absence of a protocol selector.

```bash
git add tests/e2e/manual-sync-flow.test.ts tests/performance/bounded-space.test.ts docs/verification/agentwiki-sync-v2.md README.md CHANGELOG.md
git commit -m "test: verify Obsidian sync v2 end to end"
```

- [ ] **Step 7: Perform final branch verification without publishing**

Run:

```bash
git status --short
git log --oneline --decorate -15
npm run check
```

Expected: only intentional files are tracked, `.codegraph/` remains unrelated/untracked, every check passes, and no GitHub/npm/production publication has occurred.
