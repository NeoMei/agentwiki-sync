import {
  canonicalBytes,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";
import { describe, expect, it } from "vitest";

import { contentHash, sha256Hex } from "../../src/agentwiki/protocol";
import {
  hashUpgradeAuthorization,
  hashUpgradeLocalPlan,
  mergeLegacyUpgrade,
  prepareLegacyUpgradePreview,
  prepareTreePushChangesV3,
  projectLegacyBase,
  type LegacyUpgradeBase,
  type UpgradeTree,
} from "../../src/application/local-image-upgrade-plan";
import { scanLocalTree } from "../../src/core/tree-scan";
import {
  resolveExplicitInitialTreeBindings,
  type ExplicitInitialTreeBinding,
} from "../../src/core/initial-binding";
import type {
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";
import type { UpgradeBinding } from "../../src/storage/local-image-upgrade";
import type { TreeIdentityStateV2 } from "../../src/storage/tree-identities";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

const SPACE_ID = "11111111-1111-4111-8111-111111111111";
const TIME = "2026-09-06T00:00:00.000Z";
const EMPTY_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const pngBytes = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00,
]);

const capabilities: TreeSyncCapabilitiesV3 = {
  maxPageBytes: 1_048_576,
  maxBatchBytes: 4_194_304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4_194_304,
  maxClientSpacePages: 5_000,
  maxClientSpaceFolders: 5_000,
  maxSnapshotObjects: 10_000,
  maxClientManifestBytes: 4_194_304,
  maxClientTotalBodyBytes: 2_097_152,
  maxDeltaItems: 15_000,
  maxResponseBytes: 4_194_304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
  maxAttachmentBytes: 10 * 1_048_576,
  maxRevisionAttachments: 1_000,
  maxTransferBlobBytes: 100 * 1_048_576,
  blobChunkBytes: 1_048_576,
  maxBlobChunks: 10,
  maxConcurrentBlobs: 2,
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: ["image/gif", "image/jpeg", "image/png", "image/webp"],
  blobStagingTtlSeconds: 900,
  downloadAuthorizationTtlSeconds: 300,
};

const binding: UpgradeBinding = {
  operationId: "upgrade-1",
  serverInstanceId: "server-1",
  spaceId: SPACE_ID,
  deviceId: "device-1",
  credentialId: "credential-1",
  mappingRootKey: "Wiki",
};

function identities(): TreeIdentityStateV2 {
  return {
    schemaVersion: 2,
    folders: {},
    pendingFolders: {},
    pendingPages: {},
    attachments: {},
    pendingAttachments: {},
  };
}

async function page(
  pageId: string,
  path: string,
  body: string,
  folderId: string | null = null,
): Promise<TreePage> {
  return {
    pageId,
    folderId,
    path,
    title: path.split("/").at(-1)!.replace(/\.md$/u, ""),
    body,
    contentHash: await contentHash(body),
    updatedAt: TIME,
  };
}

function folder(
  folderId: string,
  path: string,
  parentFolderId: string | null = null,
): TreeFolder {
  return {
    folderId,
    parentFolderId,
    path,
    name: path.split("/").at(-1)!,
    sortOrder: 0,
    updatedAt: TIME,
  };
}

async function legacy(
  revision: string,
  folders: TreeFolder[],
  pages: TreePage[],
): Promise<LegacyUpgradeBase> {
  const manifest = {
    protocolVersion: "2" as const,
    spaceId: SPACE_ID,
    folders,
    pages,
  };
  const snapshot: TreeSnapshot & { protocolVersion: "2" } = {
    ...manifest,
    revision,
    revisionContentHash: await treeRevisionContentHashV2(manifest),
  };
  return projectLegacyBase(snapshot);
}

async function emptyBase(): Promise<LegacyUpgradeBase> {
  return projectLegacyBase({
    protocolVersion: "2",
    spaceId: SPACE_ID,
    revision: "0",
    revisionContentHash: EMPTY_HASH,
    folders: [],
    pages: [],
  });
}

