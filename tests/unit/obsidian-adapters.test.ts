import { describe, expect, it } from "vitest";
import type { App, DataAdapter, FileManager, Vault } from "obsidian";
import {
  ObsidianControlStore,
  ObsidianLocalControlStore,
  ObsidianSecrets,
  ObsidianVaultPort,
  RequestUrlHttp,
} from "../../src/obsidian/adapters";
import { TFile, TFolder, requestUrlState } from "../fakes/obsidian-mock";

class FakeDataAdapter {
  readonly files = new Map<string, string>();
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }
  async write(path: string, data: string): Promise<void> {
    this.files.set(path, data);
  }
  async mkdir(): Promise<void> {}
  async remove(path: string): Promise<void> {
    this.files.delete(path);
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
    return this.files.has(path) ? new TFile(path) : null;
  }
  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return new TFile(path);
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }
  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md"))
      .map((path) => new TFile(path));
  }
  async readBinary(file: TFile): Promise<ArrayBuffer> {
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
  async trashFile(file: TFile): Promise<void> {
    this.trashed.push(file.path);
    await this.vault.delete(file);
  }
}

const encoder = new TextEncoder();

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
});
