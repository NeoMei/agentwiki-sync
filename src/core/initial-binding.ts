import { pathKey } from "@neomei/agentwiki-sync-protocol";

import type { ScannedFile } from "./model";
import { titleFromPath } from "./portable-path";
import type { LocalTreeScanV3 } from "./tree-scan";
import { validateTreeContentV3, type TreeContentV3 } from "./tree-validation";
import {
  validateTreeIdentityState,
  type TreeIdentityStateV2,
} from "../storage/tree-identities";

export interface RemoteBindingPage {
  pageId: string;
  path: string;
  title: string;
  body: string;
  contentHash: string;
}

export interface ExplicitBindingChoice {
  localPath: string;
  remotePageId: string;
  finalPath: string;
  finalBody: string;
}

export interface BoundPage {
  pageId: string;
  relativePath: string;
  title: string;
  body: string;
  contentHash: string;
}

export function buildInitialBindingPreview(
  local: ScannedFile[],
  remote: RemoteBindingPage[],
  choices: ExplicitBindingChoice[] = [],
): { base: BoundPage[]; vault: BoundPage[]; dirty: string[] } {
  const localByPath = new Map(local.map((page) => [page.relativePath, page]));
  const choicesByRemote = new Map(
    choices.map((choice) => [choice.remotePageId, choice]),
  );
  const base = remote.map((page) => ({
    pageId: page.pageId,
    relativePath: page.path,
    title: page.title,
    body: page.body,
    contentHash: page.contentHash,
  }));
  const vault: BoundPage[] = [];
  const dirty: string[] = [];
  for (const remotePage of remote) {
    const choice = choicesByRemote.get(remotePage.pageId);
    const samePath = localByPath.get(remotePage.path);
    if (choice) {
      const localPage = localByPath.get(choice.localPath);
      if (!localPage)
        throw new TypeError("Explicit binding references a missing local page");
      vault.push({
        pageId: remotePage.pageId,
        relativePath: choice.finalPath,
        title: titleFromPath(choice.finalPath),
        body: choice.finalBody,
        contentHash: localPage.contentHash,
      });
      if (
        choice.finalPath !== remotePage.path ||
        choice.finalBody !== remotePage.body ||
        titleFromPath(choice.finalPath) !== remotePage.title
      )
        dirty.push(remotePage.pageId);
    } else if (samePath) {
      if (samePath.normalizedBody === undefined)
        throw new TypeError("Initial binding requires retained local bodies");
      vault.push({
        pageId: remotePage.pageId,
        relativePath: samePath.relativePath,
        title: samePath.title,
        body: samePath.normalizedBody,
        contentHash: samePath.contentHash,
      });
      if (
        samePath.contentHash !== remotePage.contentHash ||
        samePath.title !== remotePage.title
      )
        dirty.push(remotePage.pageId);
    } else {
      vault.push({
        pageId: remotePage.pageId,
        relativePath: remotePage.path,
        title: remotePage.title,
        body: remotePage.body,
        contentHash: remotePage.contentHash,
      });
    }
  }
  return { base, vault, dirty };
}

export interface InitialTreeBindingRequirement {
  kind: "folder" | "page";
  path: string;
  localId: string;
  remoteId: string;
}

export interface ExplicitInitialTreeBinding {
  kind: "folder" | "page";
  localId: string;
  remoteId: string;
}

export interface ResolvedInitialTreeBindings {
  local: LocalTreeScanV3;
  identities: TreeIdentityStateV2;
  evidence: {
    originalLocal: LocalTreeScanV3;
    choices: ExplicitInitialTreeBinding[];
  };
}

