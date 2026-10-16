import { describe, expect, it, vi } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { FakeTreeRemoteV3, V3_CAPABILITIES } from "../fakes/fake-tree-remote";
import { makePlugin } from "../fakes/plugin-harness";
import {
  ObsidianVaultPort,
  ObsidianControlStore,
} from "../../src/obsidian/adapters";
import { BaselineRepository } from "../../src/storage/baseline";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { idFileKey } from "../../src/core/identity-key";
import { MutableControlRepository } from "../../src/storage/envelope";
import { userErrorMessage } from "../../src/core/user-errors";
import type { ConnectionState } from "../../src/application/connection-service";
import type { SpaceMapping } from "../../src/application/sync-coordinator";

const connection: ConnectionState = {
  schemaVersion: 1,
  serverUrl: "https://wiki.example.com",
  serverInstanceId: "test-server",
  credentialId: "test-credential",
  credentialSecretId: "test-secret",
  deviceId: "11111111-1111-4111-8111-111111111111",
  vaultId: "22222222-2222-4222-8222-222222222222",
};
const clean = {
  protocolVersion: "2",
  recover: async () => {},
  status: async () => ({
    baseRevision: "r1",
    remoteRevision: "r1",
    local: { added: [], modified: [], renamed: [], deleted: [], ambiguous: [] },
  }),
};
async function fixture(
  version: 1 | 2 | 3 = 2,
  rootPath = "旧目录",
  status: SpaceMapping["status"] = "pending",
) {
  const h = await makePlugin({
    connection,
    data: {
      schemaVersion: 2,
      serverUrl: connection.serverUrl,
      mappings: [{ spaceId: "s1", rootPath, status }],
    },
    vaultFiles: {
      ".agentwiki/vault.json": JSON.stringify({
        schemaVersion: 1,
        vaultId: connection.vaultId,
      }),
      [`${rootPath}/保留.md`]: "原始正文\r\n",
      ".agentwiki/devices/other/spaces/s1/keep": "other device",
    },
  });
  await h.plugin.onload();
  const root = `.agentwiki/devices/d-${await idFileKey(connection.deviceId)}/spaces/s-${await idFileKey("s1")}`;
  const control = new ObsidianControlStore(h.app.vault.adapter as never);
  if (version === 1) {
    const repo = new BaselineRepository(control, root, "s1", rootPath);
    await repo.prepare("r1", [], "pull");
    await repo.commit();
  } else {
    const repo = new TreeBaselineRepository(control, root, "s1", rootPath);
    if (version === 2)
      await repo.prepare(
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
    else {
      const snapshot = {
        protocolVersion: "3" as const,
        spaceId: "s1",
        revision: "r1",
        revisionContentHash: "",
        folders: [],
        pages: [],
        attachments: [],
      };
      snapshot.revisionContentHash = await repo.revisionContentHashV3(snapshot);
      await repo.prepare(snapshot, "pull");
    }
    await repo.commit();
  }
  await control.write(`${root}/identity-evidence.json.next`, "preserve next");
  await control.write(`${root}/identity-evidence.json.prev`, "preserve prev");
  await control.writeBinary(`${root}/assets/blob`, new Uint8Array([0, 255, 1]));
  await control.write(
    `${root.replace(/s-[^/]+$/u, "s-other")}/keep`,
    "other space",
  );
  if (status === "active")
    (h.plugin as unknown as { runtime: () => Promise<unknown> }).runtime =
      async () => clean;
  return { ...h, root, control, rootPath };
}
function controlFiles(h: Awaited<ReturnType<typeof fixture>>) {
  return [...h.adapter.files].filter(([path]) => path.startsWith(`${h.root}/`));
}

// Missing whole-directory detachment must fail these consumer-visible lifecycle checks.
describe("mapping detachment", () => {
  it.each([1, 2, 3] as const)(
    "archives the entire v%i baseline and permits a new root without reusing it",
    async (version) => {
      const h = await fixture(version, "旧目录", "active");
      const before = controlFiles(h);
      await h.plugin.removeMapping("s1");
      expect(controlFiles(h)).toEqual([]);
      const archived = [...h.adapter.files].filter(([path]) =>
        path.includes("/detached/"),
      );
      expect(archived).toHaveLength(before.length);
      for (const [path, bytes] of before)
        expect(
          archived.find(([candidate]) =>
            candidate.endsWith(path.slice(h.root.length)),
          )?.[1],
        ).toBe(bytes);
      expect([...h.adapter.binaryFiles.values()]).toEqual([
        new Uint8Array([0, 255, 1]),
      ]);
      expect([...h.adapter.binaryFiles.keys()]).toEqual([
        expect.stringMatching(/\/detached\/.*\/assets\/blob$/u),
      ]);
      expect(h.adapter.files.get("旧目录/保留.md")).toBe("原始正文\r\n");
      expect(
        h.adapter.files.get(".agentwiki/devices/other/spaces/s1/keep"),
      ).toBe("other device");
      expect(
        h.adapter.files.get(`${h.root.replace(/s-[^/]+$/u, "s-other")}/keep`),
      ).toBe("other space");
      await h.plugin.addMapping("s1", "黄金书屋");
      expect(h.plugin.settings.mappings).toEqual([
        { spaceId: "s1", rootPath: "黄金书屋", status: "pending" },
      ]);
      expect(
        await new TreeBaselineRepository(
          h.control,
          h.root,
          "s1",
          "黄金书屋",
        ).readOptional(),
      ).toBeNull();
      expect(
        await new BaselineRepository(
          h.control,
          h.root,
          "s1",
          "黄金书屋",
        ).read(),
      ).toEqual({ revision: "0", pages: {} });
    },
  );

  it.each([
    ["黄金书屋", "黄金书屋"],
    ["Café", "Cafe\u0301"],
    ["Wiki", "wiki"],
  ])(
    "cancels a stale pending mapping from %s and rebinds %s",
    async (oldRoot, nextRoot) => {
      const h = await fixture(2, oldRoot);
      h.plugin.settings.mappings[0]!.rootPath = "已错误重绑";
      await h.plugin.saveSettings();
      await h.plugin.removeMapping("s1");
      await h.plugin.addMapping("s1", nextRoot);
      expect(h.plugin.settings.mappings[0]!.rootPath).toBe(
        nextRoot.normalize("NFC"),
      );
      expect(controlFiles(h)).toEqual([]);
    },
  );

  it.each([1, 2, 3])(
    "refuses to cancel pending mapping with an unfinished Pull v%i",
    async (version) => {
      const h = await fixture();
      const payload =
        version === 1
          ? {
              schemaVersion: 1,
              transactionId: "tx",
              state: "applying",
              actions: [],
              snapshots: [],
            }
          : {
              schemaVersion: version,
              transactionId: "tx",
              baseRevision: "r0",
              targetRevision: "r1",
              targetTreeHash: "hash",
              state: "applied",
              nextOperation: 0,
              operations: [],
            };
      await new MutableControlRepository(
        h.control,
        `${h.root}/pull/journal.json`,
        (v): v is typeof payload => !!v,
      ).write(payload);
      const before = new Map(h.adapter.files);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "MAPPING_TRANSACTION_PENDING",
      );
      expect(h.adapter.files).toEqual(before);
      expect(h.plugin.settings.mappings).toHaveLength(1);
    },
  );

  it("keeps the mapping and baseline when settings persistence fails", async () => {
    const h = await fixture();
    const before = controlFiles(h);
    vi.spyOn(h.plugin, "saveData").mockRejectedValueOnce(
      new Error("save failed"),
    );
    await expect(h.plugin.removeMapping("s1")).rejects.toThrow("save failed");
    expect(h.plugin.settings.mappings).toHaveLength(1);
    expect(controlFiles(h)).toEqual(before);
    await h.plugin.removeMapping("s1");
    expect(h.plugin.settings.mappings).toHaveLength(0);
  });

  it("reports root identity separately from Space and manifest hash damage", async () => {
    const h = await fixture();
    for (const [space, root, code] of [
      ["s1", "new root", "BASELINE_ROOT_MISMATCH"],
      ["other", h.rootPath, "BASELINE_SPACE_MISMATCH"],
    ]) {
      const before = new Map(h.adapter.files);
      await expect(
        new TreeBaselineRepository(h.control, h.root, space!, root!).read(),
      ).rejects.toThrow(code);
      expect(h.adapter.files).toEqual(before);
    }
    expect(userErrorMessage(new Error("BASELINE_ROOT_MISMATCH"))).toMatch(
      /取消.*重新/,
    );
    expect(userErrorMessage(new Error("BASELINE_SPACE_MISMATCH"))).toMatch(
      /空间/,
    );
    expect(
      userErrorMessage(new Error("BASELINE_MANIFEST_HASH_MISMATCH")),
    ).toMatch(/哈希/);
  });
});

