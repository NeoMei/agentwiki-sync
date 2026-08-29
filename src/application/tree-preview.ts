import { pathKey } from "@neomei/agentwiki-sync-protocol";

import type {
  FolderConflict,
  FolderConflictResolution,
  PageMergePlan,
  StructuredConflict,
  TreePullAction,
} from "../core/merge";
import type { LocalTreeScan } from "../core/tree-scan";
import type { TreeSnapshot } from "../core/tree-model";
import type { ResolvedTree, TreePullPreview } from "./tree-diff";

export interface PreviewCandidate {
  base: TreeSnapshot;
  local: LocalTreeScan;
  remote: TreeSnapshot;
  resolved: ResolvedTree;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  pageConflicts: StructuredConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pagePlan: PageMergePlan;
}

function parentPathOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  if (slash < 0) return null;
  const parent = path.slice(0, slash);
  return parent === "pages" ? null : parent;
}

function pathDepth(path: string): number {
  return path.split("/").length;
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

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePathKeys(left: string, right: string): number {
  const leftKey = pathKey(left);
  const rightKey = pathKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function compareTrashPages(
  left: TreePullAction,
  right: TreePullAction,
): number {
  const keyDelta = comparePathKeys(left.path, right.path);
  if (keyDelta !== 0) return keyDelta;
  return compareIds(actionId(left), actionId(right));
}

function compareTrashDirectories(
  left: TreePullAction,
  right: TreePullAction,
): number {
  const depthDelta = pathDepth(left.path) - pathDepth(right.path);
  if (depthDelta !== 0) return -depthDelta;
  const keyDelta = comparePathKeys(left.path, right.path);
  if (keyDelta !== 0) return keyDelta;
  return compareIds(actionId(left), actionId(right));
}

function orderDirectoryUpserts(actions: TreePullAction[]): TreePullAction[] {
  const byTarget = new Map<string, TreePullAction>();
  for (const action of actions) byTarget.set(pathKey(action.path), action);

  const visited = new Set<TreePullAction>();
  const visiting = new Set<TreePullAction>();
  const ordered: TreePullAction[] = [];

  const visit = (action: TreePullAction): void => {
    if (visited.has(action) || visiting.has(action)) return;
    visiting.add(action);

    const parent = parentPathOf(action.path);
    if (parent !== null) {
      const creator = byTarget.get(pathKey(parent));
      if (creator && creator !== action) visit(creator);
    }

    if (action.kind === "create_directory") {
      const vacator = actions.find(
        (item) =>
          item.kind === "move_directory" &&
          pathKey(item.fromPath) === pathKey(action.path),
      );
      if (vacator && vacator !== action) visit(vacator);
    }

    visiting.delete(action);
    visited.add(action);
    ordered.push(action);
  };

  const sorted = [...actions].sort((left, right) =>
    comparePathKeys(left.path, right.path),
  );
  for (const action of sorted) visit(action);
  return ordered;
}

function pageRank(action: TreePullAction): number {
  switch (action.kind) {
    case "move_page":
      return 0;
    case "write_page":
      return 1;
    case "create_page":
      return 2;
    default:
      return 3;
  }
}

function comparePageUpserts(
  left: TreePullAction,
  right: TreePullAction,
): number {
  const rankDelta = pageRank(left) - pageRank(right);
  if (rankDelta !== 0) return rankDelta;
  const depthDelta = pathDepth(left.path) - pathDepth(right.path);
  if (depthDelta !== 0) return depthDelta;
  const keyDelta = comparePathKeys(left.path, right.path);
  if (keyDelta !== 0) return keyDelta;
  return compareIds(actionId(left), actionId(right));
}

export function sortTreePullActions(
  actions: TreePullAction[],
): TreePullAction[] {
  const trashPages = actions.filter((action) => action.kind === "trash_page");
  const trashDirectories = actions.filter(
    (action) => action.kind === "trash_directory",
  );
  const directoryUpserts = actions.filter(
    (action) =>
      action.kind === "create_directory" || action.kind === "move_directory",
  );
  const pageUpserts = actions.filter(
    (action) =>
      action.kind === "move_page" ||
      action.kind === "write_page" ||
      action.kind === "create_page",
  );

  trashPages.sort(compareTrashPages);
  trashDirectories.sort(compareTrashDirectories);
  pageUpserts.sort(comparePageUpserts);

  return [
    ...trashPages,
    ...trashDirectories,
    ...orderDirectoryUpserts(directoryUpserts),
    ...pageUpserts,
  ];
}

export function orderPreviewActions(
  candidate: PreviewCandidate,
): TreePullPreview {
  return {
    revision: candidate.remote.revision,
    actions: sortTreePullActions(candidate.actions),
    folderConflicts: candidate.folderConflicts,
    folderConflictResolutions: candidate.folderConflictResolutions,
    pageConflicts: candidate.pageConflicts,
    base: candidate.base,
    local: candidate.local,
    remote: candidate.remote,
    pagePlan: candidate.pagePlan,
    resolvedFolders: candidate.resolved.folders,
    resolvedPages: candidate.resolved.pages,
  };
}
