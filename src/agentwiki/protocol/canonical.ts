const encoder = new TextEncoder();

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0) ?? 0);
  const b = Array.from(right, (char) => char.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return a.length - b.length;
}

function assertScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new TypeError("String contains an unpaired surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("String contains an unpaired surrogate");
    }
  }
}

function quote(value: string): string {
  assertScalarString(value);
  let result = '"';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '"') result += '\\"';
    else if (char === "\\") result += "\\\\";
    else if (char === "\b") result += "\\b";
    else if (char === "\t") result += "\\t";
    else if (char === "\n") result += "\\n";
    else if (char === "\f") result += "\\f";
    else if (char === "\r") result += "\\r";
    else if (code <= 0x1f) result += `\\u${code.toString(16).padStart(4, "0")}`;
    else result += char;
  }
  return `${result}"`;
}

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return quote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new TypeError("Protocol numbers must be safe integers");
    return String(value);
  }
  if (typeof value === "undefined")
    throw new TypeError("Protocol values cannot contain undefined");
  if (typeof value !== "object")
    throw new TypeError(`Unsupported protocol value: ${typeof value}`);
  if (seen.has(value)) throw new TypeError("Protocol values cannot be cyclic");
  seen.add(value);
  try {
    if (Array.isArray(value))
      return `[${value.map((item) => serialize(item, seen)).join(",")}]`;
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort(compareCodePoints)
      .map((key) => `${quote(key)}:${serialize(object[key], seen)}`);
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

export function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(serialize(value, new Set()));
}

export function comparePushChanges<
  T extends { pageId: string; operation: string },
>(left: T, right: T): number {
  const leftPath =
    "path" in left
      ? String(left.path)
      : "previousPath" in left
        ? String(left.previousPath)
        : "";
  const rightPath =
    "path" in right
      ? String(right.path)
      : "previousPath" in right
        ? String(right.previousPath)
        : "";
  return (
    compareCodePoints(left.pageId, right.pageId) ||
    compareCodePoints(left.operation, right.operation) ||
    compareCodePoints(leftPath, rightPath)
  );
}