describe("detachment faults and retained baseline validation", () => {
  it.each(["before", "after"])(
    "recovers a directory rename rejection %s the move",
    async (when) => {
      const h = await fixture();
      const before = controlFiles(h);
      const rename = h.adapter.rename.bind(h.adapter);
      let injected = false;
      vi.spyOn(h.adapter, "rename").mockImplementation(async (from, to) => {
        if (from === h.root && !injected) {
          injected = true;
          if (when === "after") await rename(from, to);
          throw new Error("rename interrupted");
        }
        await rename(from, to);
      });
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "rename interrupted",
      );
      expect(controlFiles(h)).toEqual(before);
      expect(h.plugin.settings.mappings).toHaveLength(1);
      await h.plugin.removeMapping("s1");
      expect(controlFiles(h)).toEqual([]);
    },
  );

  it.each([false, true])(
    "resolves a reload after settings write interruption (persisted=%s)",
    async (persisted) => {
      const h = await fixture();
      const before = controlFiles(h);
      const save = h.plugin.saveData.bind(h.plugin);
      vi.spyOn(h.plugin, "saveData").mockImplementationOnce(async (data) => {
        if (persisted) await save(data);
        throw new Error("process stopped");
      });
      // A stopped process cannot perform the immediate catch-path rollback.
      vi.spyOn(h.plugin, "loadData").mockRejectedValueOnce(
        new Error("process stopped"),
      );
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "MAPPING_DETACH_RECOVERY_REQUIRED",
      );
      expect(controlFiles(h)).toEqual([]);
      const next = await makePlugin({
        data: h.app.__pluginData,
        local: h.local,
        vaultFiles: Object.fromEntries<string | Uint8Array>([
          ...h.adapter.files,
          ...h.adapter.binaryFiles,
        ]),
      });
      await next.plugin.onload();
      expect(next.plugin.settings.mappings).toHaveLength(persisted ? 0 : 1);
      const source = [...next.adapter.files].filter(([path]) =>
        path.startsWith(`${h.root}/`),
      );
      expect(source).toEqual(persisted ? [] : before);
      if (persisted)
        expect(
          [...next.adapter.files.keys()].some((path) =>
            path.includes("/detached/"),
          ),
        ).toBe(true);
      else
        expect(
          await new TreeBaselineRepository(
            new ObsidianControlStore(next.app.vault.adapter as never),
            h.root,
            "s1",
            h.rootPath,
          ).read(),
        ).toMatchObject({ baseRevision: "r1" });
    },
  );

  it("retains the operation lock until persisted mappings and archive agree", async () => {
    const h = await fixture();
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const save = h.plugin.saveData.bind(h.plugin);
    vi.spyOn(h.plugin, "saveData").mockImplementationOnce(async (value) => {
      entered();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      await save(value);
    });
    const removal = h.plugin.removeMapping("s1");
    await paused;
    const locks = (
      h.plugin as unknown as {
        locks: { acquire: (spaceId: string) => () => void };
      }
    ).locks;
    expect(() => locks.acquire("s1")).toThrow("活跃操作");
    const adding = h.plugin.addMapping("s2", "Other");
    resume();
    await removal;
    await adding;
    locks.acquire("s1")();
    await h.plugin.removeMapping("s1");
    expect(h.plugin.settings.mappings).toEqual([
      { spaceId: "s2", rootPath: "Other", status: "pending" },
    ]);
  });

  it.each([1, 2, 3] as const)(
    "reuses unchanged v%i identity and refuses true manifest hash mismatch",
    async (version) => {
      const h = await fixture(version, "黄金书屋");
      const repo =
        version === 1
          ? new BaselineRepository(h.control, h.root, "s1", h.rootPath)
          : new TreeBaselineRepository(h.control, h.root, "s1", h.rootPath);
      const before = controlFiles(h);
      await expect(repo.read()).resolves.toBeDefined();
      expect(controlFiles(h)).toEqual(before);
      const manifestPath = [...h.adapter.files.keys()].find(
        (path) => path.startsWith(h.root) && path.endsWith("/manifest.json"),
      )!;
      const manifest = JSON.parse(h.adapter.files.get(manifestPath)!) as {
        lastSuccessfulSyncAt: string;
      };
      manifest.lastSuccessfulSyncAt = "2026-01-01T00:00:00.000Z";
      h.adapter.files.set(manifestPath, JSON.stringify(manifest));
      const damaged = new Map(h.adapter.files);
      await expect(repo.read()).rejects.toThrow(
        "BASELINE_MANIFEST_HASH_MISMATCH",
      );
      expect(h.adapter.files).toEqual(damaged);
    },
  );

  it.each(["prepared", "applying", "committing", "failed"])(
    "blocks pending cancellation while a baseline is %s",
    async (phase) => {
      const h = await fixture();
      const repo = new TreeBaselineRepository(
        h.control,
        h.root,
        "s1",
        h.rootPath,
      );
      await repo.prepare(
        {
          protocolVersion: "2",
          spaceId: "s1",
          revision: "r2",
          revisionContentHash: "",
          folders: [],
          pages: [],
        },
        "pull",
      );
      await repo.setPhase(phase as "prepared");
      const before = new Map(h.adapter.files);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "MAPPING_TRANSACTION_PENDING",
      );
      expect(h.adapter.files).toEqual(before);
    },
  );
});

