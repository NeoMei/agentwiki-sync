import { readFile } from "node:fs/promises";

const bytes = await readFile("main.js");
const source = bytes.toString("utf8");
const forbidden = [
  "node:fs",
  "child_process",
  "FileSystemAdapter",
  "BEGIN PRIVATE KEY",
];
for (const token of forbidden)
  if (source.includes(token))
    throw new Error(`Forbidden runtime token in main.js: ${token}`);
if (bytes.byteLength > 2_000_000)
  throw new Error(`main.js exceeds 2 MB (${bytes.byteLength} bytes)`);
console.log(`Bundle safety check passed (${bytes.byteLength} bytes)`);
