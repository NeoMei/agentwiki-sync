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
  schemaVersion: 1;
  folders: Record<string, TreeFolderIdentity>;
  pendingFolders: Record<string, TreeFolderIdentity>;
  pendingPages: Record<string, TreePendingPageIdentity>;
  attachments?: Record<string, TreeAttachmentIdentity>;
  pendingAttachments?: Record<string, TreePendingAttachmentIdentity>;
}

export function emptyTreeIdentityState(): TreeIdentityState {
  return {
    schemaVersion: 1,
    folders: {},
    pendingFolders: {},
    pendingPages: {},
  };
}

export function validateTreeIdentityState(input: unknown): TreeIdentityState {
  if (typeof input !== "object" || input === null)
    throw new TypeError("Invalid tree identity state");
  const state = input as Partial<TreeIdentityState>;
  if (state.schemaVersion !== 1)
    throw new TypeError("Unknown tree identity schema version");
  for (const record of [
    state.folders,
    state.pendingFolders,
    state.pendingPages,
  ]) {
    if (typeof record !== "object" || record === null || Array.isArray(record))
      throw new TypeError("Invalid tree identity record");
  }
  return state as TreeIdentityState;
}