async function fixedInputs() {
  const docs = folder("folder-docs", "pages/docs");
  const obsolete = folder("folder-obsolete", "pages/obsolete");
  const child = folder(
    "folder-child",
    "pages/obsolete/child",
    "folder-obsolete",
  );
  const baseLocal = await page(
    "page-local",
    "pages/docs/local.md",
    "base local\n",
    docs.folderId,
  );
  const baseRemote = await page(
    "page-remote",
    "pages/docs/remote.md",
    "base remote\n",
    docs.folderId,
  );
  const baseStable = await page(
    "page-stable",
    "pages/docs/stable.md",
    "stable\n",
    docs.folderId,
  );
  const oldDescendant = await page(
    "page-obsolete",
    "pages/obsolete/child/old.md",
    "old\n",
    child.folderId,
  );
  const base = await legacy(
    "revision-b",
    [docs, obsolete, child],
    [baseLocal, baseRemote, baseStable, oldDescendant],
  );
  const remote = await legacy(
    "revision-r",
    [{ ...docs, name: "renamed", path: "pages/renamed" }],
    [
      { ...baseLocal, folderId: docs.folderId, path: "pages/renamed/local.md" },
      {
        ...(await page(
          "page-remote",
          "pages/renamed/remote.md",
          "remote changed\n",
          docs.folderId,
        )),
      },
      {
        ...baseStable,
        folderId: docs.folderId,
        path: "pages/renamed/stable.md",
      },
    ],
  );
  const vault = new MemoryVault({});
  vault.seedMarkdown(
    "Wiki/pages/docs/local.md",
    "local changed\n![](../../assets/used.png)\n",
  );
  vault.seedMarkdown("Wiki/pages/docs/remote.md", "base remote\n");
  vault.seedMarkdown("Wiki/pages/docs/stable.md", "stable\n");
  vault.seedMarkdown("Wiki/pages/obsolete/child/old.md", "old\n");
  vault.seedFile("Wiki/assets/used.png", pngBytes);
  vault.seedFile("Wiki/assets/unused.png", pngBytes);
  const identityState = identities();
  const local = await scanLocalTree(
    vault,
    "Wiki",
    base.projected,
    identityState,
    {
      ...capabilities,
      maxFolders: capabilities.maxClientSpaceFolders,
      maxPages: capabilities.maxClientSpacePages,
    },
  );
  return { base, remote, vault, local, identities: identityState };
}

