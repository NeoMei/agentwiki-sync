export function normalizeMarkdown(text: string): string {
  if (text.startsWith("\ufeff"))
    throw new TypeError("Markdown must not begin with BOM");
  return text.replace(/\r\n?/g, "\n");
}

export function decodeVaultMarkdown(bytes: Uint8Array): {
  text: string;
  normalized: string;
} {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new TypeError("Markdown must not begin with UTF-8 BOM");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Markdown contains invalid UTF-8");
  }
  return { text, normalized: normalizeMarkdown(text) };
}
