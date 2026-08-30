import { describe, expect, it, vi } from "vitest";
import {
  TREE_SYNC_V2_LIMITS,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";
import type { SyncFolderV2, SyncPageV2 } from "@neomei/agentwiki-sync-protocol";
import { AgentWikiClient } from "../../src/agentwiki/client";
import { capabilitiesHash } from "../../src/agentwiki/protocol";
import { V1TreeRemote } from "../../src/agentwiki/v1-tree-remote";
import { V2TreeRemote } from "../../src/agentwiki/v2-tree-remote";
import type {
  TreeFolder,
  TreePage,
  TreeSnapshot,
} from "../../src/core/tree-model";
import type { TreeRemotePort } from "../../src/ports/tree-remote";
import { FakeAgentWiki } from "../fakes/fake-agentwiki";
import { FakeHttp } from "../fakes/fake-http";

const UID = "11111111-1111-4111-8111-111111111111";

const v1Capabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 5000,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 104857600,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

const v2Capabilities = {
  maxPageBytes: 1048576,
  maxBatchBytes: 4194304,
  maxBatchItems: 100,
  maxChangeCount: 100,
  maxConfirmationBytes: 4194304,
  maxClientSpacePages: 5000,
  maxClientSpaceFolders: 10000,
  maxSnapshotObjects: 15000,
  maxClientManifestBytes: 4194304,
  maxClientTotalBodyBytes: 2097152,
  maxDeltaItems: 15000,
  maxResponseBytes: 4194304,
  maxPageItems: 200,
  pushSessionTtlSeconds: 900,
};

function v2Selection() {
  return {
    version: "2" as const,
    capabilities: v2Capabilities,
    capabilitiesHash: "c".repeat(64),
  };
}

function client(http: FakeHttp): AgentWikiClient {
  return new AgentWikiClient("https://wiki.example.com", http, () => "secret");
}

function pageV2(
  pageId: string,
  folderId: string | null,
  path: string,
): SyncPageV2 {
  return {
    pageId,
    folderId,
    path,
    title: pageId,
    body: "body",
    contentHash: "d".repeat(64),
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function folderV2(
  folderId: string,
  parentFolderId: string | null,
  path: string,
): SyncFolderV2 {
  return {
    folderId,
    parentFolderId,
    name: path.split("/").at(-1) ?? "Folder",
    path,
    sortOrder: 0,
    updatedAt: "2026-08-29T00:00:00.000Z",
  };
}

function v2SnapshotPage(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: "2",
    spaceId: "space",
    revision: "r1",
    sequence: 1,
    revisionContentHash: "e".repeat(64),
    folderCount: "0",
    pageCount: "1",
    revisionManifestByteLength: "10",
    revisionBodyBytes: "4",
    folders: [],
    pages: [pageV2("p1", null, "pages/A.md")],
    nextCursor: null,
    ...overrides,
  };
}

async function collectSnapshot(remote: TreeRemotePort): Promise<TreeSnapshot> {
  let head: {
    protocolVersion: "1" | "2";
    spaceId: string;
    revision: string;
    revisionContentHash: string;
  } | null = null;
  const folders: TreeFolder[] = [];
  const pages: TreePage[] = [];
  for await (const segment of remote.snapshotPages()) {
    head ??= {
      protocolVersion: segment.protocolVersion,
      spaceId: segment.spaceId,
      revision: segment.revision,
      revisionContentHash: segment.revisionContentHash,
    };
    folders.push(...segment.folders);
    pages.push(...segment.pages);
  }
  if (!head) throw new Error("快照未返回元数据");
  return { ...head, folders, pages };
}

describe("V1TreeRemote", () => {
  it("converts v1 pages into a zero-folder tree", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "1",
        spaceId: "space",
        revision: "r1",
        sequence: 1,
        revisionContentHash: "a".repeat(64),
        pageCount: "1",
        revisionManifestByteLength: "10",
        revisionBodyBytes: "4",
        items: [
          {
            pageId: "p1",
            path: "pages/A.md",
            title: "A",
            body: "body",
            contentHash: "b".repeat(64),
            updatedAt: "2026-08-29T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      },
    });
    const snapshot = await collectSnapshot(
      new V1TreeRemote(client(http), "space", v1Capabilities),
    );
    expect(snapshot.folders).toEqual([]);
    expect(snapshot.pages[0]).toMatchObject({
      folderId: null,
      path: "pages/A.md",
    });
  });

  it("reports zero folders for v1 space summaries", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "1",
        spaces: [
          {
            spaceId: "space",
            displayName: "Space",
            role: "owner",
            canRead: true,
            canPublish: true,
            currentRevision: "r1",
            pageCount: "1",
            revisionManifestByteLength: "10",
            revisionBodyBytes: "4",
          },
        ],
      },
    });
    const spaces = await new V1TreeRemote(
      client(http),
      "space",
      v1Capabilities,
    ).spaces();
    expect(spaces[0]).toMatchObject({ spaceId: "space", folderCount: "0" });
  });

  it("rejects folder changes before contacting the v1 server", async () => {
    const http = new FakeHttp();
    const remote = new V1TreeRemote(client(http), "space", v1Capabilities);
    await expect(
      remote.uploadBatch(UID, {
        protocolVersion: "1",
        batchIndex: 0,
        batchHash: "f".repeat(64),
        changes: [
          {
            operation: "upsert_folder",
            folder: folderV2("f1", null, "pages/Guide"),
          },
        ],
      }),
    ).rejects.toThrow(/目录|文件夹|folder/i);
    expect(http.calls).toHaveLength(0);
  });

  it("rejects a replayed v1 pagination cursor", async () => {
    const http = new FakeHttp();
    const page = {
      protocolVersion: "1",
      spaceId: "space",
      revision: "r1",
      sequence: 1,
      revisionContentHash: "a".repeat(64),
      pageCount: "1",
      revisionManifestByteLength: "10",
      revisionBodyBytes: "4",
      items: [
        {
          pageId: "p1",
          path: "pages/A.md",
          title: "A",
          body: "body",
          contentHash: "b".repeat(64),
          updatedAt: "2026-08-29T00:00:00.000Z",
        },
      ],
      nextCursor: "next",
    };
    http.responses.push(
      { status: 200, json: page },
      { status: 200, json: { ...page, nextCursor: "next" } },
    );
    await expect(
      collectSnapshot(new V1TreeRemote(client(http), "space", v1Capabilities)),
    ).rejects.toThrow(/游标重放/);
  });

  it("rejects a replayed v1 delta cursor", async () => {
    const http = new FakeHttp();
    const page = {
      protocolVersion: "1",
      spaceId: "space",
      fromRevision: "r0",
      toRevision: "r1",
      toSequence: 1,
      toRevisionContentHash: "a".repeat(64),
      toPageCount: "1",
      toRevisionManifestByteLength: "10",
      toRevisionBodyBytes: "4",
      items: [],
      nextCursor: "next",
    };
    http.responses.push(
      { status: 200, json: page },
      { status: 200, json: { ...page, nextCursor: "next" } },
    );
    await expect(
      new V1TreeRemote(client(http), "space", v1Capabilities).delta("r0"),
    ).rejects.toThrow(/游标重放/);
  });

  it("exposes a non-empty v1 capabilities hash without a timing trap", async () => {
    const http = new FakeHttp();
    const remote = new V1TreeRemote(client(http), "space", v1Capabilities);
    await expect(remote.capabilitiesHash).resolves.toMatch(/^[0-9a-f]{64}$/);
    expect(await remote.capabilitiesHash).toBe(
      await capabilitiesHash(v1Capabilities),
    );
  });
});

