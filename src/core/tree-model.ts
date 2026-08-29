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

export interface TreeSnapshot {
  protocolVersion: "1" | "2";
  spaceId: string;
  revision: string;
  revisionContentHash: string;
  folders: TreeFolder[];
  pages: TreePage[];
}

export type TreeDeltaItem =
  | { operation: "upsert_folder"; folder: TreeFolder }
  | { operation: "archive_folder"; folderId: string; previousPath: string }
  | { operation: "upsert_page"; page: TreePage }
  | { operation: "archive_page"; pageId: string; previousPath: string };

export type TreePushChange = TreeDeltaItem;
