import { describe, expect, it } from "vitest";
import type { App, DataAdapter, FileManager, Vault } from "obsidian";
import {
  ObsidianControlStore,
  ObsidianLocalControlStore,
  ObsidianSecrets,
  ObsidianVaultPort,
  RequestUrlHttp,
} from "../../src/obsidian/adapters";
import { HttpResponseTooLargeError } from "../../src/ports/http";
import { TFile, TFolder, requestUrlState } from "../fakes/obsidian-mock";

class FakeDataAdapter {
  readonly files = new Map<string, string>();
  readonly binaryFiles = new Map<string, Uint8Array>();
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.binaryFiles.has(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.binaryFiles.get(path) ?? new Uint8Array();
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }
  async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.binaryFiles.set(path, new Uint8Array(data.slice(0)));
  }
  async mkdir(): Promise<void> {}
  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.binaryFiles.delete(path);
  }
  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from);
    if (value === undefined) throw new Error("missing source");
    this.files.set(to, value);
    this.files.delete(from);
  }
  async rmdir(path: string): Promise<void> {
    for (const key of [...this.files.keys()])
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.binaryFiles.keys()])
      if (key === path || key.startsWith(`${path}/`))
        this.binaryFiles.delete(key);
  }
}

class FakeLocalApp {
  readonly storage = new Map<string, string>();
  readonly secretStorage = {
    values: new Map<string, string>(),
    getSecret(id: string): string | null {
      return this.values.get(id) ?? null;
    },
    setSecret(id: string, value: string): void {
      this.values.set(id, value);
    },
  };
  loadLocalStorage(key: string): string | null {
    return this.storage.get(key) ?? null;
  }
  saveLocalStorage(key: string, value: string | null): void {
    if (value === null) this.storage.delete(key);
    else this.storage.set(key, value);
  }
}

class FakeVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly readPaths: string[] = [];
  constructor(initial: Record<string, string> = {}) {
    for (const [path, body] of Object.entries(initial)) {
      this.files.set(path, body);
      const segments = path.split("/");
      segments.pop();
      let parent = "";
      for (const segment of segments) {
        parent = parent ? `${parent}/${segment}` : segment;
        this.folders.add(parent);
      }
    }
  }
  getFileByPath(path: string): TFile | null {
    const body = this.files.get(path);
    return body === undefined
      ? null
      : new TFile(path, {
          size: new TextEncoder().encode(body).byteLength,
          mtime: Date.parse("2026-09-04T00:00:00.000Z"),
        });
  }
  private allFolders(): Set<string> {
    const result = new Set<string>(this.folders);
    for (const path of [...this.files.keys(), ...this.folders]) {
      const segments = path.split("/");
      segments.pop();
      let parent = "";
      for (const segment of segments) {
        parent = parent ? `${parent}/${segment}` : segment;
        result.add(parent);
      }
    }
    return result;
  }
  private folderNode(path: string, folders: Set<string>): TFolder {
    const prefix = path ? `${path}/` : "";
    const direct = (candidate: string): string | null => {
      if (!candidate.startsWith(prefix)) return null;
      const rest = candidate.slice(prefix.length);
      return rest && !rest.includes("/") ? rest : null;
    };
    const children: Array<TFile | TFolder> = [];
    for (const folder of folders) {
      if (folder !== path && direct(folder) !== null)
        children.push(this.folderNode(folder, folders));
    }
    for (const file of this.files.keys())
      if (direct(file) !== null) children.push(this.getFileByPath(file)!);
    return new TFolder(path, children);
  }
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return new TFile(path);
    const folders = this.allFolders();
    return folders.has(path) ? this.folderNode(path, folders) : null;
  }
  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md"))
      .map((path) => this.getFileByPath(path)!);
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
    this.readPaths.push(file.path);
    return new TextEncoder().encode(this.files.get(file.path) ?? "").buffer;
  }
  async createFolder(path: string): Promise<void> {
    this.folders.add(path);
  }
  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    this.files.set(file.path, new TextDecoder().decode(new Uint8Array(data)));
  }
  async createBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new TextDecoder().decode(new Uint8Array(data)));
  }
  async process(
    file: TFile,
    callback: (text: string) => string,
  ): Promise<void> {
    this.files.set(file.path, callback(this.files.get(file.path) ?? ""));
  }
  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
  }
  async rename(file: TFile, to: string): Promise<void> {
    const value = this.files.get(file.path);
    if (value === undefined) throw new Error("missing rename source");
    this.files.set(to, value);
    this.files.delete(file.path);
  }
}

