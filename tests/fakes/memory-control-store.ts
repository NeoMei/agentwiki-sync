import type { ControlStorePort } from "../../src/ports/control-store";

export class MemoryControlStore implements ControlStorePort {
  readonly files = new Map<string, string>();
  async read(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async write(path: string, value: string): Promise<void> {
    this.files.set(path, value);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("missing source");
    this.files.set(to, value);
    this.files.delete(from);
  }
  async removeTree(path: string): Promise<void> {
    for (const key of [...this.files.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
  }
}
