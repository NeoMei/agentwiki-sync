export type ImageMimeType =
  "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageMetadataLimits {
  maxImageDimension: number;
  maxDecodedPixels: number;
  allowedMimeTypes: readonly ImageMimeType[];
}

export interface ImageMetadata {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

function invalid(detail: string): never {
  throw new TypeError(`ATTACHMENT_CONTENT_INVALID: ${detail}`);
}

function quota(detail: string): never {
  throw new RangeError(`ATTACHMENT_QUOTA_EXCEEDED: ${detail}`);
}

function be16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function be32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function le16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function le24(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function png(bytes: Uint8Array): ImageMetadata | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (
    bytes.byteLength < 24 ||
    be32(bytes, 8) !== 13 ||
    ascii(bytes, 12, 4) !== "IHDR"
  )
    invalid("malformed PNG header");
  return {
    mimeType: "image/png",
    width: be32(bytes, 16),
    height: be32(bytes, 20),
  };
}

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpeg(bytes: Uint8Array): ImageMetadata | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) invalid("malformed JPEG marker framing");
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00) invalid("stuffed JPEG marker outside scan data");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd8) invalid("unexpected JPEG start marker");
    if (offset + 2 > bytes.byteLength) invalid("truncated JPEG segment");
    const length = be16(bytes, offset);
    if (length < 2 || offset + length > bytes.byteLength)
      invalid("malformed JPEG segment");
    if (JPEG_SOF_MARKERS.has(marker)) {
      const componentCount = bytes[offset + 7];
      if (
        componentCount === undefined ||
        componentCount < 1 ||
        length !== 8 + 3 * componentCount
      )
        invalid("malformed JPEG frame");
      return {
        mimeType: "image/jpeg",
        width: be16(bytes, offset + 5),
        height: be16(bytes, offset + 3),
      };
    }
    offset += length;
  }
  invalid("JPEG dimensions are missing");
}

function webp(bytes: Uint8Array): ImageMetadata | null {
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP")
    return null;
  if (bytes.byteLength < 20) invalid("truncated WebP header");
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X") {
    if (bytes.byteLength < 30) invalid("truncated WebP VP8X header");
    return {
      mimeType: "image/webp",
      width: le24(bytes, 24) + 1,
      height: le24(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8 ") {
    if (
      bytes.byteLength < 30 ||
      bytes[23] !== 0x9d ||
      bytes[24] !== 0x01 ||
      bytes[25] !== 0x2a
    )
      invalid("malformed WebP VP8 header");
    return {
      mimeType: "image/webp",
      width: le16(bytes, 26) & 0x3fff,
      height: le16(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L") {
    if (bytes.byteLength < 25 || bytes[20] !== 0x2f)
      invalid("malformed WebP VP8L header");
    const bits =
      bytes[21]! |
      (bytes[22]! << 8) |
      (bytes[23]! << 16) |
      (bytes[24]! * 0x1000000);
    return {
      mimeType: "image/webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >>> 14) & 0x3fff) + 1,
    };
  }
  invalid("unsupported WebP chunk");
}

function gif(bytes: Uint8Array): ImageMetadata | null {
  const signature = ascii(bytes, 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") return null;
  if (bytes.byteLength < 10) invalid("truncated GIF header");
  return {
    mimeType: "image/gif",
    width: le16(bytes, 6),
    height: le16(bytes, 8),
  };
}

export function inspectImageMetadata(
  bytes: Uint8Array,
  limits: ImageMetadataLimits,
): ImageMetadata {
  const metadata = png(bytes) ?? jpeg(bytes) ?? webp(bytes) ?? gif(bytes);
  if (metadata === null) invalid("unsupported image magic");
  if (!limits.allowedMimeTypes.includes(metadata.mimeType))
    invalid("image MIME type is not allowed");
  if (metadata.width < 1 || metadata.height < 1)
    invalid("image dimensions must be positive");
  if (
    metadata.width > limits.maxImageDimension ||
    metadata.height > limits.maxImageDimension
  )
    quota("image dimension limit");
  if (metadata.width * metadata.height > limits.maxDecodedPixels)
    quota("decoded pixel limit");
  return metadata;
}
