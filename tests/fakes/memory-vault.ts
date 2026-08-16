import type { VaultPort } from "../../src/ports/vault";

export class MemoryVault implements VaultPort {
  private readonly files = new Map<string, Uint8Array>();
  readonly trash = new Map<string, Uint8Array>();
  operations = 0;
  failAfterOperations: number | null = null;

  constructor(initial: Record<string, string>) {
    for (const [path, body] of Object.entries(initial))
      this.files.set(path, new TextEncoder().encode(body));
  }
  async rootStatus(rootPath: string): Promise<"folder" | "missing" | "file"> {
    if (this.files.has(rootPath)) return "file";
    const prefix = rootPath ? `${rootPath}/` : "";
    return rootPath === "" ||
      [...this.files.keys()].some((path) => path.startsWith(prefix))
      ? "folder"
      : "missing";
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
    const value = this.files.get(from);
    if (!value || this.files.has(to)) throw new Error("rename conflict");
    this.files.delete(from);
    this.files.set(to, value);
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
