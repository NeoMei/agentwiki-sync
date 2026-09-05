export interface VaultTreeEntry {
  relativePath: string;
  kind: "directory" | "markdown" | "file";
  bytes?: Uint8Array;
  /** Available without loading file bytes. */
  byteLength?: number;
  updatedAt?: string;
}

export interface VaultPort {
  rootStatus(rootPath: string): Promise<"folder" | "missing" | "file">;
  listMarkdown(
    rootPath: string,
  ): AsyncIterable<{ relativePath: string; bytes: Uint8Array }>;
  listTree(rootPath: string): AsyncIterable<VaultTreeEntry>;
  pathStatus(path: string): Promise<"directory" | "file" | "missing">;
  createDirectory(path: string): Promise<void>;
  trashDirectory(path: string): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  trashFile(path: string): Promise<void>;
  ensureParentDirectories(path: string): Promise<void>;
  compareAndSwap(
    path: string,
    expected: Uint8Array | null,
    replacement: Uint8Array,
  ): Promise<boolean>;
}
