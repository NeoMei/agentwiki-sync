export interface ControlStorePort {
  read(path: string): Promise<string | null>;
  write(path: string, value: string): Promise<void>;
  readBinary?(path: string): Promise<Uint8Array | null>;
  writeBinary?(path: string, value: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  removeTree?(path: string): Promise<void>;
  list?(path: string): Promise<{ files: string[]; folders: string[] }>;
}
