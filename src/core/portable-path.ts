import { caseFold } from "unicode-case-folding";

const encoder = new TextEncoder();
const invalidCharacters = /[\u0000-\u001f<>:"/\\|?*]/u;
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/iu;

export interface PortablePath {
  path: string;
  key: string;
}

export function portablePathKey(path: string): string {
  return path
    .split("/")
    .map((part) => caseFold(part.normalize("NFC")))
    .join("/");
}

export function validatePortablePath(input: string): PortablePath {
  if (input.length === 0 || input.startsWith("/") || input.includes("\\"))
    throw new TypeError("Path must be relative and use slash separators");
  const parts = input.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === ".."))
    throw new TypeError("Path contains an empty or relative segment");
  const normalized = parts.map((part) => part.normalize("NFC"));
  for (const part of normalized) {
    if (invalidCharacters.test(part))
      throw new TypeError("Path contains a forbidden character");
    if (/[ .]$/u.test(part))
      throw new TypeError("Path segment has a forbidden trailing character");
    if (encoder.encode(part).byteLength > 255)
      throw new RangeError("Path segment is longer than 255 UTF-8 bytes");
    const basename = part.split(".", 1)[0] ?? "";
    if (reserved.test(basename))
      throw new TypeError("Path uses a reserved Windows device name");
  }
  const path = normalized.join("/");
  if (encoder.encode(path).byteLength > 1024)
    throw new RangeError("Path is longer than 1024 UTF-8 bytes");
  const final = normalized.at(-1) ?? "";
  const extension = final.slice(final.lastIndexOf(".") + 1);
  if (extension.toLowerCase() !== "md")
    throw new TypeError("Path must end with .md");
  const title = final.slice(0, final.lastIndexOf("."));
  validateTitle(title);
  return { path, key: portablePathKey(path) };
}

export function validateTitle(title: string): void {
  const length = Array.from(title).length;
  if (length < 1 || length > 500 || /[\u0000-\u001f]/u.test(title))
    throw new TypeError("Invalid Markdown title");
}

export function validatePortableDirectory(input: string): PortablePath {
  if (!input || input.startsWith("/") || input.includes("\\"))
    throw new TypeError("Directory must be relative and use slash separators");
  const normalized = input.split("/").map((part) => part.normalize("NFC"));
  for (const part of normalized) {
    if (!part || part === "." || part === "..")
      throw new TypeError("Path contains an empty or relative segment");
    if (invalidCharacters.test(part) || /[ .]$/u.test(part))
      throw new TypeError("Directory contains a forbidden character");
    if (encoder.encode(part).byteLength > 255)
      throw new RangeError("Path segment is longer than 255 UTF-8 bytes");
    if (reserved.test(part.split(".", 1)[0] ?? ""))
      throw new TypeError("Path uses a reserved Windows device name");
  }
  const path = normalized.join("/");
  if (encoder.encode(path).byteLength > 1024)
    throw new RangeError("Path is longer than 1024 UTF-8 bytes");
  return { path, key: portablePathKey(path) };
}

export function titleFromPath(path: string): string {
  const validated = validatePortablePath(path).path;
  const name = validated.slice(validated.lastIndexOf("/") + 1);
  return name.slice(0, name.lastIndexOf("."));
}