describe("V2TreeRemote", () => {
  it("rejects changed v2 pagination metadata", async () => {
    const http = new FakeHttp();
    http.responses.push(
      {
        status: 200,
        json: v2SnapshotPage({ revision: "r1", nextCursor: "next" }),
      },
      {
        status: 200,
        json: v2SnapshotPage({ revision: "r2", nextCursor: null }),
      },
    );
    await expect(
      collectSnapshot(new V2TreeRemote(client(http), "space", v2Selection())),
    ).rejects.toThrow(/分页元数据/);
  });

  it("rejects a replayed v2 pagination cursor", async () => {
    const http = new FakeHttp();
    http.responses.push(
      { status: 200, json: v2SnapshotPage({ nextCursor: "next" }) },
      { status: 200, json: v2SnapshotPage({ nextCursor: "next" }) },
    );
    await expect(
      collectSnapshot(new V2TreeRemote(client(http), "space", v2Selection())),
    ).rejects.toThrow(/分页游标重放/);
  });

  it("collects a paginated v2 tree with folders and pages", async () => {
    const http = new FakeHttp();
    http.responses.push(
      {
        status: 200,
        json: v2SnapshotPage({
          folderCount: "1",
          pageCount: "1",
          folders: [folderV2("f1", null, "pages/Guide")],
          pages: [pageV2("p1", "f1", "pages/Guide/A.md")],
          nextCursor: "next",
        }),
      },
      {
        status: 200,
        json: v2SnapshotPage({
          folderCount: "1",
          pageCount: "1",
          folders: [],
          pages: [],
          nextCursor: null,
        }),
      },
    );
    const snapshot = await collectSnapshot(
      new V2TreeRemote(client(http), "space", v2Selection()),
    );
    expect(snapshot.folders).toHaveLength(1);
    expect(snapshot.pages[0]).toMatchObject({
      folderId: "f1",
      path: "pages/Guide/A.md",
    });
  });

  it("parses the v2 space list with a strict local schema", async () => {
    const http = new FakeHttp();
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "2",
        spaces: [
          {
            spaceId: "space",
            displayName: "Space",
            role: "owner",
            canRead: true,
            canPublish: true,
            currentRevision: "r1",
            folderCount: "0",
            pageCount: "1",
            revisionManifestByteLength: "10",
            revisionBodyBytes: "4",
          },
        ],
      },
    });
    const spaces = await new V2TreeRemote(
      client(http),
      "space",
      v2Selection(),
    ).spaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0]).toMatchObject({ spaceId: "space", folderCount: "0" });
  });

  it("uses the v1 space list when v2 discovery has a server failure", async () => {
    vi.useFakeTimers();
    try {
      const http = new FakeHttp();
      http.route("GET", "/api/sync/v2/spaces", {
        status: 500,
        json: {
          protocolVersion: "2",
          error: {
            code: "INTERNAL_ERROR",
            message: "internal error",
            retryable: true,
          },
        },
      });
      http.route("GET", "/api/sync/v1/spaces", {
        status: 200,
        json: {
          protocolVersion: "1",
          spaces: [
            {
              spaceId: "space",
              displayName: "Space",
              role: "owner",
              canRead: true,
              canPublish: true,
              currentRevision: "r1",
              pageCount: "1",
              revisionManifestByteLength: "10",
              revisionBodyBytes: "4",
            },
          ],
        },
      });

      const pending = new V2TreeRemote(
        client(http),
        "space",
        v2Selection(),
      ).spaces();
      const assertion = expect(pending).resolves.toEqual([
        expect.objectContaining({
          spaceId: "space",
          displayName: "Space",
          role: "owner",
          canPublish: true,
          folderCount: "0",
        }),
      ]);
      await vi.runAllTimersAsync();
      await assertion;
      expect(http.calls.at(-1)?.path).toBe("/api/sync/v1/spaces");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hide v2 authorization failures behind the v1 fallback", async () => {
    const http = new FakeHttp();
    http.route("GET", "/api/sync/v2/spaces", {
      status: 403,
      json: {
        protocolVersion: "2",
        error: {
          code: "SPACE_FORBIDDEN",
          message: "forbidden",
          retryable: false,
        },
      },
    });

    await expect(
      new V2TreeRemote(client(http), "space", v2Selection()).spaces(),
    ).rejects.toMatchObject({ status: 403 });
    expect(http.calls.map((call) => call.path)).toEqual([
      "/api/sync/v2/spaces",
    ]);
  });

  it("runs a v2 push session through the adapter", async () => {
    const http = new FakeHttp();
    http.responses.push(
      {
        status: 201,
        json: {
          protocolVersion: "2",
          sessionId: UID,
          status: "uploading",
          expiresAt: "2099-01-01T00:00:00.000Z",
          result: null,
        },
      },
      {
        status: 200,
        json: {
          protocolVersion: "2",
          sessionId: UID,
          batchIndex: 0,
          batchHash: "f".repeat(64),
          receipt: "r0",
          receivedBatchCount: 1,
        },
      },
      {
        status: 200,
        json: {
          protocolVersion: "2",
          status: "published",
          revision: "r2",
          sequence: 2,
          publishedAt: "2026-08-29T00:00:00.000Z",
          revisionContentHash: "e".repeat(64),
          folderCount: "0",
          pageCount: "1",
          revisionManifestByteLength: "10",
          revisionBodyBytes: "4",
          changeSetId: "c1",
        },
      },
    );
    const remote = new V2TreeRemote(client(http), "space", v2Selection());
    const created = await remote.createPushSession({
      baseRevision: "r1",
      idempotencyKey: UID,
      capabilitiesHash: "c".repeat(64),
      confirmationHash: "d".repeat(64),
      confirmationByteLength: 10,
      changeCount: 1,
      totalBodyBytes: 4,
    });
    expect(created.sessionId).toBe(UID);
    const { receipt } = await remote.uploadBatch(UID, {
      protocolVersion: "2",
      batchIndex: 0,
      changes: [
        { operation: "upsert_page", page: pageV2("p1", null, "pages/A.md") },
      ],
      batchHash: "f".repeat(64),
    });
    expect(receipt).toBe("r0");
    const result = await remote.finalize(UID, "d".repeat(64));
    expect(result.protocolVersion).toBe("2");
    expect(result.status).toBe("published");
  });

  it("rejects a v2 delta that exceeds maxDeltaItems", async () => {
    const http = new FakeHttp();
    const items = Array.from(
      { length: TREE_SYNC_V2_LIMITS.maxDeltaItems + 1 },
      (_, index) => ({
        operation: "archive_page",
        pageId: `p${index}`,
        previousPath: "pages/Old.md",
      }),
    );
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "2",
        spaceId: "space",
        fromRevision: "r0",
        toRevision: "r1",
        toSequence: 1,
        toRevisionContentHash: "a".repeat(64),
        toFolderCount: "0",
        toPageCount: "0",
        toRevisionManifestByteLength: "10",
        toRevisionBodyBytes: "0",
        items,
        nextCursor: null,
      },
    });
    await expect(
      new V2TreeRemote(client(http), "space", v2Selection()).delta("r0"),
    ).rejects.toThrow(/增量条目数量超过限制/);
  });

  it("refreshes v2 capabilities with a live fetch and hash check", async () => {
    const http = new FakeHttp();
    const fresh = { ...v2Capabilities, maxBatchItems: 25 };
    http.responses.push({
      status: 200,
      json: {
        protocolVersion: "2",
        capabilities: fresh,
        capabilitiesHash: await capabilitiesHash(fresh),
      },
    });
    const remote = new V2TreeRemote(client(http), "space", v2Selection());
    const limits = await remote.refreshCapabilities();
    expect(limits.maxBatchItems).toBe(25);
    expect(http.calls[0]?.path).toBe("/api/sync/v2/capabilities");
  });
});

describe("FakeAgentWiki v2 capability", () => {
  it("defaults to protocol 2 and stores folders with public v2 hashes", async () => {
    const remote = new FakeAgentWiki();
    expect(remote.protocolVersion).toBe("2");
    remote.setProtocol("1");
    expect(remote.protocolVersion).toBe("1");
    remote.setProtocol("2");
    const folder = folderV2("f1", null, "pages/Guide");
    await remote.seedTree({ folders: [folder], pages: [] });
    expect(remote.tree().folders[0]?.path).toBe("pages/Guide");
    expect(await remote.treeRevisionHash()).toBe(
      await treeRevisionContentHashV2({
        protocolVersion: "2",
        spaceId: "space",
        folders: [folder],
        pages: [],
      }),
    );
  });
});