class FakeFileManager {
  readonly trashed: string[] = [];
  constructor(private readonly vault: FakeVault) {}
  async trashFile(file: TFile | TFolder): Promise<void> {
    this.trashed.push(file.path);
    if (file instanceof TFolder) {
      const prefix = `${file.path}/`;
      for (const folder of [...this.vault.folders])
        if (folder === file.path || folder.startsWith(prefix))
          this.vault.folders.delete(folder);
      for (const path of [...this.vault.files.keys()])
        if (path.startsWith(prefix)) this.vault.files.delete(path);
      this.vault.folders.delete(file.path);
    } else {
      await this.vault.delete(file);
    }
  }
}

const encoder = new TextEncoder();

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) result.push(item);
  return result;
}

describe("ObsidianControlStore", () => {
  it("rejects paths that escape the .agentwiki control root", async () => {
    const adapter = new FakeDataAdapter();
    const store = new ObsidianControlStore(adapter as unknown as DataAdapter);
    await expect(store.read("../secret")).rejects.toThrow(/Unsafe/);
    await expect(store.write("plain.md", "x")).rejects.toThrow(/Unsafe/);
    await expect(store.remove("..\\.agentwiki/x")).rejects.toThrow(/Unsafe/);
  });

  it("reads, writes, renames, and removes only within the control root", async () => {
    const adapter = new FakeDataAdapter();
    const store = new ObsidianControlStore(adapter as unknown as DataAdapter);
    expect(await store.read(".agentwiki/a.json")).toBeNull();
    await store.write(".agentwiki/a.json", "one");
    expect(await store.read(".agentwiki/a.json")).toBe("one");
    await store.rename(".agentwiki/a.json", ".agentwiki/b.json");
    expect(await store.read(".agentwiki/b.json")).toBe("one");
    await store.remove(".agentwiki/b.json");
    expect(await store.read(".agentwiki/b.json")).toBeNull();
  });

  it("uses DataAdapter binary APIs for private control sidecars", async () => {
    const adapter = new FakeDataAdapter();
    const store = new ObsidianControlStore(adapter as unknown as DataAdapter);
    const bytes = new Uint8Array([0, 255, 1, 2]);
    await store.writeBinary(".agentwiki/private/blob.bin", bytes);
    expect(await store.readBinary(".agentwiki/private/blob.bin")).toEqual(
      bytes,
    );
    expect(adapter.files.has(".agentwiki/private/blob.bin")).toBe(false);
    await expect(store.readBinary("../outside.bin")).rejects.toThrow(/Unsafe/);
  });
});

describe("ObsidianLocalControlStore", () => {
  it("namespaces keys and treats null as deletion", async () => {
    const app = new FakeLocalApp();
    const store = new ObsidianLocalControlStore(app as unknown as App, "ns");
    expect(await store.read("device-id")).toBeNull();
    await store.write("device-id", "d1");
    expect(app.storage.get("ns:device-id")).toBe("d1");
    expect(await store.read("device-id")).toBe("d1");
    await store.remove("device-id");
    expect(await store.read("device-id")).toBeNull();
    expect(app.storage.has("ns:device-id")).toBe(false);
  });

  it("rename is read-then-write-then-delete", async () => {
    const app = new FakeLocalApp();
    const store = new ObsidianLocalControlStore(app as unknown as App);
    await store.write("a", "value");
    await store.rename("a", "b");
    expect(await store.read("a")).toBeNull();
    expect(await store.read("b")).toBe("value");
    await expect(store.rename("missing", "c")).rejects.toThrow(/缺失/);
  });
});

describe("ObsidianSecrets", () => {
  it("delegates to Obsidian secret storage", () => {
    const app = new FakeLocalApp();
    const secrets = new ObsidianSecrets(app as unknown as App);
    expect(secrets.get("id")).toBeNull();
    secrets.set("id", "secret");
    expect(secrets.get("id")).toBe("secret");
  });
});

