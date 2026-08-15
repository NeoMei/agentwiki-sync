import {
  normalizePath,
  requestUrl,
  TFile,
  TFolder,
  type App,
  type DataAdapter,
  type FileManager,
  type Vault,
} from "obsidian";
import type { ControlStorePort } from "../ports/control-store";
import type { HttpPort, HttpResponse } from "../ports/http";
import type { SecretPort } from "../ports/secrets";
import type { VaultPort } from "../ports/vault";

function safeControlPath(path: string): string {
  const normalized = normalizePath(path);
  if (
    !normalized.startsWith(".agentwiki/") ||
    normalized.includes("..") ||
    normalized.includes("\\")
  )
    throw new TypeError("Unsafe control path");
  return normalized;
}

export class ObsidianControlStore implements ControlStorePort {
  constructor(private readonly adapter: DataAdapter) {}
  private async ensureParents(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.adapter.exists(current)))
        await this.adapter.mkdir(current);
    }
  }
  async read(path: string): Promise<string | null> {
    const safe = safeControlPath(path);
    return (await this.adapter.exists(safe)) ? this.adapter.read(safe) : null;
  }
  async write(path: string, value: string): Promise<void> {
    const safe = safeControlPath(path);
    await this.ensureParents(safe);
    await this.adapter.write(safe, value);
  }
  async remove(path: string): Promise<void> {
    const safe = safeControlPath(path);
    if (await this.adapter.exists(safe)) await this.adapter.remove(safe);
  }
  async rename(from: string, to: string): Promise<void> {
    await this.adapter.rename(safeControlPath(from), safeControlPath(to));
  }
  async removeTree(path: string): Promise<void> {
    const safe = safeControlPath(path);
    if (await this.adapter.exists(safe)) await this.adapter.rmdir(safe, true);
  }
}

export class ObsidianLocalControlStore implements ControlStorePort {
  constructor(
    private readonly app: App,
    private readonly namespace = "agentwiki-sync",
  ) {}
  private key(path: string): string {
    return `${this.namespace}:${path}`;
  }
  async read(path: string): Promise<string | null> {
    const value = this.app.loadLocalStorage(this.key(path));
    return typeof value === "string" ? value : null;
  }
  async write(path: string, value: string): Promise<void> {
    this.app.saveLocalStorage(this.key(path), value);
  }
  async remove(path: string): Promise<void> {
    this.app.saveLocalStorage(this.key(path), null);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = await this.read(from);
    if (value === null) throw new Error("本地控制源缺失");
    await this.write(to, value);
    await this.remove(from);
  }
}

export class ObsidianSecrets implements SecretPort {
  constructor(private readonly app: App) {}
  get(id: string): string | null {
    return this.app.secretStorage.getSecret(id);
  }
  set(id: string, value: string): void {
    this.app.secretStorage.setSecret(id, value);
  }
}

export class RequestUrlHttp implements HttpPort {
  async request(input: {
    method: string;
    url: string;
    body?: unknown;
    canonicalBody?: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpResponse> {
    const response = await requestUrl({
      url: input.url,
      method: input.method,
      body:
        input.canonicalBody === undefined
          ? input.body === undefined
            ? undefined
            : JSON.stringify(input.body)
          : new TextDecoder().decode(input.canonicalBody),
      headers: input.headers,
      throw: false,
    });
    return {
      status: response.status,
      json: response.json,
      headers: response.headers,
    };
  }
}

export class ObsidianVaultPort implements VaultPort {
  private readonly root: string;
  constructor(
    private readonly vault: Vault,
    private readonly fileManager: FileManager,
    rootPath: string,
  ) {
    this.root = normalizePath(rootPath);
  }
  private safe(path: string): string {
    const normalized = normalizePath(path);
    if (normalized !== this.root && !normalized.startsWith(`${this.root}/`))
      throw new TypeError("Vault target escapes the mapping root");
    return normalized;
  }
  private file(path: string): TFile | null {
    return this.vault.getFileByPath(this.safe(path));
  }
  async rootStatus(rootPath: string): Promise<"folder" | "missing" | "file"> {
    const value = this.vault.getAbstractFileByPath(normalizePath(rootPath));
    return value instanceof TFolder
      ? "folder"
      : value instanceof TFile
        ? "file"
        : "missing";
  }
  async *listMarkdown(
    rootPath: string,
  ): AsyncIterable<{ relativePath: string; bytes: Uint8Array }> {
    const root = normalizePath(rootPath);
    const prefix = root.length > 0 ? `${root}/` : "";
    const files = this.vault
      .getMarkdownFiles()
      .filter(
        (file) =>
          file.path.startsWith(prefix) && !file.path.startsWith(".agentwiki/"),
      );
    for (const file of files)
      yield {
        relativePath: file.path.slice(prefix.length),
        bytes: new Uint8Array(await this.vault.readBinary(file)),
      };
  }
  async read(path: string): Promise<Uint8Array | null> {
    const file = this.file(path);
    return file ? new Uint8Array(await this.vault.readBinary(file)) : null;
  }
  async ensureParentDirectories(path: string): Promise<void> {
    const safe = this.safe(path);
    const parts = safe.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const entry = this.vault.getAbstractFileByPath(current);
      if (entry instanceof TFile) throw new Error("父路径是文件");
      if (!entry) await this.vault.createFolder(current);
    }
  }
  async write(path: string, bytes: Uint8Array): Promise<void> {
    const file = this.file(path);
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    if (file) await this.vault.modifyBinary(file, data);
    else {
      await this.ensureParentDirectories(path);
      await this.vault.createBinary(this.safe(path), data);
    }
  }
  async compareAndSwap(
    path: string,
    expected: Uint8Array | null,
    replacement: Uint8Array,
  ): Promise<boolean> {
    const safe = this.safe(path);
    const file = this.vault.getFileByPath(safe);
    if (!file) {
      if (expected !== null) return false;
      await this.write(safe, replacement);
      return true;
    }
    if (expected === null) return false;
    let matched = false;
    const data = replacement.buffer.slice(
      replacement.byteOffset,
      replacement.byteOffset + replacement.byteLength,
    ) as ArrayBuffer;
    await this.vault.process(file, (current) => {
      const actual = new TextEncoder().encode(current);
      matched =
        actual.length === expected.length &&
        actual.every((value, index) => value === expected[index]);
      return matched ? new TextDecoder().decode(replacement) : current;
    });
    if (matched && replacement.byteLength === 0)
      await this.vault.modifyBinary(file, data);
    return matched;
  }
  async remove(path: string): Promise<void> {
    const file = this.file(path);
    if (file) await this.vault.delete(file);
  }
  async rename(from: string, to: string): Promise<void> {
    const file = this.file(from);
    if (!file) throw new Error("重命名源缺失");
    await this.ensureParentDirectories(to);
    await this.vault.rename(file, this.safe(to));
  }
  async trashFile(path: string): Promise<void> {
    const file = this.file(path);
    if (!file) throw new Error("删除源缺失");
    await this.fileManager.trashFile(file);
  }
}
