import { describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../../src/application/connection-service";
import type { SpaceMapping } from "../../src/application/sync-coordinator";
import { validateMappings } from "../../src/application/sync-coordinator";
import { idFileKey } from "../../src/core/identity-key";
import {
  ObsidianControlStore,
  ObsidianVaultPort,
} from "../../src/obsidian/adapters";
import { SyncRuntime } from "../../src/application/sync-runtime";
import { TreeBaselineRepository } from "../../src/storage/tree-baseline";
import { makePlugin } from "../fakes/plugin-harness";
import { requestUrlState } from "../fakes/obsidian-mock";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";

const connection: ConnectionState = {
  schemaVersion: 1,
  serverUrl: "https://wiki.example.com",
  serverInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  credentialId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  credentialSecretId: "fixture-secret",
  deviceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  vaultId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

async function seeded() {
  const h = await makePlugin({
    data: {
      schemaVersion: 2,
      serverUrl: connection.serverUrl,
      mappings: [{ spaceId: "space-1", rootPath: "Wiki", status: "active" }],
    },
    connection,
    vaultFiles: {
      ".agentwiki/vault.json": JSON.stringify({
        schemaVersion: 1,
        vaultId: connection.vaultId,
      }),
      "Outside/keep.md": "fixture body must remain unchanged",
    },
  });
  await h.plugin.onload();
  h.adapter.folders.add("Wiki");
  const root = `.agentwiki/devices/d-${await idFileKey(connection.deviceId)}/spaces/s-${await idFileKey("space-1")}`;
  const store = new ObsidianControlStore(h.adapter as never);
  const baseline = new TreeBaselineRepository(store, root, "space-1", "Wiki");
  await baseline.prepare(
    {
      protocolVersion: "2",
      spaceId: "space-1",
      revision: "0",
      revisionContentHash: "0".repeat(64),
      folders: [],
      pages: [],
    },
    "pull",
    "fixture-pull",
  );
  await baseline.recover("fixture-pull");
  return { ...h, root, store, baseline };
}

describe("official 0.5.10 baseline identity investigation", () => {
  it.each(["Wiki\\Sub", "D:\\Notes\\Wiki", "/Wiki", "Wiki/"])(
    "rejects unsupported root %s before a baseline can be created",
    async (root) => {
      const h = await makePlugin({
        data: {
          schemaVersion: 2,
          serverUrl: connection.serverUrl,
          mappings: [],
        },
      });
      await h.plugin.onload();
      await expect(h.plugin.addMapping("space-1", root)).rejects.toThrow();
      expect(h.plugin.settings.mappings).toEqual([]);
      expect(
        [...h.adapter.files.keys()].filter((p) => p.includes("tree-v2")),
      ).toEqual([]);
    },
  );

  it("normalizes Unicode composition but preserves case in a validated mapping", () => {
    const mappings: SpaceMapping[] = [
      { spaceId: "s", rootPath: "Cafe\u0301/WIKI", status: "pending" },
    ];
    validateMappings(mappings);
    expect(mappings[0]?.rootPath).toBe("Caf\u00e9/WIKI");
  });

  it("fresh connection and new mapping reaches HTTP without baseline mismatch", async () => {
    const h = await makePlugin({
      data: { schemaVersion: 2, serverUrl: connection.serverUrl, mappings: [] },
      connection,
      vaultFiles: {
        ".agentwiki/vault.json": JSON.stringify({
          schemaVersion: 1,
          vaultId: connection.vaultId,
        }),
      },
    });
    await h.plugin.onload();
    await h.plugin.addMapping("space-1", "Wiki");
    requestUrlState.impl = vi.fn(async () => {
      throw new Error("NETWORK_BOUNDARY_REACHED");
    });
    const subject = h.plugin as unknown as {
      collectSyncDiff: (spaceId: string, options: object) => Promise<unknown>;
    };
    await expect(subject.collectSyncDiff("space-1", {})).rejects.toThrow(
      "NETWORK_BOUNDARY_REACHED",
    );
    expect(requestUrlState.impl).toHaveBeenCalled();
  });

  it("reads an unchanged baseline and rejects a changed expected root without modifying bytes", async () => {
    const h = await seeded();
    const before = new Map(h.adapter.files);
    await expect(h.baseline.readOptional()).resolves.toMatchObject({
      rootPath: "Wiki",
      baseRevision: "0",
    });
    await expect(
      new TreeBaselineRepository(
        h.store,
        h.root,
        "space-1",
        "wiki",
      ).readOptional(),
    ).rejects.toThrow("BASELINE_ROOT_MISMATCH");
    expect(h.adapter.files).toEqual(before);
  });

  it.each(["Wiki", "NewWiki", "wiki"])(
    "reaches HTTP when readding an allowed removed mapping at root %s",
    async (nextRoot) => {
      const h = await seeded();
      const controlBefore = new Map(
        [...h.adapter.files].filter(([p]) =>
          p.startsWith(h.root + "/tree-v2/"),
        ),
      );
      const subject = h.plugin as unknown as {
        runtime: (mapping: SpaceMapping) => Promise<unknown>;
        collectSyncDiff: (spaceId: string, options: object) => Promise<unknown>;
      };
      // Removal uses the real runtime, real Vault adapter, persisted baseline,
      // recovery and status scanner with a deterministic remote only.
      const originalRuntime = subject.runtime;
      subject.runtime = async () =>
        new SyncRuntime(
          new ObsidianVaultPort(
            h.app.vault as never,
            h.app.fileManager as never,
            "Wiki",
          ),
          h.store,
          new FakeTreeRemote(),
          { spaceId: "space-1", rootPath: "Wiki", status: "active" },
          await idFileKey(connection.deviceId),
          await idFileKey("space-1"),
          connection.credentialId,
        );
      await h.plugin.removeMapping("space-1");
      subject.runtime = originalRuntime;
      expect(h.plugin.settings.mappings).toEqual([]);
      expect(
        new Map(
          [...h.adapter.files].filter(([p]) =>
            p.startsWith(h.root + "/tree-v2/"),
          ),
        ),
      ).toEqual(new Map());
      const archivedBaseline = new Map(
        [...h.adapter.files]
          .filter(
            ([path]) =>
              path.includes("/detached/") && path.includes("/tree-v2/"),
          )
          .map(([path, bytes]) => [
            path.slice(path.indexOf("/tree-v2/")),
            bytes,
          ]),
      );
      expect(archivedBaseline).toEqual(
        new Map(
          [...controlBefore].map(([path, bytes]) => [
            path.slice(h.root.length),
            bytes,
          ]),
        ),
      );
      await h.plugin.addMapping("space-1", nextRoot);
      expect(h.adapter.files.get("Outside/keep.md")).toBe(
        "fixture body must remain unchanged",
      );
      requestUrlState.impl = vi.fn(async () => {
        throw new Error("NETWORK_BOUNDARY_REACHED");
      });
      // A new mapping must reach protocol negotiation, not read old-root state.
      await expect(subject.collectSyncDiff("space-1", {})).rejects.toThrow(
        "NETWORK_BOUNDARY_REACHED",
      );
      expect(requestUrlState.impl).toHaveBeenCalled();
    },
  );
});
