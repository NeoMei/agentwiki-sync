import type { VaultPort, VaultTreeEntry } from "../../src/ports/vault";

export class MemoryVault implements VaultPort {
  private readonly files = new Map<string, Uint8Array>();
  readonly folders = new Set<string>();
  readonly trash = new Map<string, Uint8Array>();
  readonly trashedDirectories = new Set<string>();
  operations = 0;
  failAfterOperations: number | null = null;
  private rootStatusOverride: "folder" | "missing" | "file" | null = null;

  constructor(initial: Record<string, string>) {
    for (const [path, body] of Object.entries(initial)) {
      this.files.set(path, new TextEncoder().encode(body));
      this.deriveParents(path);
    }
  }
  private deriveParents(path: string): void {
    const segments = path.split("/");
    segments.pop();
    let parent = "";
    for (const segment of segments) {
      parent = parent ? `${parent}/${segment}` : segment;
      this.folders.add(parent);
    }
  }
  setRootStatus(status: "folder" | "missing" | "file" | null): void {
    this.rootStatusOverride = status;
  }
  async rootStatus(rootPath: string): Promise<"folder" | "missing" | "file"> {
    if (this.rootStatusOverride) return this.rootStatusOverride;
    if (this.files.has(rootPath)) return "file";
    const prefix = rootPath ? `${rootPath}/` : "";
    if (
      rootPath === "" ||
      [...this.files.keys()].some((path) => path.startsWith(prefix))
    )
      return "folder";
    // Existing tests model a pre-created empty mapping directory unless they
    // explicitly override the status with setRootStatus().
    return "folder";
  }
  async *listMarkdown(
    rootPath: string,
  ): AsyncIterable<{ relativePath: string; bytes: Uint8Array }> {
    const prefix = rootPath.length > 0 ? `${rootPath}/` : "";
    for (const [path, bytes] of this.files)
      if (
        path.startsWith(prefix) &&
        path.toLowerCase().endsWith(".md") &&
        !path.startsWith(".agentwiki/")
      )
        yield { relativePath: path.slice(prefix.length), bytes: bytes.slice() };
  }
  async *listTree(rootPath: string): AsyncIterable<VaultTreeEntry> {
    const prefix = rootPath.length > 0 ? `${rootPath}/` : "";
    const entries: VaultTreeEntry[] = [];
    for (const dir of this.folders) {
      if (dir === rootPath) continue;
      if (!dir.startsWith(prefix)) continue;
      const relativePath = dir.slice(prefix.length);
      if (relativePath.split("/").includes(".agentwiki")) continue;
      entries.push({ kind: "directory", relativePath });
    }
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const relativePath = path.slice(prefix.length);
      if (relativePath.split("/").includes(".agentwiki")) continue;
      if (relativePath.toLowerCase().endsWith(".md"))
        entries.push({ kind: "markdown", relativePath, bytes: bytes.slice() });
      else entries.push({ kind: "file", relativePath, bytes: bytes.slice() });
    }
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    yield* entries;
  }
  async pathStatus(path: string): Promise<"directory" | "file" | "missing"> {
    if (this.files.has(path)) return "file";
    if (this.folders.has(path)) return "directory";
    return "missing";
  }
  async createDirectory(path: string): Promise<void> {
    this.fail();
    this.folders.add(path);
    this.deriveParents(path);
  }
  async trashDirectory(path: string): Promise<void> {
    this.fail();
    if (!this.folders.has(path)) throw new Error("missing directory source");
    const prefix = `${path}/`;
    for (const dir of [...this.folders])
      if (dir === path || dir.startsWith(prefix)) this.folders.delete(dir);
    for (const file of [...this.files.keys()])
      if (file.startsWith(prefix)) this.files.delete(file);
    this.trashedDirectories.add(path);
  }
  private fail(): void {
    this.operations += 1;
    if (
      this.failAfterOperations !== null &&
      this.operations >= this.failAfterOperations
    )
      throw new Error("injected vault failure");
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  hasUnexpectedTemporaryPaths(): boolean {
    const marker = ".agentwiki-tmp-";
    for (const key of [...this.files.keys(), ...this.folders])
      if (key.includes(marker)) return true;
    return false;
  }
  text(path: string): string | null {
    const value = this.files.get(path);
    return value ? new TextDecoder().decode(value) : null;
  }
  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null;
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    this.fail();
    this.files.set(path, bytes.slice());
  }
  async remove(path: string): Promise<void> {
    this.fail();
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    this.fail();
    if (this.folders.has(from)) {
      if (this.folders.has(to) || this.files.has(to))
        throw new Error("rename conflict");
      const prefix = `${from}/`;
      for (const dir of [...this.folders]) {
        if (dir === from || dir.startsWith(prefix)) {
          const relative = dir.slice(from.length);
          this.folders.delete(dir);
          this.folders.add(`${to}${relative}`);
        }
      }
      for (const file of [...this.files.keys()]) {
        if (file.startsWith(prefix)) {
          const value = this.files.get(file);
          if (value === undefined) continue;
          const relative = file.slice(from.length);
          this.files.delete(file);
          this.files.set(`${to}${relative}`, value);
        }
      }
      this.deriveParents(to);
      return;
    }
    const value = this.files.get(from);
    if (!value || this.files.has(to)) throw new Error("rename conflict");
    this.files.delete(from);
    this.files.set(to, value);
    this.deriveParents(to);
  }
  async trashFile(path: string): Promise<void> {
    this.fail();
    const value = this.files.get(path);
    if (!value) throw new Error("missing trash source");
    this.trash.set(path, value);
    this.files.delete(path);
  }
  async ensureParentDirectories(path: string): Promise<void> {
    void path;
  }
  async compareAndSwap(
    path: string,
    expected: Uint8Array | null,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const actual = this.files.get(path) ?? null;
    const equal =
      actual === null
        ? expected === null
        : expected !== null &&
          actual.length === expected.length &&
          actual.every((value, index) => value === expected[index]);
    if (!equal) return false;
    this.fail();
    this.files.set(path, replacement.slice());
    return true;
  }
}
