export interface VaultFile {
  relativePath: string;
  bytes: Uint8Array;
}

export interface ScannedFile {
  relativePath: string;
  title: string;
  normalizedBody?: string;
  contentHash: string;
  vaultByteHash: string;
}

export interface ManifestPage {
  pageId: string;
  relativePath: string;
  title: string;
  contentHash: string;
}

export interface ResolvedFile extends ScannedFile {
  pageId: string | null;
  identityStatus: "resolved" | "new" | "ambiguous";
}

export interface MoveHint {
  pageId: string;
  fromPath: string;
  toPath: string;
  observedVaultByteHash: string;
}

export interface ScanResult {
  complete: boolean;
  scanEpoch: number;
  files: ScannedFile[];
  bodyBytes: number;
  manifestBytes: number;
}

export interface LocalStatus {
  added: ResolvedFile[];
  modified: ResolvedFile[];
  renamed: ResolvedFile[];
  deleted: ManifestPage[];
  ambiguous: ResolvedFile[];
}
