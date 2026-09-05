export interface TreeFolder {
  folderId: string;
  parentFolderId: string | null;
  name: string;
  path: string;
  sortOrder: number;
  updatedAt: string;
}

export interface TreePage {
  pageId: string;
  folderId: string | null;
  path: string;
  title: string;
  body: string;
  contentHash: string;
  updatedAt: string;
}

export interface TreePageV3 extends TreePage {
  referencedAttachmentIds: string[];
}

export interface TreeAttachment {
  attachmentId: string;
  path: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  sizeBytes: string;
  width: number;
  height: number;
  contentHash: string;
  updatedAt: string;
}

export interface TreeSnapshot {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  revisionContentHash: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

/** Scan-only v3 shape. Durable v3 generation persistence is introduced later. */
export interface TreeSnapshotV3 {
  protocolVersion: "3";
  spaceId: string;
  revision: string;
  revisionContentHash: string;
  folders: TreeFolder[];
  pages: TreePageV3[];
  attachments: TreeAttachment[];
}

export type TreeDeltaItem =
  | { operation: "upsert_folder"; folder: TreeFolder }
  | { operation: "archive_folder"; folderId: string; previousPath: string }
  | { operation: "upsert_page"; page: TreePage }
  | { operation: "archive_page"; pageId: string; previousPath: string };

export type TreePushChange = TreeDeltaItem;
