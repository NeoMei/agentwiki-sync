import type { AgentWikiSyncSettings } from "../../src/application/settings";
import {
  isConnectionState,
  type ConnectionState,
} from "../../src/application/connection-service";
import { ObsidianLocalControlStore } from "../../src/obsidian/adapters";
import type { PreviewModal } from "../../src/obsidian/preview-modal";
import { MutableControlRepository } from "../../src/storage/envelope";
import { DeviceStateRepository } from "../../src/storage/device-state";
import AgentWikiSyncPlugin from "../../src/main";
import { TFile, TFolder, type MockElement } from "./obsidian-mock";

export function memoryAdapter() {
  const files = new Map<string, string>();
  const binaryFiles = new Map<string, Uint8Array>();
  const folders = new Set<string>();
  const bytes = (path: string): Uint8Array | null => {
    const binary = binaryFiles.get(path);
    if (binary) return binary.slice();
    const text = files.get(path);
    return text === undefined ? null : new TextEncoder().encode(text);
  };
  const deriveParents = (path: string): void => {
    const parts = path.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      folders.add(current);
    }
  };
  const removeTree = (path: string): void => {
    const prefix = `${path}/`;
    for (const candidate of [...files.keys()])
      if (candidate === path || candidate.startsWith(prefix))
        files.delete(candidate);
    for (const candidate of [...binaryFiles.keys()])
      if (candidate === path || candidate.startsWith(prefix))
        binaryFiles.delete(candidate);
    for (const candidate of [...folders])
      if (candidate === path || candidate.startsWith(prefix))
        folders.delete(candidate);
  };
  const directChildren = (path: string): Array<TFile | TFolder> => {
    const prefix = path ? `${path}/` : "";
    const names = new Set<string>();
    for (const candidate of [
      ...files.keys(),
      ...binaryFiles.keys(),
      ...folders,
    ]) {
      if (!candidate.startsWith(prefix) || candidate === path) continue;
      names.add(candidate.slice(prefix.length).split("/")[0]!);
    }
    const children: Array<TFile | TFolder> = [];
    for (const name of [...names].sort()) {
      const child = prefix + name;
      if (folders.has(child))
        children.push(new TFolder(child, directChildren(child)));
      else {
        const value = bytes(child);
        if (value)
          children.push(new TFile(child, { size: value.byteLength, mtime: 1 }));
      }
    }
    return children;
  };
  const abstractFile = (path: string): TFile | TFolder | null => {
    const value = bytes(path);
    if (value) return new TFile(path, { size: value.byteLength, mtime: 1 });
    return folders.has(path) ? new TFolder(path, directChildren(path)) : null;
  };
  return {
    files,
    binaryFiles,
    folders,
    bytes,
    deriveParents,
    abstractFile,
    exists: async (path: string) =>
      files.has(path) || binaryFiles.has(path) || folders.has(path),
    read: async (path: string) => {
      const value = files.get(path);
      if (value === undefined) throw new Error(`missing ${path}`);
      return value;
    },
    write: async (path: string, value: string) => {
      files.set(path, value);
      binaryFiles.delete(path);
      deriveParents(path);
    },
    readBinary: async (path: string) => {
      const value = bytes(path);
      if (!value) throw new Error(`missing ${path}`);
      return value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      );
    },
    writeBinary: async (path: string, value: ArrayBuffer) => {
      binaryFiles.set(path, new Uint8Array(value).slice());
      files.delete(path);
      deriveParents(path);
    },
    remove: async (path: string) => {
      files.delete(path);
      binaryFiles.delete(path);
      folders.delete(path);
    },
    rename: async (from: string, to: string) => {
      const text = files.get(from);
      const binary = binaryFiles.get(from);
      if (text === undefined && binary === undefined)
        throw new Error(`missing ${from}`);
      if (text !== undefined) files.set(to, text);
      if (binary !== undefined) binaryFiles.set(to, binary);
      files.delete(from);
      binaryFiles.delete(from);
      deriveParents(to);
    },
    mkdir: async (path: string) => {
      folders.add(path);
    },
    rmdir: async (path: string) => removeTree(path),
    list: async (path: string) => {
      const prefix = path ? `${path}/` : "";
      const direct = (candidate: string): boolean =>
        candidate.startsWith(prefix) &&
        !candidate.slice(prefix.length).includes("/");
      return {
        files: [...new Set([...files.keys(), ...binaryFiles.keys()])].filter(
          direct,
        ),
        folders: [...folders].filter(direct),
      };
    },
  };
}

