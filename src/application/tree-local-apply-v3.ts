import {
  pathKey,
  treeRevisionContentHashV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import type { TreePullAction, TreePullActionV3 } from "../core/merge";
import { scanLocalTree } from "../core/tree-scan";
import type {
  TreeAttachment,
  TreeFolder,
  TreePageV3,
} from "../core/tree-model";
import type { VaultPort } from "../ports/vault";
import type { MutableControlRepository } from "../storage/envelope";
import {
  upgradeTreeIdentityState,
  validateTreeIdentityState,
  type TreeIdentityState,
  type TreeIdentityStateV2,
  type TreeIdentityRepository,
} from "../storage/tree-identities";

export interface V3PullControlAfterState {
  schemaVersion: 2;
  transactionId: string;
  phase: "pending" | "applied";
  identities: TreeIdentityStateV2;
}

export const isV3PullControlAfterState = (
  value: unknown,
): value is V3PullControlAfterState => {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<V3PullControlAfterState>;
  if (
    state.schemaVersion !== 2 ||
    typeof state.transactionId !== "string" ||
    !["pending", "applied"].includes(state.phase ?? "")
  )
    return false;
  try {
    return validateTreeIdentityState(state.identities).schemaVersion === 2;
  } catch {
    return false;
  }
};

const joinRoot = (root: string, path: string) =>
  root ? `${root}/${path}` : path;

function prefixPageAction(
  action: TreePullAction,
  rootPath: string,
  controlRoot: string,
  bodyPath?: (pageId: string, prior: string) => string,
): TreePullAction {
  const prefix = rootPath ? `${rootPath}/` : "";
  const resultBody = (pageId: string, path: string) =>
    bodyPath?.(pageId, path) ?? `${controlRoot}/${path}`;
  switch (action.kind) {
    case "create_directory":
    case "trash_directory":
    case "trash_page":
      return { ...action, path: prefix + action.path };
    case "create_page":
      return {
        ...action,
        path: prefix + action.path,
        bodyPath: resultBody(action.pageId, action.bodyPath),
      };
    case "write_page":
      return {
        ...action,
        path: prefix + action.path,
        bodyPath: resultBody(action.pageId, action.bodyPath),
        ...(action.beforePath
          ? { beforePath: prefix + action.beforePath }
          : {}),
      };
    case "move_page":
      return {
        ...action,
        fromPath: prefix + action.fromPath,
        path: prefix + action.path,
        bodyPath: resultBody(action.pageId, action.bodyPath),
        ...(action.beforePath
          ? { beforePath: prefix + action.beforePath }
          : {}),
      };
    case "move_directory":
      return {
        ...action,
        fromPath: prefix + action.fromPath,
        path: prefix + action.path,
        ...(action.beforePath
          ? { beforePath: prefix + action.beforePath }
          : {}),
      };
  }
}

export function prefixTreePullActionV3(
  action: TreePullActionV3,
  rootPath: string,
  controlRoot: string,
  bodyPath?: (pageId: string, prior: string) => string,
): TreePullActionV3 {
  if (action.kind === "create_attachment" || action.kind === "write_attachment")
    return {
      ...action,
      attachment: {
        ...action.attachment,
        path: joinRoot(rootPath, action.attachment.path),
      },
    };
  if (action.kind === "remove_attachment_path")
    return { ...action, path: joinRoot(rootPath, action.path) };
  if (action.kind === "detach_attachment") return action;
  return prefixPageAction(action, rootPath, controlRoot, bodyPath);
}

export interface ResolvedTreeV3ForLocalApply {
  revision: string;
  base: { attachments: TreeAttachment[] };
  remote: { pages: TreePageV3[]; attachments: TreeAttachment[] };
  resolvedFolders: TreeFolder[];
  resolvedPages: TreePageV3[];
  resolvedAttachments: TreeAttachment[];
}

export function desiredV3Identities(
  currentInput: TreeIdentityState,
  preview: ResolvedTreeV3ForLocalApply,
): TreeIdentityStateV2 {
  const current = upgradeTreeIdentityState(currentInput);
  const remotePages = new Map(
    preview.remote.pages.map((page) => [page.pageId, page]),
  );
  const remoteAttachments = new Map(
    preview.remote.attachments.map((item) => [item.attachmentId, item]),
  );
  const attachments: TreeIdentityStateV2["attachments"] = {};
  const pendingAttachments: TreeIdentityStateV2["pendingAttachments"] = {};
  for (const attachment of preview.resolvedAttachments) {
    const remote = remoteAttachments.get(attachment.attachmentId);
    if (!remote) {
      pendingAttachments[attachment.attachmentId] = {
        attachmentId: attachment.attachmentId,
        path: attachment.path,
        pathKey: pathKey(attachment.path),
        contentHash: attachment.contentHash,
      };
    } else
      attachments[attachment.attachmentId] = {
        attachmentId: attachment.attachmentId,
        path: attachment.path,
        pathKey: pathKey(attachment.path),
        baseContentHash: remote.contentHash,
        active: true,
      };
  }
  for (const attachment of [
    ...Object.values(current.attachments),
    ...preview.base.attachments,
    ...preview.remote.attachments,
  ]) {
    if (
      attachments[attachment.attachmentId] ||
      pendingAttachments[attachment.attachmentId]
    )
      continue;
    attachments[attachment.attachmentId] = {
      attachmentId: attachment.attachmentId,
      path: attachment.path,
      pathKey: pathKey(attachment.path),
      baseContentHash:
        "baseContentHash" in attachment
          ? attachment.baseContentHash
          : attachment.contentHash,
      active: false,
    };
  }
  const pendingPages = Object.fromEntries(
    preview.resolvedPages
      .filter((page) => {
        const remote = remotePages.get(page.pageId);
        return (
          !remote ||
          remote.path !== page.path ||
          remote.contentHash !== page.contentHash
        );
      })
      .map((page) => [
        page.pageId,
        { pageId: page.pageId, path: page.path, contentHash: page.contentHash },
      ]),
  );
  return upgradeTreeIdentityState({
    schemaVersion: 2,
    folders: Object.fromEntries(
      preview.resolvedFolders.map((folder) => [
        folder.folderId,
        {
          folderId: folder.folderId,
          path: folder.path,
          pathKey: pathKey(folder.path),
        },
      ]),
    ),
    pendingFolders: {},
    pendingPages,
    attachments,
    pendingAttachments,
  });
}

export async function verifyResolvedV3Vault(input: {
  vault: VaultPort;
  rootPath: string;
  spaceId: string;
  preview: ResolvedTreeV3ForLocalApply;
  identities: TreeIdentityStateV2;
  capabilities: TreeSyncCapabilitiesV3;
}): Promise<void> {
  const { preview } = input;
  const actual = await scanLocalTree(
    input.vault,
    input.rootPath,
    {
      protocolVersion: "3",
      spaceId: input.spaceId,
      revision: preview.revision,
      revisionContentHash: await treeRevisionContentHashV3({
        protocolVersion: "3",
        spaceId: input.spaceId,
        folders: preview.resolvedFolders,
        pages: preview.resolvedPages,
        attachments: preview.resolvedAttachments,
      }),
      folders: preview.resolvedFolders,
      pages: preview.resolvedPages,
      attachments: preview.resolvedAttachments,
    },
    structuredClone(input.identities),
    {
      ...input.capabilities,
      maxFolders: input.capabilities.maxClientSpaceFolders,
      maxPages: input.capabilities.maxClientSpacePages,
    },
  );
  const folders = new Map(actual.folders.map((item) => [item.folderId, item]));
  const pages = new Map(actual.pages.map((item) => [item.pageId, item]));
  const attachments = new Map(
    actual.attachments.map((item) => [item.attachmentId, item]),
  );
  if (
    actual.blockers.length ||
    folders.size !== preview.resolvedFolders.length ||
    pages.size !== preview.resolvedPages.length ||
    attachments.size !== preview.resolvedAttachments.length
  )
    throw new Error("V3_VAULT_VERIFY_FAILED");
  for (const expected of preview.resolvedFolders) {
    const value = folders.get(expected.folderId);
    if (
      !value ||
      value.path !== expected.path ||
      value.parentFolderId !== expected.parentFolderId
    )
      throw new Error("V3_VAULT_VERIFY_FAILED");
  }
  for (const expected of preview.resolvedPages) {
    const value = pages.get(expected.pageId);
    if (
      !value ||
      value.path !== expected.path ||
      value.contentHash !== expected.contentHash ||
      JSON.stringify(value.referencedAttachmentIds) !==
        JSON.stringify(expected.referencedAttachmentIds)
    )
      throw new Error("V3_VAULT_VERIFY_FAILED");
  }
  for (const expected of preview.resolvedAttachments) {
    const value = attachments.get(expected.attachmentId);
    if (
      !value ||
      value.path !== expected.path ||
      value.contentHash !== expected.contentHash ||
      value.sizeBytes !== expected.sizeBytes ||
      value.mimeType !== expected.mimeType ||
      value.width !== expected.width ||
      value.height !== expected.height
    )
      throw new Error("V3_VAULT_VERIFY_FAILED");
  }
}

export async function applyV3ControlAfter(
  controlAfter: MutableControlRepository<V3PullControlAfterState>,
  identities: TreeIdentityRepository,
  transactionId: string,
): Promise<void> {
  const after = await controlAfter.read();
  if (!after || after.payload.transactionId !== transactionId)
    throw new Error("V3_PULL_CONTROL_STATE_INCONSISTENT");
  if (after.payload.phase === "applied") return;
  await identities.commitConfirmedV3Activation();
  await identities.write(after.payload.identities);
  await controlAfter.write({ ...after.payload, phase: "applied" });
}
