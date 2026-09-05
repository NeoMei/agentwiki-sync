import { describe, expect, it } from "vitest";

import { inspectImageMetadata } from "../../src/core/image-metadata";

export const PNG_2X3 = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0,
  0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0,
]);
export const JPEG_4X5 = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 4, 1, 1, 0x11, 0, 0xff, 0xd9,
]);
export const WEBP_6X7 = Uint8Array.from([
  82, 73, 70, 70, 22, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 88, 10, 0, 0, 0, 0,
  0, 0, 0, 5, 0, 0, 6, 0, 0,
]);
export const GIF_8X9 = Uint8Array.from([71, 73, 70, 56, 57, 97, 8, 0, 9, 0]);

const limits = {
  maxImageDimension: 10_000,
  maxDecodedPixels: 40_000_000,
  allowedMimeTypes: [
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ] as const,
};

describe("inspectImageMetadata", () => {
  it.each([
    [PNG_2X3, "image/png", 2, 3],
    [JPEG_4X5, "image/jpeg", 4, 5],
    [WEBP_6X7, "image/webp", 6, 7],
    [GIF_8X9, "image/gif", 8, 9],
  ] as const)(
    "reads authoritative magic and dimensions",
    (bytes, mimeType, width, height) => {
      expect(inspectImageMetadata(bytes, limits)).toEqual({
        mimeType,
        width,
        height,
      });
    },
  );

  it("rejects truncated and corrupt headers", () => {
    expect(() => inspectImageMetadata(PNG_2X3.slice(0, 20), limits)).toThrow(
      /ATTACHMENT_CONTENT_INVALID/,
    );
    expect(() =>
      inspectImageMetadata(Uint8Array.from([1, 2, 3, 4]), limits),
    ).toThrow(/ATTACHMENT_CONTENT_INVALID/);
  });

  it("requires JPEG marker framing and an exact SOF component payload", () => {
    const unframedSof = Uint8Array.from([
      0xff, 0xd8, 0xc0, 0, 11, 8, 0, 5, 0, 4, 1, 1, 0x11, 0, 0xff, 0xd9,
    ]);
    const wrongComponentLength = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0, 12, 8, 0, 5, 0, 4, 1, 1, 0x11, 0, 0, 0xff,
      0xd9,
    ]);
    const stuffedMarkerOutsideScan = Uint8Array.from([
      0xff, 0xd8, 0xff, 0, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 4, 1, 1, 0x11, 0,
      0xff, 0xd9,
    ]);

    expect(() => inspectImageMetadata(unframedSof, limits)).toThrow(
      /ATTACHMENT_CONTENT_INVALID/,
    );
    expect(() => inspectImageMetadata(wrongComponentLength, limits)).toThrow(
      /ATTACHMENT_CONTENT_INVALID/,
    );
    expect(() =>
      inspectImageMetadata(stuffedMarkerOutsideScan, limits),
    ).toThrow(/ATTACHMENT_CONTENT_INVALID/);
    expect(
      inspectImageMetadata(
        Uint8Array.from([
          0xff, 0xd8, 0xff, 0xff, 0x01, 0xff, 0xc0, 0, 11, 8, 0, 5, 0, 4, 1, 1,
          0x11, 0, 0xff, 0xd9,
        ]),
        limits,
      ),
    ).toMatchObject({ mimeType: "image/jpeg", width: 4, height: 5 });
  });

  it("enforces MIME, dimension and decoded-pixel limits", () => {
    expect(() =>
      inspectImageMetadata(PNG_2X3, {
        ...limits,
        allowedMimeTypes: ["image/jpeg"] as const,
      }),
    ).toThrow(/ATTACHMENT_CONTENT_INVALID/);
    expect(() =>
      inspectImageMetadata(PNG_2X3, { ...limits, maxImageDimension: 2 }),
    ).toThrow(/ATTACHMENT_QUOTA_EXCEEDED/);
    expect(() =>
      inspectImageMetadata(PNG_2X3, { ...limits, maxDecodedPixels: 5 }),
    ).toThrow(/ATTACHMENT_QUOTA_EXCEEDED/);
  });
});