export async function makePlugin(input: {
  data: unknown;
  legacy?: AgentWikiSyncSettings | null;
  connection?: ConnectionState | null;
  vaultFiles?: Record<string, string | Uint8Array>;
}) {
  const local = new Map<string, unknown>();
  const adapter = memoryAdapter();
  for (const [path, value] of Object.entries(input.vaultFiles ?? {})) {
    if (typeof value === "string") adapter.files.set(path, value);
    else adapter.binaryFiles.set(path, value.slice());
    adapter.deriveParents(path);
  }
  const secretValues = new Map<string, string>();
  if (input.connection)
    secretValues.set(input.connection.credentialSecretId, "test-secret");
  const vaultEvents = new Map<string, Array<(...args: unknown[]) => void>>();
  const businessWrites: string[] = [];
  const removeVaultEntry = (path: string): void => {
    adapter.files.delete(path);
    adapter.binaryFiles.delete(path);
    adapter.folders.delete(path);
  };
  const app = {
    __pluginData: structuredClone(input.data),
    __savedData: [] as unknown[],
    loadLocalStorage: (key: string) => local.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => {
      if (value === null) local.delete(key);
      else local.set(key, value);
    },
    secretStorage: {
      getSecret: (id: string) => secretValues.get(id) ?? null,
      setSecret: (id: string, value: string) => secretValues.set(id, value),
    },
    vault: {
      adapter,
      getName: () => "Test Vault",
      on: (name: string, callback: (...args: unknown[]) => void) => {
        const listeners = vaultEvents.get(name) ?? [];
        listeners.push(callback);
        vaultEvents.set(name, listeners);
        return {};
      },
      getAbstractFileByPath: (path: string) => adapter.abstractFile(path),
      getFileByPath: (path: string) => {
        const value = adapter.abstractFile(path);
        return value instanceof TFile ? value : null;
      },
      getMarkdownFiles: () =>
        [...new Set([...adapter.files.keys(), ...adapter.binaryFiles.keys()])]
          .filter((path) => path.toLowerCase().endsWith(".md"))
          .map((path) => adapter.abstractFile(path))
          .filter((value): value is TFile => value instanceof TFile),
      readBinary: async (file: TFile) => {
        const value = adapter.bytes(file.path);
        if (!value) throw new Error(`missing ${file.path}`);
        return value.buffer.slice(
          value.byteOffset,
          value.byteOffset + value.byteLength,
        );
      },
      createFolder: async (path: string) => {
        businessWrites.push(`mkdir:${path}`);
        adapter.folders.add(path);
        adapter.deriveParents(path);
      },
      createBinary: async (path: string, value: ArrayBuffer) => {
        businessWrites.push(`write:${path}`);
        adapter.binaryFiles.set(path, new Uint8Array(value).slice());
        adapter.deriveParents(path);
      },
      modifyBinary: async (file: TFile, value: ArrayBuffer) => {
        businessWrites.push(`write:${file.path}`);
        adapter.binaryFiles.set(file.path, new Uint8Array(value).slice());
        adapter.files.delete(file.path);
      },
      process: async (file: TFile, transform: (value: string) => string) => {
        const current = new TextDecoder().decode(adapter.bytes(file.path)!);
        const next = transform(current);
        if (next !== current) businessWrites.push(`write:${file.path}`);
        adapter.files.set(file.path, next);
        adapter.binaryFiles.delete(file.path);
      },
      rename: async (entry: TFile | TFolder, to: string) => {
        businessWrites.push(`rename:${entry.path}->${to}`);
        const text = adapter.files.get(entry.path);
        const binary = adapter.binaryFiles.get(entry.path);
        if (text !== undefined) adapter.files.set(to, text);
        if (binary !== undefined) adapter.binaryFiles.set(to, binary);
        removeVaultEntry(entry.path);
        adapter.deriveParents(to);
      },
    },
    workspace: {
      getActiveFile: () => null,
      on: () => ({}),
    },
    fileManager: {
      trashFile: async (entry: TFile | TFolder) => {
        businessWrites.push(`trash:${entry.path}`);
        removeVaultEntry(entry.path);
      },
    },
  };
  const localStore = new ObsidianLocalControlStore(app as never);
  if (input.legacy) {
    await new MutableControlRepository(
      localStore,
      "device-settings.json",
      (value): value is AgentWikiSyncSettings =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: unknown }).schemaVersion === 1,
    ).write(input.legacy);
  }
  if (input.connection) {
    await new MutableControlRepository(
      localStore,
      "connection-state.json",
      isConnectionState,
    ).write(input.connection);
    await new DeviceStateRepository(localStore).getOrCreateDeviceId();
    await new MutableControlRepository(
      localStore,
      "agentwiki-sync-device-v1",
      (
        value,
      ): value is {
        schemaVersion: 1;
        deviceId: string;
        boundVaultId: string | null;
      } =>
        !!value &&
        typeof value === "object" &&
        (value as { schemaVersion?: unknown }).schemaVersion === 1,
    ).write({
      schemaVersion: 1,
      deviceId: input.connection.deviceId,
      boundVaultId: input.connection.vaultId,
    });
  }
  const plugin = new AgentWikiSyncPlugin(app as never, {
    id: "agentwiki-sync",
    name: "AgentWiki Sync",
    version: "0.2.12",
    minAppVersion: "1.11.5",
    description: "",
    author: "NeoMei",
  });
  return {
    plugin,
    app,
    local,
    adapter,
    businessWrites,
    secretValue: (id: string) => secretValues.get(id) ?? null,
    emitVault: (name: string, ...args: unknown[]) => {
      for (const listener of vaultEvents.get(name) ?? []) listener(...args);
    },
  };
}

export function modalButton(modal: PreviewModal, label: string): MockElement {
  return (modal.contentEl as unknown as MockElement).queryAll(
    (item) => item.tag === "button" && item.text === label,
  )[0]!;
}