export function initialTreeBindingRequirements(
  local: LocalTreeScanV3,
  remote: TreeContentV3,
): InitialTreeBindingRequirement[] {
  const localFolders = new Map(
    local.folders.map((item) => [pathKey(item.path), item]),
  );
  const localPages = new Map(
    local.pages.map((item) => [pathKey(item.path), item]),
  );
  return [
    ...remote.folders.flatMap((item) => {
      const samePath = localFolders.get(pathKey(item.path));
      return samePath && samePath.folderId !== item.folderId
        ? [
            {
              kind: "folder" as const,
              path: item.path,
              localId: samePath.folderId,
              remoteId: item.folderId,
            },
          ]
        : [];
    }),
    ...remote.pages.flatMap((item) => {
      const samePath = localPages.get(pathKey(item.path));
      return samePath && samePath.pageId !== item.pageId
        ? [
            {
              kind: "page" as const,
              path: item.path,
              localId: samePath.pageId,
              remoteId: item.pageId,
            },
          ]
        : [];
    }),
  ].sort((left, right) =>
    `${left.kind}:${pathKey(left.path)}`.localeCompare(
      `${right.kind}:${pathKey(right.path)}`,
    ),
  );
}

function bindingKey(choice: ExplicitInitialTreeBinding): string {
  return `${choice.kind}:${choice.localId}:${choice.remoteId}`;
}

export function resolveExplicitInitialTreeBindings(
  inputLocal: LocalTreeScanV3,
  inputRemote: TreeContentV3,
  inputIdentities: TreeIdentityStateV2,
  inputChoices: ExplicitInitialTreeBinding[],
): ResolvedInitialTreeBindings {
  const local = structuredClone(inputLocal);
  const remote = validateTreeContentV3(structuredClone(inputRemote));
  const identities = structuredClone(inputIdentities);
  validateTreeIdentityState(identities);
  const requirements = initialTreeBindingRequirements(local, remote);
  const requiredKeys = new Set(requirements.map(bindingKey));
  const choices = structuredClone(inputChoices);
  const choiceKeys = choices.map(bindingKey);
  if (
    new Set(choiceKeys).size !== choiceKeys.length ||
    choiceKeys.length !== requiredKeys.size ||
    choiceKeys.some((key) => !requiredKeys.has(key))
  )
    throw new Error("INITIAL_BINDING_DECISION_REQUIRED");

  const folderIds = new Map(
    choices
      .filter((choice) => choice.kind === "folder")
      .map((choice) => [choice.localId, choice.remoteId]),
  );
  const pageIds = new Map(
    choices
      .filter((choice) => choice.kind === "page")
      .map((choice) => [choice.localId, choice.remoteId]),
  );
  local.folders = local.folders.map((folder) => ({
    ...folder,
    folderId: folderIds.get(folder.folderId) ?? folder.folderId,
    parentFolderId:
      folder.parentFolderId === null
        ? null
        : (folderIds.get(folder.parentFolderId) ?? folder.parentFolderId),
  }));
  local.pages = local.pages.map((page) => ({
    ...page,
    pageId: pageIds.get(page.pageId) ?? page.pageId,
    folderId:
      page.folderId === null
        ? null
        : (folderIds.get(page.folderId) ?? page.folderId),
  }));

  const remapIdentity = <T extends { folderId: string }>(
    records: Record<string, T>,
  ): Record<string, T> =>
    Object.fromEntries(
      Object.values(records).map((record) => {
        const folderId = folderIds.get(record.folderId) ?? record.folderId;
        return [folderId, { ...record, folderId }];
      }),
    );
  identities.folders = remapIdentity(identities.folders);
  identities.pendingFolders = remapIdentity(identities.pendingFolders);
  identities.pendingPages = Object.fromEntries(
    Object.values(identities.pendingPages).map((record) => {
      const pageId = pageIds.get(record.pageId) ?? record.pageId;
      return [pageId, { ...record, pageId }];
    }),
  );
  validateTreeIdentityState(identities);
  validateTreeContentV3({
    protocolVersion: "3",
    spaceId: remote.spaceId,
    folders: local.folders,
    pages: local.pages,
    attachments: local.attachments,
  });
  return {
    local,
    identities,
    evidence: { originalLocal: structuredClone(inputLocal), choices },
  };
}
