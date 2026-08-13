import type { VaultPort } from "../../src/ports/vault";

export class MemoryVault implements VaultPort {
  private readonly files = new Map<string, Uint8Array>();
  readonly trash = new Map<string, Uint8Array>();
  operations = 0;
  failAfterOperations: number | null = null;

  constructor(initial: Record<string, string>) {
    for (const [path, body] of Object.entries(initial)) this.files.set(path, new TextEncoder().encode(body));
  }
  private fail(): void { this.operations += 1; if (this.failAfterOperations !== null && this.operations >= this.failAfterOperations) throw new Error("injected vault failure"); }
  exists(path: string): boolean { return this.files.has(path); }
  text(path: string): string | null { const value = this.files.get(path); return value ? new TextDecoder().decode(value) : null; }
  async read(path: string): Promise<Uint8Array | null> { return this.files.get(path)?.slice() ?? null; }
  async write(path: string, bytes: Uint8Array): Promise<void> { this.fail(); this.files.set(path, bytes.slice()); }
  async remove(path: string): Promise<void> { this.fail(); this.files.delete(path); }
  async rename(from: string, to: string): Promise<void> { this.fail(); const value = this.files.get(from); if (!value || this.files.has(to)) throw new Error("rename conflict"); this.files.delete(from); this.files.set(to, value); }
  async trashFile(path: string): Promise<void> { this.fail(); const value = this.files.get(path); if (!value) throw new Error("missing trash source"); this.trash.set(path, value); this.files.delete(path); }
}
