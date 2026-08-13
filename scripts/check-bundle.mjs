import { readFile } from "node:fs/promises";

const source = await readFile("main.js", "utf8");
const forbidden = ["node:fs", "child_process", "FileSystemAdapter", "BEGIN PRIVATE KEY"];
for (const token of forbidden) if (source.includes(token)) throw new Error(`Forbidden runtime token in main.js: ${token}`);
if (source.length > 2_000_000) throw new Error(`main.js exceeds 2 MB (${source.length})`);
console.log(`Bundle safety check passed (${source.length} bytes)`);