describe("ObsidianVaultPort", () => {
  it("prevents reads and writes outside the mapping root", async () => {
    const vault = new FakeVault();
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    await expect(port.read("../Outside.md")).rejects.toThrow(/escapes/);
    await expect(port.write("Other.md", new Uint8Array([1]))).rejects.toThrow(
      /escapes/,
    );
  });

  it("classifies the mapping root", async () => {
    const vault = new FakeVault({ "Wiki/A.md": "a" });
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    expect(await port.rootStatus("Wiki")).toBe("folder");
    expect(await port.rootStatus("Wiki/A.md")).toBe("file");
    expect(await port.rootStatus("Missing")).toBe("missing");
  });

  it("compareAndSwap only replaces when current bytes match", async () => {
    const vault = new FakeVault({ "Wiki/A.md": "old" });
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    expect(
      await port.compareAndSwap(
        "Wiki/A.md",
        encoder.encode("old"),
        encoder.encode("new"),
      ),
    ).toBe(true);
    expect(vault.files.get("Wiki/A.md")).toBe("new");
    expect(
      await port.compareAndSwap(
        "Wiki/A.md",
        encoder.encode("stale"),
        encoder.encode("other"),
      ),
    ).toBe(false);
    expect(vault.files.get("Wiki/A.md")).toBe("new");
  });

  it("compareAndSwap creates only when expected is null and refuses otherwise", async () => {
    const vault = new FakeVault();
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    expect(
      await port.compareAndSwap("Wiki/New.md", null, encoder.encode("created")),
    ).toBe(true);
    expect(vault.files.get("Wiki/New.md")).toBe("created");
    expect(
      await port.compareAndSwap(
        "Wiki/Other.md",
        encoder.encode("expected"),
        encoder.encode("replacement"),
      ),
    ).toBe(false);
    expect(vault.files.has("Wiki/Other.md")).toBe(false);
  });

  it("trash uses the FileManager", async () => {
    const vault = new FakeVault({ "Wiki/A.md": "a" });
    const manager = new FakeFileManager(vault);
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      manager as unknown as FileManager,
      "Wiki",
    );
    await port.trashFile("Wiki/A.md");
    expect(manager.trashed).toEqual(["Wiki/A.md"]);
    expect(vault.files.has("Wiki/A.md")).toBe(false);
  });

  it("removes files through the FileManager to respect trash preferences", async () => {
    const vault = new FakeVault({ "Wiki/A.md": "a" });
    const manager = new FakeFileManager(vault);
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      manager as unknown as FileManager,
      "Wiki",
    );
    await port.remove("Wiki/A.md");
    expect(manager.trashed).toEqual(["Wiki/A.md"]);
    expect(vault.files.has("Wiki/A.md")).toBe(false);
  });

  it("enumerates empty directories and markdown files under the mapping root", async () => {
    const vault = new FakeVault();
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    vault.folders.add("Wiki/pages/Empty");
    vault.files.set("Wiki/pages/A.md", "a");
    expect(await collect(port.listTree("Wiki"))).toEqual([
      { kind: "directory", relativePath: "pages" },
      {
        kind: "markdown",
        relativePath: "pages/A.md",
        bytes: encoder.encode("a"),
      },
      { kind: "directory", relativePath: "pages/Empty" },
    ]);
  });

  it("does not read non-Markdown bytes while listing the tree", async () => {
    const vault = new FakeVault({
      "Wiki/pages/A.md": "a",
      "Wiki/assets/unreferenced.png": "not loaded",
      "Wiki/notes.md": "also not loaded",
    });
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );

    const entries = await collect(port.listTree("Wiki"));

    expect(vault.readPaths).toEqual(["Wiki/pages/A.md"]);
    expect(entries).toContainEqual({
      kind: "file",
      relativePath: "assets/unreferenced.png",
      byteLength: 10,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
  });

  it("skips .agentwiki directories and files anywhere under the root", async () => {
    const vault = new FakeVault({
      "Wiki/pages/.agentwiki/secret.md": "s",
      "Wiki/pages/Keep.md": "k",
    });
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    const entries = await collect(port.listTree("Wiki"));
    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "pages",
      "pages/Keep.md",
    ]);
  });

  it("trashes a directory through FileManager", async () => {
    const vault = new FakeVault({ "Wiki/pages/Empty/X.md": "x" });
    const manager = new FakeFileManager(vault);
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      manager as unknown as FileManager,
      "Wiki",
    );
    await port.trashDirectory("Wiki/pages/Empty");
    expect(manager.trashed).toEqual(["Wiki/pages/Empty"]);
  });

  it("classifies path status for files, directories, and missing paths", async () => {
    const vault = new FakeVault({ "Wiki/pages/A.md": "a" });
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    expect(await port.pathStatus("Wiki/pages")).toBe("directory");
    expect(await port.pathStatus("Wiki/pages/A.md")).toBe("file");
    expect(await port.pathStatus("Wiki/pages/Missing")).toBe("missing");
  });

  it("creates a directory and its parents", async () => {
    const vault = new FakeVault();
    const port = new ObsidianVaultPort(
      vault as unknown as Vault,
      {} as unknown as FileManager,
      "Wiki",
    );
    await port.createDirectory("Wiki/pages/New");
    expect(vault.folders.has("Wiki/pages/New")).toBe(true);
    expect(vault.folders.has("Wiki/pages")).toBe(true);
    expect(vault.folders.has("Wiki")).toBe(true);
  });
});

