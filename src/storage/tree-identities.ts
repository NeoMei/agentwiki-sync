import {
  FlatAttachmentPathSchema,
  pathKey,
  validatePortableDirectoryPath,
  validatePortableMarkdownPath,
} from "@neomei/agentwiki-sync-protocol";

import { validatePublicId } from "../core/identity-key";

export interface TreeFolderIdentity {
  folderId: string;
  path: string;
  pathKey: string;
}

export interface TreePendingPageIdentity {
  pageId: string;
  path: string;
  contentHash: string;
}

/** Minimal in-memory v3 shape; strict durable schema arrives with v3 storage. */
export interface TreeAttachmentIdentity {
  attachmentId: string;
  path: string;
  pathKey: string;
  baseContentHash: string;
  active: boolean;
}

export interface TreePendingAttachmentIdentity {
  attachmentId: string;
  path: string;
  pathKey: string;
  contentHash: string;
}

export interface TreeIdentityState {
  schemaVersion: 1 | 2;
  folders: Record<string, TreeFolderIdentity>;
  pendingFolders: Record<string, TreeFolderIdentity>;
  pendingPages: Record<string, TreePendingPageIdentity>;
  attachments?: Record<string, TreeAttachmentIdentity>;
  pendingAttachments?: Record<string, TreePendingAttachmentIdentity>;
}

export interface TreeIdentityStateV2 extends TreeIdentityState {
  schemaVersion: 2;
  attachments: Record<string, TreeAttachmentIdentity>;
  pendingAttachments: Record<string, TreePendingAttachmentIdentity>;
}

const HASH = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function assertId(id: unknown, label: string): asserts id is string {
  if (typeof id !== "string") throw new TypeError(label);
  try {
    validatePublicId(id);
  } catch {
    throw new TypeError(label);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value))
    throw new TypeError(label);
}

function assertFolderRecords(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid tree identity record");
  const pathOwners = new Map<string, string>();
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["folderId", "path", "pathKey"]))
      throw new TypeError("Invalid tree folder identity");
    assertId(raw.folderId, "Invalid tree folder identity");
    if (id !== raw.folderId || typeof raw.path !== "string")
      throw new TypeError("Invalid tree folder identity");
    const normalized = validatePortableDirectoryPath(raw.path).path;
    if (raw.path !== normalized || raw.pathKey !== pathKey(normalized))
      throw new TypeError("Invalid tree folder identity");
    const owner = pathOwners.get(raw.pathKey);
    if (owner && owner !== id)
      throw new TypeError("Invalid tree folder identity");
    pathOwners.set(raw.pathKey, id);
  }
}

function assertPendingPages(value: unknown): void {
  if (!isRecord(value)) throw new TypeError("Invalid tree identity record");
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, ["pageId", "path", "contentHash"]))
      throw new TypeError("Invalid tree page identity");
    assertId(raw.pageId, "Invalid tree page identity");
    assertHash(raw.contentHash, "Invalid tree page identity");
    if (
      id !== raw.pageId ||
      typeof raw.path !== "string" ||
      validatePortableMarkdownPath(raw.path).path !== raw.path
    )
      throw new TypeError("Invalid tree page identity");
  }
}

function assertAttachmentRecords(value: unknown, pending: boolean): void {
  if (!isRecord(value)) throw new TypeError("Invalid tree identity record");
  const pathOwners = new Map<string, string>();
  for (const [id, raw] of Object.entries(value)) {
    const keys = pending
      ? ["attachmentId", "path", "pathKey", "contentHash"]
      : ["attachmentId", "path", "pathKey", "baseContentHash", "active"];
    if (!isRecord(raw) || !hasOnlyKeys(raw, keys))
      throw new TypeError("Invalid tree attachment identity");
    assertId(raw.attachmentId, "Invalid tree attachment identity");
    const parsed = FlatAttachmentPathSchema.safeParse(raw.path);
    const hash = pending ? raw.contentHash : raw.baseContentHash;
    assertHash(hash, "Invalid tree attachment identity");
    if (
      id !== raw.attachmentId ||
      !parsed.success ||
      parsed.data !== raw.path ||
      raw.pathKey !== pathKey(parsed.data) ||
      (!pending && typeof raw.active !== "boolean")
    )
      throw new TypeError("Invalid tree attachment identity");
    const owner = pathOwners.get(raw.pathKey);
    if (owner && owner !== id)
      throw new TypeError("Invalid tree attachment identity");
    pathOwners.set(raw.pathKey, id);
  }
}

export function emptyTreeIdentityState(): TreeIdentityState {
  return {
    schemaVersion: 1,
    folders: {},
    pendingFolders: {},
    pendingPages: {},
  };
}

export function emptyTreeIdentityStateV2(): TreeIdentityStateV2 {
  return {
    schemaVersion: 2,
    folders: {},
    pendingFolders: {},
    pendingPages: {},
    attachments: {},
    pendingAttachments: {},
  };
}

export function validateTreeIdentityState(input: unknown): TreeIdentityState {
  if (!isRecord(input)) throw new TypeError("Invalid tree identity state");
  if (input.schemaVersion !== 1 && input.schemaVersion !== 2)
    throw new TypeError("Unknown tree identity schema version");
  if (input.schemaVersion === 1) {
    for (const record of [
      input.folders,
      input.pendingFolders,
      input.pendingPages,
      ...(input.attachments === undefined ? [] : [input.attachments]),
      ...(input.pendingAttachments === undefined
        ? []
        : [input.pendingAttachments]),
    ])
      if (!isRecord(record))
        throw new TypeError("Invalid tree identity record");
    return input as unknown as TreeIdentityState;
  }
  if (
    !hasOnlyKeys(input, [
      "schemaVersion",
      "folders",
      "pendingFolders",
      "pendingPages",
      "attachments",
      "pendingAttachments",
    ])
  )
    throw new TypeError("Invalid tree identity state");
  assertFolderRecords(input.folders);
  assertFolderRecords(input.pendingFolders);
  assertPendingPages(input.pendingPages);
  assertAttachmentRecords(input.attachments, false);
  assertAttachmentRecords(input.pendingAttachments, true);
  return input as unknown as TreeIdentityState;
}

export function upgradeTreeIdentityState(input: unknown): TreeIdentityStateV2 {
  const state = validateTreeIdentityState(input);
  const upgraded: TreeIdentityStateV2 = {
    schemaVersion: 2,
    folders: { ...state.folders },
    pendingFolders: { ...state.pendingFolders },
    pendingPages: { ...state.pendingPages },
    attachments: { ...(state.attachments ?? {}) },
    pendingAttachments: { ...(state.pendingAttachments ?? {}) },
  };
  validateTreeIdentityState(upgraded);
  return upgraded;
}

export function detachAttachment(
  state: TreeIdentityStateV2,
  attachmentId: string,
): TreeIdentityStateV2 {
  const attachment = state.attachments[attachmentId];
  const attachments = { ...state.attachments };
  if (attachment) attachments[attachmentId] = { ...attachment, active: false };
  const pendingAttachments = { ...state.pendingAttachments };
  delete pendingAttachments[attachmentId];
  return { ...state, attachments, pendingAttachments };
}
