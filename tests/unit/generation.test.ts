import { describe, expect, it } from "vitest";
import { MemoryControlStore } from "../fakes/memory-control-store";
import {
  canonicalBytes,
  contentHash,
  revisionContentHash,
} from "../../src/agentwiki/protocol";
import { opaqueFileKey } from "../../src/core/identity-key";
import { StorageMigration } from "../../src/storage/migration";
import {
  GenerationRepository,
  type SpaceManifest,
} from "../../src/storage/generation";

describe("immutable generations", () => {
  it("writes and verifies manifest, base bodies and revision metrics", async () => {
    const store = new MemoryControlStore();
    const repo = new GenerationRepository(store, ".agentwiki/device/space");
    const manifest: SpaceManifest = {
      schemaVersion: 1,
      protocolVersion: "1",
      generationId: "g1",
      spaceId: "s",
      rootPath: "Wiki",
      baseRevision: "r1",
      baseRevisionContentHash: "",
      basePageCount: 1,
      baseRevisionManifestByteLength: 0,
      baseRevisionBodyBytes: 5,
      lastSuccessfulSyncAt: "2026-08-14T00:00:00.000Z",
      pages: {
        p1: { pageId: "p1", relativePath: "A.md", title: "A", contentHash: "" },
      },
    };
    await repo.write(manifest, { p1: "hello" });
    const verified = await repo.verify("g1");
    expect(verified.basePageCount).toBe(1);
    // 现在使用可读路径 A.md 而不是哈希路径
    await store.write(
      `.agentwiki/device/space/generations/g1/base/A.md`,
      "tampered",
    );
    await expect(repo.verify("g1")).rejects.toThrow(/损坏/);
  });

  it("rejects manifest key identity and portable-path collisions", async () => {
    const store = new MemoryControlStore();
    const repo = new GenerationRepository(store, ".agentwiki/device/space");
    const manifest: SpaceManifest = {
      schemaVersion: 1,
      protocolVersion: "1",
      generationId: "g2",
      spaceId: "s",
      rootPath: "Wiki",
      baseRevision: "r1",
      baseRevisionContentHash: "",
      basePageCount: 1,
      baseRevisionManifestByteLength: 0,
      baseRevisionBodyBytes: 1,
      lastSuccessfulSyncAt: "2026-08-14T00:00:00.000Z",
      pages: {
        wrong: {
          pageId: "p1",
          relativePath: "A.md",
          title: "A",
          contentHash: "",
        },
      },
    };
    await expect(repo.write(manifest, { wrong: "x" })).rejects.toThrow(/身份/);
  });

  it("verifies and reads legacy generations whose bodies sit at flat hash paths", async () => {
    const store = new MemoryControlStore();
    const repo = new GenerationRepository(store, ".agentwiki/device/space");
    const body = "旧版内容";
    const hash = await contentHash(body);
    const protocolManifest = {
      protocolVersion: "1" as const,
      spaceId: "s",
      pages: [
        {
          pageId: "p1",
          path: "pages/legacy-note.md",
          title: "legacy-note",
          contentHash: hash,
        },
      ],
    };
    const legacyManifest: SpaceManifest = {
      schemaVersion: 1,
      protocolVersion: "1",
      generationId: "g-legacy",
      spaceId: "s",
      rootPath: "Wiki",
      baseRevision: "r1",
      baseRevisionContentHash: await revisionContentHash(protocolManifest),
      basePageCount: 1,
      baseRevisionManifestByteLength: canonicalBytes(protocolManifest)
        .byteLength,
      baseRevisionBodyBytes: new TextEncoder().encode(body).byteLength,
      lastSuccessfulSyncAt: "2026-08-14T00:00:00.000Z",
      pages: {
        p1: {
          pageId: "p1",
          relativePath: "pages/legacy-note.md",
          title: "legacy-note",
          contentHash: hash,
        },
      },
    };
    await store.write(
      ".agentwiki/device/space/generations/g-legacy/manifest.json",
      JSON.stringify(legacyManifest),
    );
    const hashName = (await opaqueFileKey("p1")) + ".md";
    await store.write(
      ".agentwiki/device/space/generations/g-legacy/base/" + hashName,
      body,
    );

    const verified = await repo.verify("g-legacy");
    expect(verified.pages.p1?.contentHash).toBe(hash);
    await expect(
      repo.readBody("g-legacy", "p1", hash, "pages/legacy-note.md"),
    ).resolves.toBe(body);

    const migration = new StorageMigration(store);
    const result = await migration.migrateGeneration(
      ".agentwiki/device/space",
      "g-legacy",
    );
    expect(result.migrated).toBe(1);
    expect(result.errors).toHaveLength(0);
    await expect(
      store.read(
        ".agentwiki/device/space/generations/g-legacy/base/pages/legacy-note.md",
      ),
    ).resolves.toBe(body);
    await expect(repo.verify("g-legacy")).resolves.toBeTruthy();
  });
});
