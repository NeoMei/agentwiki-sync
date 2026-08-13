import { normalizePath, requestUrl, type App, type DataAdapter, type FileManager, type TFile, type Vault } from "obsidian";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort, HttpResponse } from "../ports/http";
import type { SecretPort } from "../ports/secrets";
import type { VaultPort } from "../ports/vault";

function safeControlPath(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized.startsWith(".agentwiki/") || normalized.includes("..") || normalized.includes("\\")) throw new TypeError("Unsafe control path");
  return normalized;
}

export class ObsidianControlStore implements ControlStorePort {
  constructor(private readonly adapter: DataAdapter) {}
  private async ensureParents(path: string): Promise<void> { const parts = path.split("/"); parts.pop(); let current = ""; for (const part of parts) { current = current ? `${current}/${part}` : part; if (!await this.adapter.exists(current)) await this.adapter.mkdir(current); } }
  async read(path: string): Promise<string | null> { const safe = safeControlPath(path); return await this.adapter.exists(safe) ? this.adapter.read(safe) : null; }
  async write(path: string, value: string): Promise<void> { const safe = safeControlPath(path); await this.ensureParents(safe); await this.adapter.write(safe, value); }
  async remove(path: string): Promise<void> { const safe = safeControlPath(path); if (await this.adapter.exists(safe)) await this.adapter.remove(safe); }
  async rename(from: string, to: string): Promise<void> { await this.adapter.rename(safeControlPath(from), safeControlPath(to)); }
}

export class ObsidianLocalControlStore implements ControlStorePort {
  constructor(private readonly app: App, private readonly namespace = "agentwiki-sync") {}
  private key(path: string): string { return `${this.namespace}:${path}`; }
  async read(path: string): Promise<string | null> { const value = this.app.loadLocalStorage(this.key(path)); return typeof value === "string" ? value : null; }
  async write(path: string, value: string): Promise<void> { this.app.saveLocalStorage(this.key(path), value); }
  async remove(path: string): Promise<void> { this.app.saveLocalStorage(this.key(path), null); }
  async rename(from: string, to: string): Promise<void> { const value = await this.read(from); if (value === null) throw new Error("Missing local control source"); await this.write(to, value); await this.remove(from); }
}

export class ObsidianSecrets implements SecretPort {
  constructor(private readonly app: App) {}
  get(id: string): string | null { return this.app.secretStorage.getSecret(id); }
  set(id: string, value: string): void { this.app.secretStorage.setSecret(id, value); }
}

export class RequestUrlHttp implements HttpPort {
  async request(input: { method: string; url: string; body?: unknown; headers?: Record<string, string> }): Promise<HttpResponse> {
    const response = await requestUrl({ url: input.url, method: input.method, body: input.body === undefined ? undefined : JSON.stringify(input.body), headers: input.headers, throw: false });
    return { status: response.status, json: response.json, headers: response.headers };
  }
}

export class ObsidianVaultPort implements VaultPort {
  constructor(private readonly vault: Vault, private readonly fileManager: FileManager) {}
  private file(path: string): TFile | null { const value = this.vault.getFileByPath(normalizePath(path)); return value; }
  async listMarkdown(rootPath: string): Promise<Array<{ relativePath: string; bytes: Uint8Array }>> {
    const root = normalizePath(rootPath); const prefix = root.length > 0 ? `${root}/` : "";
    const files = this.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix) && !file.path.startsWith(".agentwiki/"));
    const result: Array<{ relativePath: string; bytes: Uint8Array }> = [];
    for (const file of files) result.push({ relativePath: file.path.slice(prefix.length), bytes: new Uint8Array(await this.vault.readBinary(file)) });
    return result;
  }
  async read(path: string): Promise<Uint8Array | null> { const file = this.file(path); return file ? new Uint8Array(await this.vault.readBinary(file)) : null; }
  async write(path: string, bytes: Uint8Array): Promise<void> { const file = this.file(path); const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer; if (file) await this.vault.modifyBinary(file, data); else await this.vault.createBinary(normalizePath(path), data); }
  async remove(path: string): Promise<void> { const file = this.file(path); if (file) await this.vault.delete(file); }
  async rename(from: string, to: string): Promise<void> { const file = this.file(from); if (!file) throw new Error("Missing rename source"); await this.vault.rename(file, normalizePath(to)); }
  async trashFile(path: string): Promise<void> { const file = this.file(path); if (!file) throw new Error("Missing trash source"); await this.fileManager.trashFile(file); }
}