describe("detachment transaction coverage", () => {
  it.each(["foldersAdded", "foldersMoved", "foldersDeleted", "ambiguous"])(
    "keeps active mapping with unresolved %s",
    async (field) => {
      const h = await fixture(2, "Wiki", "active");
      (h.plugin as unknown as { runtime: () => Promise<unknown> }).runtime =
        async () => ({
          ...clean,
          status: async () => {
            const status = await clean.status();
            return {
              ...status,
              local: {
                ...status.local,
                foldersAdded: [],
                foldersMoved: [],
                foldersDeleted: [],
                ambiguous: [],
                [field]: [{}],
              },
            };
          },
        });
      const before = controlFiles(h);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(/干净/);
      expect(controlFiles(h)).toEqual(before);
    },
  );
});

describe("rebind preview and pending owners", () => {
  it("produces a first Pull preview after cancelling an old-root pending mapping", async () => {
    const h = await fixture();
    const stale = h.plugin.settings.mappings[0]!;
    stale.rootPath = "黄金书屋";
    await h.plugin.saveSettings();
    const lifecycle = h.plugin as unknown as {
      runtime: (mapping: SpaceMapping) => Promise<unknown>;
    };
    await expect(lifecycle.runtime(stale)).rejects.toThrow(
      "BASELINE_ROOT_MISMATCH",
    );
    await h.plugin.removeMapping("s1");
    await h.plugin.addMapping("s1", "黄金书屋");
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ spaceId: "s1", revision: "r1" });
    const runtime = SyncRuntime.v3(
      new ObsidianVaultPort(
        h.app.vault as never,
        h.app.fileManager as never,
        "黄金书屋",
      ),
      h.control,
      remote,
      h.plugin.settings.mappings[0]!,
      await idFileKey(connection.deviceId),
      await idFileKey("s1"),
    );
    const preview = await runtime.previewPullV3();
    expect(preview.base.revision).toBe("0");
    expect(preview.remote.revision).toBe("r1");
    expect(h.plugin.settings.mappings[0]!.status).toBe("pending");
    expect(h.adapter.files.get("旧目录/保留.md")).toBe("原始正文\r\n");
  });

  it.each([1, 2, 3])(
    "blocks a pending Push v%i even when connection state is absent",
    async (version) => {
      const h = await fixture();
      const payload = {
        schemaVersion: version,
        spaceId: "s1",
        baseRevision: "r1",
        idempotencyKey: "owner",
        confirmationHash: "a".repeat(64),
        capabilitiesHash: "b".repeat(64),
        capabilities: V3_CAPABILITIES,
        changes: [],
        totalBodyBytes: 0,
        sessionId: null,
        credentialIdAtCreation: "credential",
        remoteState: "not_created",
        result: null,
        localCommitPhase: "not_started",
        ...(version === 3
          ? {
              protocolVersion: "3",
              requiredBlobs: {},
              blobRequirements: [],
              attachmentCount: 0,
              transferBlobBytes: 0,
            }
          : {}),
      };
      await new MutableControlRepository(
        h.control,
        `${h.root}/push/journal.json`,
        (value): value is typeof payload => !!value,
      ).write(payload);
      for (const key of [...h.local.keys()])
        if (key.includes("connection-state")) h.local.delete(key);
      const before = new Map(h.adapter.files);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "MAPPING_TRANSACTION_PENDING",
      );
      expect(h.adapter.files).toEqual(before);
      expect(h.plugin.settings.mappings).toHaveLength(1);
    },
  );

  it.each(["pull-control-after.json", "v3-pull-control-after.json"])(
    "blocks incomplete %s even after the Pull journal committed",
    async (path) => {
      const h = await fixture();
      const payload =
        path === "pull-control-after.json"
          ? {
              schemaVersion: 1,
              transactionId: "tx",
              phase: "pending",
              identities: { schemaVersion: 1, entries: {} },
              moveHints: { schemaVersion: 1, hints: [] },
            }
          : {
              schemaVersion: 2,
              transactionId: "tx",
              phase: "pending",
              identities: {
                schemaVersion: 2,
                folders: {},
                pendingFolders: {},
                pendingPages: {},
                attachments: {},
                pendingAttachments: {},
              },
            };
      await new MutableControlRepository(
        h.control,
        `${h.root}/${path}`,
        (value): value is typeof payload => !!value,
      ).write(payload);
      const before = new Map(h.adapter.files);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
        "MAPPING_TRANSACTION_PENDING",
      );
      expect(h.adapter.files).toEqual(before);
    },
  );

  it("blocks a pending image upgrade while cancelling a pending mapping", async () => {
    const h = await fixture();
    const payload = {
      schemaVersion: 1,
      binding: {
        operationId: "op",
        serverInstanceId: "server",
        spaceId: "s1",
        deviceId: connection.deviceId,
        credentialId: "credential",
        mappingRootKey: h.rootPath,
      },
      sourceRevision: "r1",
      sourceV2RevisionHash: "a".repeat(64),
      oldBaselineEvidenceHash: "a".repeat(64),
      projectedV3BaseHash: "a".repeat(64),
      capabilitiesHash: "a".repeat(64),
      confirmationHash: "a".repeat(64),
      candidateHash: "a".repeat(64),
      localPlanHash: "a".repeat(64),
      authorizationHash: "a".repeat(64),
      payloadPaths: [],
      pushOperationId: "push",
      localTransactionId: "local",
      phase: "confirmed",
      verifiedPublication: null,
    };
    await new MutableControlRepository(
      h.control,
      `${h.root}/local-image-upgrade/journal.json`,
      (value): value is typeof payload => !!value,
    ).write(payload);
    const before = new Map(h.adapter.files);
    await expect(h.plugin.removeMapping("s1")).rejects.toThrow(
      "未完成的图片同步升级",
    );
    expect(h.adapter.files).toEqual(before);
  });

  it.each(["{broken", JSON.stringify({ envelopeSchemaVersion: 99 })])(
    "retains unknown or damaged transaction evidence",
    async (raw) => {
      const h = await fixture();
      await h.control.write(`${h.root}/pull/journal.json.next`, raw);
      const before = new Map(h.adapter.files);
      await expect(h.plugin.removeMapping("s1")).rejects.toThrow();
      expect(h.adapter.files).toEqual(before);
      expect(h.plugin.settings.mappings).toHaveLength(1);
    },
  );
});

describe("mapping settings concurrency", () => {
  it("cannot resurrect a detached mapping through another settings save", async () => {
    const h = await fixture();
    let releaseRemoval!: () => void;
    let releaseSettings!: () => void;
    let reachedCommit!: () => void;
    const entered = new Promise<void>((resolve) => {
      reachedCommit = resolve;
    });
    const removeGate = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const saveGate = new Promise<void>((resolve) => {
      releaseSettings = resolve;
    });
    const save = h.plugin.saveData.bind(h.plugin);
    let calls = 0;
    vi.spyOn(h.plugin, "saveData").mockImplementation(async (value) => {
      calls += 1;
      if (calls === 1) {
        reachedCommit();
        await removeGate;
      } else await saveGate;
      await save(value);
    });
    const removing = h.plugin.removeMapping("s1");
    await entered;
    const saving = h.plugin.saveSettings();
    releaseRemoval();
    await removing;
    releaseSettings();
    await saving;
    expect(h.app.__pluginData).toMatchObject({ mappings: [] });
    expect(controlFiles(h)).toEqual([]);
  });
});
