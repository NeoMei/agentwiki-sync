import { describe, expect, it, vi } from "vitest";
import { makePlugin } from "../fakes/plugin-harness";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";
import {
  ObsidianControlStore,
  ObsidianVaultPort,
} from "../../src/obsidian/adapters";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { idFileKey } from "../../src/core/identity-key";
import type { SpaceMapping } from "../../src/application/sync-coordinator";
import type { SyncDiff } from "../../src/obsidian/sync-center-modal";
import { contentHash } from "../../src/agentwiki/protocol";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const connection = {
    schemaVersion: 1 as const,
    serverUrl: "https://wiki.example.com",
    serverInstanceId: "test-server",
    credentialId: "test-credential",
    credentialSecretId: "test-secret",
    deviceId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222",
  };
  const mapping: SpaceMapping = {
    spaceId: "s1",
    rootPath: "Wiki",
    status: "pending",
  };
  const h = await makePlugin({
    connection,
    data: {
      schemaVersion: 2,
      serverUrl: connection.serverUrl,
      mappings: [mapping],
    },
    vaultFiles: {
      ".agentwiki/vault.json": JSON.stringify({
        schemaVersion: 1,
        vaultId: connection.vaultId,
      }),
      "Wiki/keep.md": "keep",
    },
  });
  await h.plugin.onload();
  const deviceKey = await idFileKey(connection.deviceId),
    spaceKey = await idFileKey("s1");
  const root = `.agentwiki/devices/d-${deviceKey}/spaces/s-${spaceKey}`;
  const control = new ObsidianControlStore(h.app.vault.adapter as never);
  const baseline = new TreeBaselineRepository(control, root, "s1", "Wiki");
  await baseline.prepare(
    {
      protocolVersion: "2",
      spaceId: "s1",
      revision: "r1",
      revisionContentHash: "",
      folders: [],
      pages: [],
    },
    "pull",
  );
  await baseline.commit();
  const remote = new FakeTreeRemote();
  await remote.seedTree({
    folders: [],
    pages: [],
  });
  const runtime = new SyncRuntime(
    new ObsidianVaultPort(
      h.app.vault as never,
      h.app.fileManager as never,
      "Wiki",
    ),
    control,
    remote,
    mapping,
    deviceKey,
    spaceKey,
  );
  const subject = h.plugin as unknown as {
    runtime: (mapping: SpaceMapping) => Promise<SyncRuntime | null>;
    collectSyncDiff: (id: string, options: object) => Promise<SyncDiff>;
  };
  vi.spyOn(h.plugin, "listAccessibleSpaces").mockResolvedValue([
    {
      spaceId: "s1",
      displayName: "s1",
      canRead: true,
      canPublish: true,
      role: "owner",
      currentRevision: "r1",
      pageCount: "0",
      revisionManifestByteLength: "0",
      revisionBodyBytes: "0",
    },
  ]);
  return { ...h, subject, runtime, root, mapping, baseline, control };
}

