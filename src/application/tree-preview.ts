import { pathKey } from "@neomei/agentwiki-sync-protocol";

import type {
  FolderConflict,
  StructuredConflict,
  TreePullAction,
} from "../core/merge";
import type { LocalTreeScan } from "../core/tree-scan";
import type { TreeFolder, TreePage, TreeSnapshot } from "../core/tree-model";
import type { ResolvedTree, TreePullPreview } from "./tree-diff";

export interface PreviewCandidate {
  base: TreeSnapshot;
  local: LocalTreeScan;
  remote: TreeSnapshot;
  resolved: ResolvedTree;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  pageConflicts: StructuredConflict[];
}

function actionRank(action: TreePullAction): number {
  switch (action.kind) {
    case "trash_page":
      return 0;
    case "trash_directory":
      return 1;
    case "move_directory":
      return 2;
    case "create_directory":
      return 3;
    case "move_page":
      return 4;
    case "write_page":
      return 5;
    case "create_page":
      return 6;
  }
}

function actionId(action: TreePullAction): string {
  switch (action.kind) {
    case "create_directory":
    case "move_directory":
    case "trash_directory":
      return action.folderId;
    case "create_page":
    case "write_page":
    case "move_page":
    case "trash_page":
      return action.pageId;
  }
}

function actionPath(action: TreePullAction): string {
  return action.path;
}

function pathDepth(path: string): number {
  return path.split("/").length;
}

function compareActions(left: TreePullAction, right: TreePullAction): number {
  const rankDelta = actionRank(left) - actionRank(right);
  if (rankDelta !== 0) return rankDelta;

  if (left.kind === "trash_directory" && right.kind === "trash_directory") {
    const depthDelta = pathDepth(left.path) - pathDepth(right.path);
    if (depthDelta !== 0) return -depthDelta;
  }
  if (
    (left.kind === "move_directory" || left.kind === "create_directory") &&
    (right.kind === "move_directory" || right.kind === "create_directory")
  ) {
    const depthDelta = pathDepth(left.path) - pathDepth(right.path);
    if (depthDelta !== 0) return depthDelta;
  }

  const leftKey = pathKey(actionPath(left));
  const rightKey = pathKey(actionPath(right));
  if (leftKey < rightKey) return -1;
  if (leftKey > rightKey) return 1;

  const leftId = actionId(left);
  const rightId = actionId(right);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

export function orderPreviewActions(
  candidate: PreviewCandidate,
): TreePullPreview {
  const actions = [...candidate.actions].sort(compareActions);
  return {
    revision: candidate.remote.revision,
    actions,
    folderConflicts: candidate.folderConflicts,
    folderConflictResolutions: {},
    pageConflicts: candidate.pageConflicts,
    resolvedFolders: candidate.resolved.folders,
    resolvedPages: candidate.resolved.pages,
  };
}
