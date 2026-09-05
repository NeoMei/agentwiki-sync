import { describe, expect, it } from "vitest";
import * as local from "../../src/agentwiki/protocol";
import * as published from "@neomei/agentwiki-sync-protocol";
import {
  SYNC_PROTOCOL_V3,
  TreeCapabilitiesResponseV3Schema,
  SYNC_PROTOCOL_V2,
  TreeCapabilitiesResponseV2Schema,
  treeCapabilitiesHashV3,
  treeRevisionContentHashV2,
} from "@neomei/agentwiki-sync-protocol";
import {
  portablePathKey,
  validatePortablePath as localValidatePortablePath,
} from "../../src/core/portable-path";

describe("protocol conformance against the published package", () => {
  it("loads the exact published v3 capabilities contract", async () => {
    const capabilities = {
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
      maxAttachmentBytes: 1,
      maxRevisionAttachments: 1,
      maxTransferBlobBytes: 1,
      blobChunkBytes: 1,
      maxBlobChunks: 1,
      maxConcurrentBlobs: 1,
      maxImageDimension: 1,
      maxDecodedPixels: 1,
      allowedMimeTypes: ["image/png"] as Array<"image/png">,
      blobStagingTtlSeconds: 1,
      downloadAuthorizationTtlSeconds: 1,
    };
    const parsed = TreeCapabilitiesResponseV3Schema.parse({
      protocolVersion: SYNC_PROTOCOL_V3,
      capabilities,
      capabilitiesHash: await treeCapabilitiesHashV3(capabilities),
    });
    expect(parsed.protocolVersion).toBe("3");
    expect(parsed.capabilitiesHash).toMatch(/^[0-9a-f]{64}$/);
  });

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

  it("produces identical canonical bytes for representative values", () => {
    for (const value of [
      { z: 1, a: "雪", nested: { list: [1, 2, 3], flag: true } },
      { pages: [{ pageId: "p1", path: "A.md", title: "A", contentHash: "h" }] },
      {
        changes: [
          { operation: "archive", pageId: "p", previousPath: "Old.md" },
        ],
      },
      { empty: {}, null: null, zero: 0 },
    ]) {
      expect(Array.from(local.canonicalBytes(value))).toEqual(
        Array.from(published.canonicalBytes(value)),
      );
    }
  });

  it("produces identical content, confirmation, batch, and revision hashes", async () => {
    expect(await local.contentHash("Hello\r\n")).toBe(
      await published.contentHash("Hello\r\n"),
    );

    const upsert = {
      operation: "upsert" as const,
      pageId: "11111111-1111-4111-8111-111111111111",
      path: "Guide.md",
      title: "Guide",
      body: "Hello\n",
      contentHash: await published.contentHash("Hello\n"),
    };
    const archive = {
      operation: "archive" as const,
      pageId: "22222222-2222-4222-8222-222222222222",
      previousPath: "Old.md",
    };

    const confirmation = {
      protocolVersion: "1" as const,
      spaceId: "space-a",
      baseRevision: "rev-7",
      changes: [
        {
          operation: "upsert" as const,
          pageId: "11111111-1111-4111-8111-111111111111",
          path: "Guide.md",
          title: "Guide",
          contentHash: await published.contentHash("Hello\n"),
        },
        archive,
      ],
    };
    expect(await local.confirmationHash(confirmation)).toBe(
      await published.confirmationHash(confirmation),
    );

    const batch = {
      protocolVersion: "1" as const,
      batchIndex: 0,
      changes: [upsert, archive],
    };
    expect(await local.batchHash(batch)).toBe(await published.batchHash(batch));

    const revision = {
      protocolVersion: "1" as const,
      spaceId: "space",
      pages: [
        {
          pageId: "p1",
          path: "A.md",
          title: "A",
          contentHash: await published.contentHash("a"),
        },
      ],
    };
    expect(await local.revisionContentHash(revision)).toBe(
      await published.revisionContentHash(revision),
    );
  });

  it("produces identical portable path keys", () => {
    for (const input of [
      "Straße/İ.MD",
      "normal/path.md",
      "A.md",
      "café/naïve.md",
    ]) {
      expect(portablePathKey(input)).toBe(published.pathKey(input));
      expect(localValidatePortablePath(input).path).toBe(
        published.validatePortablePath(input).path,
      );
    }
  });

  it("parses decimal counts identically", () => {
    for (const value of ["0", "1", "9223372036854775807"]) {
      expect(local.parseDecimalCount(value)).toBe(
        published.parseDecimalCount(value),
      );
    }
    for (const invalid of ["", "01", "+1", "1.0", "9223372036854775808"]) {
      expect(() => local.parseDecimalCount(invalid)).toThrow();
      expect(() => published.parseDecimalCount(invalid)).toThrow();
    }
  });
});