describe("mapping detachment and diff concurrency", () => {
  it("keeps the Space locked while an earlier refresh awaits runtime creation", async () => {
    const h = await fixture();
    const entered = gate(),
      resume = gate();
    h.subject.runtime = async () => {
      entered.resolve();
      await resume.promise;
      return h.runtime;
    };
    const diff = h.subject.collectSyncDiff("s1", {});
    await entered.promise;
    let removalError: unknown;
    try {
      await h.plugin.removeMapping("s1").catch((error: unknown) => {
        removalError = error;
      });
    } finally {
      resume.resolve();
    }
    await diff;
    expect(removalError).toBeInstanceOf(Error);
    expect((removalError as Error).message).toContain("已有活跃操作");
    expect(await h.adapter.exists(h.root)).toBe(true);
    expect(h.plugin.settings.mappings).toHaveLength(1);
    await h.plugin.removeMapping("s1");
    expect(await h.adapter.exists(h.root)).toBe(false);
    expect(h.plugin.settings.mappings).toEqual([]);
    expect(h.adapter.files.get("Wiki/keep.md")).toBe("keep");
  });

  it("rejects a refresh before runtime lookup while removal is committing settings", async () => {
    const h = await fixture();
    const entered = gate(),
      resume = gate();
    const runtimeLookup = vi.fn(async () => h.runtime);
    h.subject.runtime = runtimeLookup;
    const save = h.plugin.saveData.bind(h.plugin);
    vi.spyOn(h.plugin, "saveData").mockImplementationOnce(async (value) => {
      entered.resolve();
      await resume.promise;
      await save(value);
    });
    const removal = h.plugin.removeMapping("s1");
    await entered.promise;
    let diffError: unknown;
    try {
      await h.subject.collectSyncDiff("s1", {}).catch((error: unknown) => {
        diffError = error;
      });
    } finally {
      resume.resolve();
    }
    await removal;
    expect(diffError).toBeInstanceOf(Error);
    expect((diffError as Error).message).toContain("已有活跃操作");
    expect(runtimeLookup).not.toHaveBeenCalled();
    expect(await h.adapter.exists(h.root)).toBe(false);
    expect(h.plugin.settings.mappings).toEqual([]);
  });

  it("rejects stale mapping runtime construction after removal without recreating state", async () => {
    const h = await fixture();
    const stale = h.plugin.settings.mappings[0]!;
    await h.plugin.removeMapping("s1");
    const before = new Map(h.adapter.files);
    await expect(h.subject.runtime(stale)).rejects.toThrow("MAPPING_CHANGED");
    expect(h.adapter.files).toEqual(before);
  });

  it("releases the refresh lock after a failure so removal can proceed", async () => {
    const h = await fixture();
    h.subject.runtime = async () => {
      throw new Error("fixture failure");
    };
    await expect(h.subject.collectSyncDiff("s1", {})).rejects.toThrow(
      "fixture failure",
    );
    await expect(h.plugin.removeMapping("s1")).resolves.toBeUndefined();
    expect(await h.adapter.exists(h.root)).toBe(false);
  });

  it("keeps live mapping status updates when another Space is added", async () => {
    const h = await fixture();
    const runtimeMapping = h.plugin.settings.mappings[0]!;
    await h.plugin.addMapping("s2", "Other");
    runtimeMapping.status = "active";
    await h.plugin.saveSettings();
    expect(h.app.__pluginData).toMatchObject({
      mappings: [
        { spaceId: "s1", status: "active" },
        { spaceId: "s2", status: "pending" },
      ],
    });
  });

  it("does not disconnect credentials while a refresh owns the Space", async () => {
    const h = await fixture();
    const entered = gate(),
      resume = gate();
    h.subject.runtime = async () => {
      entered.resolve();
      await resume.promise;
      return h.runtime;
    };
    const diff = h.subject.collectSyncDiff("s1", {});
    await entered.promise;
    try {
      await expect(h.plugin.disconnect()).rejects.toThrow("已有活跃操作");
      expect(h.secretValue("test-secret")).toBe("test-secret");
    } finally {
      resume.resolve();
    }
    await diff;
  });

  it("drains an earlier Vault rename hint before moving the complete control directory", async () => {
    const h = await fixture();
    const body = "rename fixture";
    await h.baseline.prepare(
      {
        protocolVersion: "2",
        spaceId: "s1",
        revision: "r2",
        revisionContentHash: "",
        folders: [],
        pages: [
          {
            pageId: "p1",
            folderId: null,
            path: "pages/old.md",
            title: "old",
            body,
            contentHash: await contentHash(body),
            updatedAt: "2026-10-16T00:00:00.000Z",
          },
        ],
      },
      "pull",
    );
    await h.baseline.commit();
    h.adapter.files.set("Wiki/pages/new.md", body);
    h.adapter.deriveParents("Wiki/pages/new.md");
    const registry = h.plugin as unknown as {
      liveRuntimes: Map<string, SyncRuntime>;
    };
    registry.liveRuntimes.set("fixture", h.runtime);
    const entered = gate(),
      resume = gate();
    const write = h.control.write.bind(h.control);
    vi.spyOn(h.control, "write").mockImplementation(async (path, bytes) => {
      if (path.endsWith("/move-hints.json.next")) {
        entered.resolve();
        await resume.promise;
      }
      await write(path, bytes);
    });
    const rename = h.runtime.recordRename(
      "Wiki/pages/old.md",
      "Wiki/pages/new.md",
    );
    await entered.promise;
    const retire = vi.spyOn(h.runtime, "retire");
    const removal = h.plugin.removeMapping("s1");
    await vi.waitFor(() => expect(retire).toHaveBeenCalled());
    expect(await h.adapter.exists(h.root)).toBe(true);
    resume.resolve();
    await rename;
    await removal;
    expect(await h.adapter.exists(h.root)).toBe(false);
    const archivedHints = [...h.adapter.files].filter(
      ([path]) =>
        path.includes("/detached/") && path.endsWith("/move-hints.json"),
    );
    expect(archivedHints).toHaveLength(1);
    expect(archivedHints[0]?.[1]).toContain("pages/new.md");
    const before = new Map(h.adapter.files);
    await h.runtime.recordRename("Wiki/pages/new.md", "Wiki/pages/third.md");
    expect(h.adapter.files).toEqual(before);
  });
});