describe("RequestUrlHttp", () => {
  it("serializes JSON bodies and forwards canonical bodies as text", async () => {
    requestUrlState.impl = async () => ({
      status: 200,
      json: { ok: true },
      headers: { "x-test": "1" },
    });
    const http = new RequestUrlHttp();
    const jsonResponse = await http.request({
      method: "POST",
      url: "https://example.test/x",
      body: { a: 1 },
      headers: { Authorization: "Bearer s" },
    });
    expect(jsonResponse.status).toBe(200);
    expect(jsonResponse.json).toEqual({ ok: true });
    expect(jsonResponse.headers).toEqual({ "x-test": "1" });

    const canonicalResponse = await http.request({
      method: "PUT",
      url: "https://example.test/y",
      canonicalBody: encoder.encode('{"a":1}'),
    });
    expect(canonicalResponse.status).toBe(200);
  });

  it("sends raw binary bodies and never reads JSON for binary success", async () => {
    let request: unknown;
    const bytes = new Uint8Array([0, 255, 1]);
    requestUrlState.impl = async (input) => {
      request = input;
      return {
        status: 200,
        get json(): unknown {
          throw new Error("json must not be read");
        },
        text: "",
        arrayBuffer: bytes.buffer,
        headers: { "content-length": "3" },
      };
    };
    const response = await new RequestUrlHttp().request({
      method: "PUT",
      url: "https://example.test/blob",
      binaryBody: bytes,
      responseType: "binary",
      maxResponseBytes: 3,
    });
    expect(response.bytes).toEqual(bytes);
    expect((request as { body?: unknown }).body).toBeInstanceOf(ArrayBuffer);
  });

  it("bounds JSON from response text before parsing", async () => {
    requestUrlState.impl = async () => ({
      status: 200,
      json: { tiny: true },
      text: '{"oversized":"1234567890"}',
      arrayBuffer: new ArrayBuffer(0),
      headers: {},
    });
    await expect(
      new RequestUrlHttp().request({
        method: "GET",
        url: "https://example.test/json",
        responseType: "bounded-json",
        maxResponseBytes: 8,
      }),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });

  it("rejects declared binary overflow before exposing response bytes", async () => {
    requestUrlState.impl = async () => ({
      status: 200,
      json: undefined,
      text: "",
      arrayBuffer: new Uint8Array([1]).buffer,
      headers: { "content-length": "999" },
    });
    await expect(
      new RequestUrlHttp().request({
        method: "GET",
        url: "https://example.test/blob",
        responseType: "binary",
        maxResponseBytes: 10,
      }),
    ).rejects.toBeInstanceOf(HttpResponseTooLargeError);
  });
});