describe("local-first image upgrade preview", () => {
  it("merges fixed B/L/R through existing resolvers and requires explicit first binding", async () => {
    const { base, remote, local } = await fixedInputs();
    const preview = await mergeLegacyUpgrade({ base, remote, local });

    expect(preview.pageConflicts).toEqual([]);
    expect(preview.folderConflicts).toEqual([]);
    expect(
      preview.resolvedPages.find((item) => item.pageId === "page-local"),
    ).toMatchObject({
      path: "pages/renamed/local.md",
      body: "local changed\n![](../../assets/used.png)\n",
    });
    expect(
      preview.resolvedPages.find((item) => item.pageId === "page-remote"),
    ).toMatchObject({ body: "remote changed\n" });
    expect(preview.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trash_directory",
          path: "pages/obsolete",
        }),
      ]),
    );
    expect(
      preview.actions.filter((action) => action.kind === "create_attachment"),
    ).toEqual([]);

    const firstRemote = await legacy(
      "first-r",
      [],
      [await page("remote-id", "pages/same.md", "remote\n")],
    );
    const firstLocal = {
      rootPath: "Wiki",
      folders: [],
      pages: [
        {
          ...(await page("local-id", "pages/same.md", "local\n")),
          referencedAttachmentIds: [],
        },
      ],
      attachments: [],
      blockers: [],
      rawPathStates: {},
    };
    await expect(
      mergeLegacyUpgrade({
        base: await emptyBase(),
        remote: firstRemote,
        local: firstLocal,
      }),
    ).rejects.toThrow("INITIAL_BINDING_DECISION_REQUIRED");
  });

  it("aligns explicit initial Page and Folder identities without injecting remote-only objects into L", async () => {
    const localFolder = folder("local-folder", "pages/docs");
    const localPage = {
      ...(await page(
        "local-page",
        "pages/docs/note.md",
        "local body\n",
        localFolder.folderId,
      )),
      referencedAttachmentIds: [] as string[],
    };
    const remoteFolder = folder("remote-folder", "pages/docs");
    const remoteOnlyFolder = folder("remote-only-folder", "pages/remote-only");
    const remotePage = {
      ...(await page(
        "remote-page",
        "pages/docs/note.md",
        "remote body\n",
        remoteFolder.folderId,
      )),
      referencedAttachmentIds: [] as string[],
    };
    const remoteOnlyPage = {
      ...(await page(
        "remote-only-page",
        "pages/remote-only/new.md",
        "remote only\n",
        remoteOnlyFolder.folderId,
      )),
      referencedAttachmentIds: [] as string[],
    };
    const local = {
      rootPath: "Wiki",
      folders: [localFolder],
      pages: [localPage],
      attachments: [],
      blockers: [],
      rawPathStates: {
        "pages/docs": { kind: "directory" as const, hash: null },
        "pages/docs/note.md": {
          kind: "file" as const,
          hash: "a".repeat(64),
        },
      },
    };
    const choices: ExplicitInitialTreeBinding[] = [
      {
        kind: "folder",
        localId: localFolder.folderId,
        remoteId: remoteFolder.folderId,
      },
      {
        kind: "page",
        localId: localPage.pageId,
        remoteId: remotePage.pageId,
      },
    ];

    const resolved = resolveExplicitInitialTreeBindings(
      local,
      {
        protocolVersion: "3",
        spaceId: SPACE_ID,
        folders: [remoteFolder, remoteOnlyFolder],
        pages: [remotePage, remoteOnlyPage],
        attachments: [],
      },
      {
        ...identities(),
        pendingFolders: {
          [localFolder.folderId]: {
            folderId: localFolder.folderId,
            path: localFolder.path,
            pathKey: localFolder.path,
          },
        },
        pendingPages: {
          [localPage.pageId]: {
            pageId: localPage.pageId,
            path: localPage.path,
            contentHash: localPage.contentHash,
          },
        },
      },
      choices,
    );

    expect(resolved.local.folders).toEqual([
      expect.objectContaining({
        folderId: remoteFolder.folderId,
        path: localFolder.path,
      }),
    ]);
    expect(resolved.local.pages).toEqual([
      expect.objectContaining({
        pageId: remotePage.pageId,
        folderId: remoteFolder.folderId,
        path: localPage.path,
        body: "local body\n",
        contentHash: await contentHash("local body\n"),
      }),
    ]);
    expect(resolved.local.pages.map((item) => item.pageId)).not.toContain(
      remoteOnlyPage.pageId,
    );
    expect(resolved.local.folders.map((item) => item.folderId)).not.toContain(
      remoteOnlyFolder.folderId,
    );
    expect(resolved.local.rawPathStates).toEqual(local.rawPathStates);
    expect(resolved.evidence).toMatchObject({
      choices,
      originalLocal: local,
    });
    expect(resolved.identities.pendingFolders).toHaveProperty(
      remoteFolder.folderId,
    );
    expect(resolved.identities.pendingPages).toHaveProperty(remotePage.pageId);
  });

  it("scans only referenced images and reuses an inactive ID only for the same path and hash", async () => {
    const hash = await sha256Hex(pngBytes);
    const base = await emptyBase();
    const exactVault = new MemoryVault({});
    exactVault.seedMarkdown("Wiki/pages/note.md", "![[assets/used.png]]");
    exactVault.seedFile("Wiki/assets/used.png", pngBytes);
    exactVault.seedFile("Wiki/assets/unused.png", pngBytes);
    const exactIdentities = identities();
    exactIdentities.attachments.old = {
      attachmentId: "old",
      path: "assets/used.png",
      pathKey: "assets/used.png",
      baseContentHash: hash,
      active: false,
    };
    const exact = await scanLocalTree(
      exactVault,
      "Wiki",
      base.projected,
      exactIdentities,
      { ...capabilities, maxFolders: 100, maxPages: 100 },
    );
    expect(exact.attachments[0]?.attachmentId).toBe("old");
    expect(exactVault.readPaths).not.toContain("Wiki/assets/unused.png");

    const changedIdentities = identities();
    changedIdentities.attachments.old = {
      ...exactIdentities.attachments.old,
      baseContentHash: "f".repeat(64),
      active: false,
    };
    const changedVault = new MemoryVault({});
    changedVault.seedMarkdown("Wiki/pages/note.md", "![[assets/used.png]]");
    changedVault.seedFile("Wiki/assets/used.png", pngBytes);
    const changed = await scanLocalTree(
      changedVault,
      "Wiki",
      base.projected,
      changedIdentities,
      { ...capabilities, maxFolders: 100, maxPages: 100 },
    );
    expect(changed.attachments[0]?.attachmentId).not.toBe("old");
    expect(changedIdentities.attachments.old?.active).toBe(false);
  });

  it("prepares exact remote-to-candidate changes and binds the whole local plan", async () => {
    const {
      base,
      remote,
      vault,
      local,
      identities: identityState,
    } = await fixedInputs();
    const control = new MemoryControlStore();
    const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
    const resolved = await mergeLegacyUpgrade({ base, remote, local });
    const originalActions = structuredClone(resolved.actions);
    const preview = await prepareLegacyUpgradePreview({
      binding,
      base,
      remote,
      local,
      identities: identityState,
      scanEpoch: 7,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities,
      capabilitiesHash,
      control,
      controlRoot: ".agentwiki/tree/space",
      merge: resolved,
    });

    expect(preview.merge).not.toBe(resolved);
    expect(resolved.actions).toEqual(originalActions);
    expect(preview.candidate.attachments).toHaveLength(1);
    expect(
      preview.push.changes
        .filter((change) => change.operation === "upsert_page")
        .map((change) => change.page.pageId),
    ).not.toContain("page-remote");
    expect(
      preview.push.changes.some(
        (change) => change.operation === "upsert_attachment",
      ),
    ).toBe(true);
    expect(
      preview.push.changes.some(
        (change) =>
          change.operation === "upsert_page" &&
          change.page.pageId === "page-local",
      ),
    ).toBe(true);
    expect(Object.keys(preview.expectedPathStates)).toEqual(
      expect.arrayContaining([
        "Wiki/pages/obsolete",
        "Wiki/pages/obsolete/child",
        "Wiki/pages/obsolete/child/old.md",
      ]),
    );
    expect(vault.operationLog).toEqual([]);
    expect(vault.readPaths).not.toContain("Wiki/assets/unused.png");
    expect([...control.files.keys()]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\.agentwiki\/tree\/space\/local-image-upgrade\/upgrade-1\/payload\//u,
        ),
      ]),
    );

    const changedPlanHash = await sha256Hex(
      canonicalBytes({
        actions: preview.localActions,
        rawPathStates: {
          ...local.rawPathStates,
          "pages/docs/local.md": { kind: "missing", hash: null },
        },
        expectedPathStates: preview.expectedPathStates,
        scanEpoch: 7,
        identities: identityState,
      }),
    );
    const authorizationInput = {
      binding,
      sourceRevision: remote.sourceRevision,
      sourceV2RevisionHash: remote.sourceV2RevisionHash,
      projectedV3BaseHash: remote.projectedV3BaseHash,
      oldBaselineEvidenceHash: preview.oldBaselineEvidenceHash,
      candidateHash: preview.candidateHash,
      localPlanHash: preview.localPlanHash,
      confirmationHash: preview.push.confirmationHash,
    };
    expect(
      await hashUpgradeAuthorization({
        ...authorizationInput,
        localPlanHash: changedPlanHash,
      }),
    ).not.toBe(await hashUpgradeAuthorization(authorizationInput));
    expect(
      await hashUpgradeAuthorization({
        ...authorizationInput,
        binding: { ...binding, credentialId: "credential-2" },
      }),
    ).not.toBe(preview.authorizationHash);
  });

  it("binds capabilities through confirmation and rejects stale fixed merges", async () => {
    const {
      base,
      remote,
      local,
      identities: identityState,
    } = await fixedInputs();
    const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
    const first = await prepareLegacyUpgradePreview({
      binding,
      base,
      remote,
      local,
      identities: identityState,
      scanEpoch: 1,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities,
      capabilitiesHash,
      control: new MemoryControlStore(),
      controlRoot: ".agentwiki/tree/space",
    });
    const tighter = { ...capabilities, maxBatchItems: 50 };
    const second = await prepareLegacyUpgradePreview({
      binding,
      base,
      remote,
      local,
      identities: identityState,
      scanEpoch: 1,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities: tighter,
      capabilitiesHash: await treeCapabilitiesHashV3(tighter),
      control: new MemoryControlStore(),
      controlRoot: ".agentwiki/tree/space",
    });
    expect(second.push.confirmationHash).not.toBe(first.push.confirmationHash);
    expect(second.authorizationHash).not.toBe(first.authorizationHash);

    const stale = structuredClone(first.merge);
    const tamperedBody = "tampered candidate\n";
    const tamperedHash = await contentHash(tamperedBody);
    const plannedPage = stale.pagePlan.resolved.find(
      (page) => page.pageId === "page-stable",
    )!;
    plannedPage.body = tamperedBody;
    plannedPage.contentHash = tamperedHash;
    const resolvedPage = stale.resolvedPages.find(
      (page) => page.pageId === "page-stable",
    )!;
    resolvedPage.body = tamperedBody;
    resolvedPage.contentHash = tamperedHash;
    stale.actions.push({
      kind: "write_page",
      pageId: "page-stable",
      path: "pages/renamed/stable.md",
      bodyPath: "tree-preview-body/page-stable.md",
      beforePath: "pages/docs/stable.md",
    });
    await expect(
      prepareLegacyUpgradePreview({
        binding,
        base,
        remote,
        local,
        identities: identityState,
        scanEpoch: 1,
        oldBaselineEvidenceHash: "a".repeat(64),
        capabilities,
        capabilitiesHash,
        control: new MemoryControlStore(),
        controlRoot: ".agentwiki/tree/space",
        merge: stale,
      }),
    ).rejects.toThrow("STALE_UPGRADE_MERGE");
  });

  it("freezes every calculation input before its first asynchronous yield", async () => {
    const {
      base,
      remote,
      local,
      identities: identityState,
    } = await fixedInputs();
    const selected = await mergeLegacyUpgrade({ base, remote, local });
    const originalRevision = remote.sourceRevision;
    const originalMaxBatchItems = capabilities.maxBatchItems;
    const pending = prepareLegacyUpgradePreview({
      binding,
      base,
      remote,
      local,
      identities: identityState,
      scanEpoch: 11,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities,
      capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
      control: new MemoryControlStore(),
      controlRoot: ".agentwiki/tree/space",
      merge: selected,
    });

    remote.sourceRevision = "mutated-revision";
    remote.projected.pages[0]!.body = "mutated remote\n";
    local.rawPathStates["pages/docs/local.md"] = {
      kind: "missing",
      hash: null,
    };
    identityState.pendingPages.mutated = {
      pageId: "mutated",
      path: "pages/mutated.md",
      contentHash: "f".repeat(64),
    };
    capabilities.maxBatchItems = originalMaxBatchItems - 1;
    selected.resolvedPages[0]!.body = "mutated selection\n";

    let preview: Awaited<ReturnType<typeof prepareLegacyUpgradePreview>>;
    try {
      preview = await pending;
    } finally {
      capabilities.maxBatchItems = originalMaxBatchItems;
    }
    expect(preview.push.baseRevision).toBe(originalRevision);
    expect(preview.push.capabilities.maxBatchItems).toBe(originalMaxBatchItems);
    expect(preview.candidate.pages[0]!.body).not.toContain("mutated");
    expect(preview.localPlanEvidence.rawPathStates).not.toEqual(
      local.rawPathStates,
    );
    expect(preview.localPlanEvidence.identities.pendingPages).toEqual({});
  });

  it("uses collision-free page payload names and exact operation roots", async () => {
    const control = new MemoryControlStore();
    const empty: UpgradeTree = {
      protocolVersion: "3",
      spaceId: SPACE_ID,
      folders: [],
      pages: [],
      attachments: [],
    };
    const dottedBody = "dotted\n";
    const underscoredBody = "underscored\n";
    const prepared = await prepareTreePushChangesV3({
      base: empty,
      candidate: {
        ...empty,
        pages: [
          {
            ...(await page("a.b", "pages/dotted.md", dottedBody)),
            referencedAttachmentIds: [],
          },
          {
            ...(await page("a_b", "pages/underscored.md", underscoredBody)),
            referencedAttachmentIds: [],
          },
        ],
      },
      vaultRoot: "Wiki",
      control,
      payloadRoot: ".agentwiki/tree/space/payload",
    });
    const payloadPaths = prepared.changes
      .filter((change) => change.operation === "upsert_page")
      .map((change) => change.page.payloadPath);
    expect(new Set(payloadPaths).size).toBe(2);
    expect(
      new Set(
        await Promise.all(payloadPaths.map((path) => control.read(path))),
      ),
    ).toEqual(new Set([dottedBody, underscoredBody]));

    const inputs = await fixedInputs();
    const capabilitiesHash = await treeCapabilitiesHashV3(capabilities);
    const dotted = await prepareLegacyUpgradePreview({
      binding: { ...binding, operationId: "a.b" },
      ...inputs,
      scanEpoch: 1,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities,
      capabilitiesHash,
      control,
      controlRoot: ".agentwiki/tree/space",
    });
    const dottedPayload = dotted.push.changes.find(
      (change) => change.operation === "upsert_page",
    )!.page.payloadPath;
    expect(dottedPayload).toContain("/local-image-upgrade/a.b/payload/");

    const abort = new AbortController();
    control.onTextWrite = (path) => {
      if (path.includes("/local-image-upgrade/a_b/payload/")) abort.abort();
    };
    await expect(
      prepareLegacyUpgradePreview({
        binding: { ...binding, operationId: "a_b" },
        ...inputs,
        scanEpoch: 1,
        oldBaselineEvidenceHash: "a".repeat(64),
        capabilities,
        capabilitiesHash,
        control,
        controlRoot: ".agentwiki/tree/space",
        options: { signal: abort.signal },
      }),
    ).rejects.toThrow("同步已取消");
    expect(await control.read(dottedPayload)).not.toBeNull();
  });

  it("returns immutable evidence that independently recomputes the local plan hash", async () => {
    const inputs = await fixedInputs();
    const preview = await prepareLegacyUpgradePreview({
      binding,
      ...inputs,
      scanEpoch: 17,
      oldBaselineEvidenceHash: "a".repeat(64),
      capabilities,
      capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
      control: new MemoryControlStore(),
      controlRoot: ".agentwiki/tree/space",
    });

    expect(preview.localPlanEvidence).toMatchObject({
      actions: preview.localActions,
      expectedPathStates: preview.expectedPathStates,
      scanEpoch: 17,
      identities: inputs.identities,
    });
    expect(preview.localPlanEvidence.rawPathStates).toEqual(
      inputs.local.rawPathStates,
    );
    expect(await hashUpgradeLocalPlan(preview.localPlanEvidence)).toBe(
      preview.localPlanHash,
    );
    expect(Object.isFrozen(preview.localPlanEvidence)).toBe(true);
    expect(Object.isFrozen(preview.localPlanEvidence.identities)).toBe(true);
    expect(Object.isFrozen(preview.localPlanEvidence.actions)).toBe(true);
  });

  it("removes only its scoped payloads when cancellation follows staging", async () => {
    const {
      base,
      remote,
      local,
      identities: identityState,
    } = await fixedInputs();
    const control = new MemoryControlStore();
    await control.write(
      ".agentwiki/tree/space/local-image-upgrade/other/payload/keep.md",
      "keep",
    );
    const abort = new AbortController();
    control.onTextWrite = (path) => {
      if (path.includes("/upgrade-1/payload/")) abort.abort();
    };
    await expect(
      prepareLegacyUpgradePreview({
        binding,
        base,
        remote,
        local,
        identities: identityState,
        scanEpoch: 1,
        oldBaselineEvidenceHash: "a".repeat(64),
        capabilities,
        capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
        control,
        controlRoot: ".agentwiki/tree/space",
        options: { signal: abort.signal },
      }),
    ).rejects.toThrow("同步已取消");
    expect(
      [...control.files.keys()].filter((path) =>
        path.includes("/upgrade-1/payload/"),
      ),
    ).toEqual([]);
    expect(
      await control.read(
        ".agentwiki/tree/space/local-image-upgrade/other/payload/keep.md",
      ),
    ).toBe("keep");
  });
});
