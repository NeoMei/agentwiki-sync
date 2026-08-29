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
import type { PageConflictResolution } from "./tree-diff";

export interface PreviewCandidate {
  base: TreeSnapshot;
  local: LocalTreeScan;
  remote: TreeSnapshot;
  resolved: ResolvedTree;
  actions: TreePullAction[];
  folderConflicts: FolderConflict[];
  pageConflicts: StructuredConflict[];
  folderConflictResolutions: Record<string, FolderConflictResolution>;
  pageConflictResolutions: Record<string, PageConflictResolution>;
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

function seedRank(action: TreePullAction): number {
  switch (action.kind) {
    case "trash_page":
      return 0;
    case "trash_directory":
      return 1;
    case "create_directory":
    case "move_directory":
      return 2;
    case "move_page":
      return 3;
    case "write_page":
      return 4;
    case "create_page":
      return 5;
  }
}

function compareSeed(left: TreePullAction, right: TreePullAction): number {
  const leftRank = seedRank(left);
  const rightRank = seedRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (left.kind === "trash_page" && right.kind === "trash_page")
    return compareTrashPages(left, right);
  if (left.kind === "trash_directory" && right.kind === "trash_directory")
    return compareTrashDirectories(left, right);
  if (
    (left.kind === "move_page" ||
      left.kind === "write_page" ||
      left.kind === "create_page") &&
    (right.kind === "move_page" ||
      right.kind === "write_page" ||
      right.kind === "create_page")
  )
    return comparePageUpserts(left, right);
  return comparePathKeys(left.path, right.path);
}

function dependenciesOf(
  action: TreePullAction,
  actions: TreePullAction[],
  byTarget: Map<string, TreePullAction>,
  trashDirectories: TreePullAction[],
): TreePullAction[] {
  const dependencies: TreePullAction[] = [];
  switch (action.kind) {
    case "trash_directory": {
      for (const other of trashDirectories) {
        if (
          other !== action &&
          isInsideSubtree(other.path, action.path) &&
          pathDepth(other.path) > pathDepth(action.path)
        )
          dependencies.push(other);
      }
      for (const other of actions) {
        if (
          (other.kind === "move_page" || other.kind === "move_directory") &&
          isInsideSubtree(other.fromPath, action.path)
        )
          dependencies.push(other);
      }
      break;
    }
    case "create_directory": {
      const parent = parentPathOf(action.path);
      if (parent !== null) {
        const creator = byTarget.get(pathKey(parent));
        if (creator && creator !== action) dependencies.push(creator);
      }
      const vacator = actions.find(
        (item) =>
          item.kind === "move_directory" &&
          pathKey(item.fromPath) === pathKey(action.path),
      );
      if (vacator && vacator !== action) dependencies.push(vacator);
      break;
    }
    case "move_directory": {
      const parent = parentPathOf(action.path);
      if (parent !== null) {
        const creator = byTarget.get(pathKey(parent));
        if (creator && creator !== action) dependencies.push(creator);
      }
      const vacated = trashDirectories.find(
        (item) => pathKey(item.path) === pathKey(action.path),
      );
      if (vacated) dependencies.push(vacated);
      // A move whose source sits under an ancestor move's source must run
      // after that ancestor move (the ancestor renames the subtree first).
      const ownBase = action.beforePath ?? action.fromPath;
      for (const other of actions) {
        if (other.kind !== "move_directory" || other === action) continue;
        const otherBase = other.beforePath ?? other.fromPath;
        if (
          isInsideSubtree(ownBase, otherBase) &&
          pathDepth(ownBase) > pathDepth(otherBase)
        )
          dependencies.push(other);
      }
      break;
    }
    case "move_page":
    case "create_page": {
      const parent = parentPathOf(action.path);
      if (parent !== null) {
        const creator = byTarget.get(pathKey(parent));
        if (creator && creator !== action) dependencies.push(creator);
      }
      break;
    }
    // trash_page and write_page have no ordering dependencies.
  }
  return dependencies;
}

function topologicalSort(actions: TreePullAction[]): TreePullAction[] {
  const byTarget = new Map<string, TreePullAction>();
  for (const action of actions)
    if (action.kind === "create_directory" || action.kind === "move_directory")
      byTarget.set(pathKey(action.path), action);
  const trashDirectories = actions.filter(
    (action) => action.kind === "trash_directory",
  );

  const dependencies = new Map<TreePullAction, TreePullAction[]>();
  for (const action of actions)
    dependencies.set(
      action,
      dependenciesOf(action, actions, byTarget, trashDirectories),
    );

  const visited = new Set<TreePullAction>();
  const visiting = new Set<TreePullAction>();
  const ordered: TreePullAction[] = [];
  const visit = (action: TreePullAction): void => {
    if (visited.has(action) || visiting.has(action)) return;
    visiting.add(action);
    for (const dependency of dependencies.get(action) ?? []) visit(dependency);
    visiting.delete(action);
    visited.add(action);
    ordered.push(action);
  };

  const sorted = [...actions].sort(compareSeed);
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

function isInsideSubtree(path: string, directory: string): boolean {
  const key = pathKey(path);
  const dir = pathKey(directory);
  return key === dir || key.startsWith(`${dir}/`);
}

export function sortTreePullActions(
  actions: TreePullAction[],
): TreePullAction[] {
  return topologicalSort(actions);
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
    pageConflictResolutions: candidate.pageConflictResolutions,
    base: candidate.base,
    local: candidate.local,
    remote: candidate.remote,
    pagePlan: candidate.pagePlan,
    resolvedFolders: candidate.resolved.folders,
    resolvedPages: candidate.resolved.pages,
  };
}
