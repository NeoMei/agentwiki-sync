import {
  canonicalBytes,
  canonicalTreeDeltaItemsV3,
  pathKey,
  treeCapabilitiesHashV3,
  treeConfirmationHashV3,
  treeRevisionDeltaV3,
  treeRevisionContentHashV2,
  treeRevisionContentHashV3,
  type TreePushConfirmationManifestV3,
  type TreeSyncCapabilitiesV3,
} from "@neomei/agentwiki-sync-protocol";

import { parseAttachmentReferences } from "../core/attachment-reference";
import { opaqueFileKey } from "../core/identity-key";
import type { TreePullActionV3 } from "../core/merge";
import type { LocalTreeScanV3 } from "../core/tree-scan";
import type { TreeSnapshot, TreeSnapshotV3 } from "../core/tree-model";
import { validateTreeSnapshot } from "../core/tree-validation";
import { contentHash, sha256Hex } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import {
  UpgradeBindingSchema,
  type UpgradeBinding,
} from "../storage/local-image-upgrade";
import type { TreeIdentityStateV2 } from "../storage/tree-identities";
import {
  buildTreeCalculationPreviewV3,
  pendingTreeDecisionCount,
  rebuildTreeCalculationPreviewV3,
  type TreePullPreviewV3,
} from "./tree-diff";
import {
  cancellationCheckpoint,
  progressCheckpoint,
  type SyncOperationOptions,
} from "./progress";
import type {
  PreparedTreePushChangeV3,
  TreePushPreviewV3,
} from "./tree-push-service-v3";
import type { TreeTransactionPathState } from "./tree-transaction";

export type UpgradeTree = Pick<
  TreeSnapshotV3,
  "protocolVersion" | "spaceId" | "folders" | "pages" | "attachments"
>;

export interface LegacyUpgradeBase {
  sourceProtocolVersion: "2";
  sourceRevision: string;
  sourceV2RevisionHash: string;
  source: TreeSnapshot & { protocolVersion: "2" };
  projected: UpgradeTree;
  projectedV3BaseHash: string;
}

export interface UpgradePreview {
  binding: UpgradeBinding;
  remoteBase: LegacyUpgradeBase;
  oldBaselineEvidenceHash: string;
  merge: TreePullPreviewV3<UpgradeTree>;
  candidate: UpgradeTree;
  candidateHash: string;
  localActions: TreePullActionV3[];
  expectedPathStates: Record<string, TreeTransactionPathState>;
  localPlanEvidence: UpgradeLocalPlanEvidence;
  localPlanHash: string;
  push: TreePushPreviewV3;
  authorizationHash: string;
}

export interface UpgradeLocalPlanEvidence {
  actions: TreePullActionV3[];
  rawPathStates: LocalTreeScanV3["rawPathStates"];
  expectedPathStates: Record<string, TreeTransactionPathState>;
  scanEpoch: number;
  identities: TreeIdentityStateV2;
}

export interface UpgradeMergeInput {
  base: LegacyUpgradeBase;
  remote: LegacyUpgradeBase;
  local: LocalTreeScanV3;
}

export interface PrepareLegacyUpgradePreviewInput extends UpgradeMergeInput {
  binding: UpgradeBinding;
  identities: TreeIdentityStateV2;
  scanEpoch: number;
  oldBaselineEvidenceHash: string;
  capabilities: TreeSyncCapabilitiesV3;
  capabilitiesHash: string;
  control: ControlStorePort;
  controlRoot: string;
  merge?: TreePullPreviewV3<UpgradeTree>;
  options?: SyncOperationOptions;
}

export interface PrepareTreePushChangesV3Input {
  base: UpgradeTree;
  candidate: UpgradeTree;
  vaultRoot: string;
  control: ControlStorePort;
  payloadRoot: string;
  options?: SyncOperationOptions;
  stagePages?: boolean;
}

const HASH = /^[a-f0-9]{64}$/u;

const joinRoot = (root: string, relative: string): string =>
  root ? `${root}/${relative}` : relative;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value))
    return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function sameFolderMetadata(
  left: UpgradeTree["folders"][number],
  right: UpgradeTree["folders"][number],
): boolean {
  return (
    left.parentFolderId === right.parentFolderId &&
    left.name === right.name &&
    left.path === right.path &&
    left.sortOrder === right.sortOrder
  );
}

function samePageMetadata(
  left: UpgradeTree["pages"][number],
  right: UpgradeTree["pages"][number],
): boolean {
  return (
    left.folderId === right.folderId &&
    left.path === right.path &&
    left.title === right.title &&
    left.contentHash === right.contentHash &&
    JSON.stringify(left.referencedAttachmentIds) ===
      JSON.stringify(right.referencedAttachmentIds)
  );
}

function sameAttachmentMetadata(
  left: UpgradeTree["attachments"][number],
  right: UpgradeTree["attachments"][number],
): boolean {
  return (
    left.path === right.path &&
    left.mimeType === right.mimeType &&
    left.sizeBytes === right.sizeBytes &&
    left.width === right.width &&
    left.height === right.height &&
    left.contentHash === right.contentHash
  );
}

function normalizeCandidateMetadata(
  base: UpgradeTree,
  candidate: UpgradeTree,
): UpgradeTree {
  const folders = new Map(base.folders.map((item) => [item.folderId, item]));
  const pages = new Map(base.pages.map((item) => [item.pageId, item]));
  const attachments = new Map(
    base.attachments.map((item) => [item.attachmentId, item]),
  );
  return {
    ...candidate,
    folders: candidate.folders.map((item) => {
      const prior = folders.get(item.folderId);
      return prior && sameFolderMetadata(prior, item)
        ? { ...item, updatedAt: prior.updatedAt }
        : item;
    }),
    pages: candidate.pages.map((item) => {
      const prior = pages.get(item.pageId);
      return prior && samePageMetadata(prior, item)
        ? { ...item, updatedAt: prior.updatedAt }
        : item;
    }),
    attachments: candidate.attachments.map((item) => {
      const prior = attachments.get(item.attachmentId);
      return prior && sameAttachmentMetadata(prior, item)
        ? { ...item, updatedAt: prior.updatedAt }
        : item;
    }),
  };
}

function manifestChange(
  change: PreparedTreePushChangeV3,
): TreePushConfirmationManifestV3["changes"][number] {
  if (change.operation === "upsert_page") {
    const {
      payloadPath: _payloadPath,
      bodyBytes: _bodyBytes,
      ...page
    } = change.page;
    return { operation: change.operation, page };
  }
  if (change.operation === "upsert_attachment")
    return { operation: change.operation, attachment: change.attachment };
  if (change.operation === "upsert_folder")
    return { operation: change.operation, folder: change.folder };
  return { ...change };
}

export async function prepareTreePushChangesV3(
  input: PrepareTreePushChangesV3Input,
): Promise<{ candidate: UpgradeTree; changes: PreparedTreePushChangeV3[] }> {
  const base: UpgradeTree = {
    protocolVersion: "3",
    spaceId: input.base.spaceId,
    folders: input.base.folders,
    pages: input.base.pages,
    attachments: input.base.attachments,
  };
  const candidate = normalizeCandidateMetadata(base, input.candidate);
  const changes = canonicalTreeDeltaItemsV3(
    treeRevisionDeltaV3(base, candidate),
  );
  const prepared: PreparedTreePushChangeV3[] = [];
  const stagedPayloads: string[] = [];
  let completed = 0;
  try {
    for (const change of changes) {
      cancellationCheckpoint(input.options, true);
      if (change.operation === "upsert_page") {
        const payloadPath = `${input.payloadRoot}/${await opaqueFileKey(change.page.pageId)}.md`;
        if (input.stagePages !== false) {
          await input.control.write(payloadPath, change.page.body);
          stagedPayloads.push(payloadPath);
        }
        cancellationCheckpoint(input.options, true);
        const { body: _body, ...page } = change.page;
        prepared.push({
          operation: "upsert_page",
          page: {
            ...page,
            referencedAttachmentIds: [
              ...new Set(page.referencedAttachmentIds),
            ].sort(),
            payloadPath,
            bodyBytes: new TextEncoder().encode(change.page.body).byteLength,
          },
        });
      } else if (change.operation === "upsert_attachment") {
        prepared.push({
          operation: "upsert_attachment",
          attachment: change.attachment,
          vaultPath: joinRoot(input.vaultRoot, change.attachment.path),
        });
      } else prepared.push(change);
      completed += 1;
      if (completed % 50 === 0)
        await progressCheckpoint(input.options, {
          phase: "merge",
          completed,
          total: changes.length,
          cancellable: true,
        });
    }
  } catch (error) {
    await Promise.allSettled(
      stagedPayloads.map((path) => input.control.remove(path)),
    );
    throw error;
  }
  return { candidate, changes: prepared };
}

export function expectedV3PathStates(
  local: LocalTreeScanV3,
  actions: TreePullActionV3[],
): Record<string, TreeTransactionPathState> {
  const expected: Record<string, TreeTransactionPathState> = {};
  const stateAt = (path: string): TreeTransactionPathState =>
    local.rawPathStates[path] ?? { kind: "missing", hash: null };
  const add = (path: string, state = stateAt(path)): void => {
    expected[joinRoot(local.rootPath, path)] = state;
  };
  const addSubtree = (path: string): void => {
    add(path);
    const prefix = `${path}/`;
    for (const [candidate, state] of Object.entries(local.rawPathStates))
      if (candidate.startsWith(prefix)) add(candidate, state);
  };
  const addProjectedMissingSubtree = (source: string, target: string): void => {
    add(target);
    const prefix = `${source}/`;
    for (const candidate of Object.keys(local.rawPathStates))
      if (candidate.startsWith(prefix))
        add(`${target}/${candidate.slice(prefix.length)}`);
  };
  for (const folder of local.folders) add(folder.path);
  for (const page of local.pages) add(page.path);
  for (const attachment of local.attachments) add(attachment.path);
  for (const action of actions) {
    switch (action.kind) {
      case "create_directory":
      case "create_page":
        add(action.path);
        break;
      case "trash_directory":
        addSubtree(action.path);
        break;
      case "move_directory": {
        const source = action.beforePath ?? action.fromPath;
        addSubtree(source);
        addProjectedMissingSubtree(source, action.path);
        break;
      }
      case "write_page":
        add(action.beforePath ?? action.path);
        if (action.beforePath) add(action.path);
        break;
      case "move_page":
        add(action.beforePath ?? action.fromPath);
        if (action.beforePath) add(action.fromPath);
        add(action.path);
        break;
      case "trash_page":
        add(action.path);
        break;
      case "create_attachment":
      case "write_attachment":
        add(action.attachment.path);
        break;
      case "remove_attachment_path":
        add(action.path);
        break;
      case "detach_attachment":
        break;
    }
  }
  return expected;
}

function assertFirstBindingIsExplicit(input: UpgradeMergeInput): void {
  if (input.base.projected.folders.length || input.base.projected.pages.length)
    return;
  const localPageIdsByPath = new Map(
    input.local.pages.map((item) => [pathKey(item.path), item.pageId]),
  );
  const localFolderIdsByPath = new Map(
    input.local.folders.map((item) => [pathKey(item.path), item.folderId]),
  );
  if (
    input.remote.projected.pages.some((item) => {
      const localId = localPageIdsByPath.get(pathKey(item.path));
      return localId !== undefined && localId !== item.pageId;
    }) ||
    input.remote.projected.folders.some((item) => {
      const localId = localFolderIdsByPath.get(pathKey(item.path));
      return localId !== undefined && localId !== item.folderId;
    })
  )
    throw new Error("INITIAL_BINDING_DECISION_REQUIRED");
}

export async function mergeLegacyUpgrade(
  input: UpgradeMergeInput,
): Promise<TreePullPreviewV3<UpgradeTree>> {
  assertLegacyMergeInput(input);
  return buildTreeCalculationPreviewV3(
    input.base.projected,
    input.local,
    input.remote.projected,
    input.remote.sourceRevision,
  );
}

function assertLegacyMergeInput(input: UpgradeMergeInput): void {
  if (input.base.projected.spaceId !== input.remote.projected.spaceId)
    throw new Error("UPGRADE_SPACE_MISMATCH");
  assertFirstBindingIsExplicit(input);
}

export async function hashUpgradeAuthorization(input: {
  binding: UpgradeBinding;
  sourceRevision: string;
  sourceV2RevisionHash: string;
  projectedV3BaseHash: string;
  oldBaselineEvidenceHash: string;
  candidateHash: string;
  localPlanHash: string;
  confirmationHash: string;
}): Promise<string> {
  return sha256Hex(canonicalBytes(input));
}

export async function hashUpgradeLocalPlan(
  evidence: UpgradeLocalPlanEvidence,
): Promise<string> {
  return sha256Hex(canonicalBytes(evidence));
}

function sameFixedMerge(
  merge: TreePullPreviewV3<UpgradeTree>,
  input: UpgradeMergeInput,
): boolean {
  return (
    canonicalBytes(merge.base).toString() ===
      canonicalBytes(input.base.projected).toString() &&
    canonicalBytes(merge.remote).toString() ===
      canonicalBytes(input.remote.projected).toString() &&
    canonicalBytes(merge.local).toString() ===
      canonicalBytes(input.local).toString() &&
    merge.revision === input.remote.sourceRevision
  );
}

function mergeResultEvidence(merge: TreePullPreviewV3<UpgradeTree>): unknown {
  return {
    revision: merge.revision,
    actions: merge.actions,
    blockers: merge.blockers,
    attachmentConflicts: merge.attachmentConflicts,
    attachmentConflictResolutions: merge.attachmentConflictResolutions,
    folderConflicts: merge.folderConflicts,
    folderConflictResolutions: merge.folderConflictResolutions,
    pageConflicts: merge.pageConflicts,
    pageConflictResolutions: merge.pageConflictResolutions,
    pagePlan: merge.pagePlan,
    attachmentPlan: merge.attachmentPlan,
    resolvedFolders: merge.resolvedFolders,
    resolvedPages: merge.resolvedPages,
    resolvedAttachments: merge.resolvedAttachments,
  };
}

export async function prepareLegacyUpgradePreview(
  input: PrepareLegacyUpgradePreviewInput,
): Promise<UpgradePreview> {
  const control = input.control;
  const options = input.options;
  const frozen = structuredClone({
    binding: input.binding,
    base: input.base,
    remote: input.remote,
    local: input.local,
    identities: input.identities,
    scanEpoch: input.scanEpoch,
    oldBaselineEvidenceHash: input.oldBaselineEvidenceHash,
    capabilities: input.capabilities,
    capabilitiesHash: input.capabilitiesHash,
    controlRoot: input.controlRoot,
    merge: input.merge,
  });
  const parsedBinding = UpgradeBindingSchema.parse(frozen.binding);
  assertLegacyMergeInput(frozen);
  if (
    parsedBinding.spaceId !== frozen.remote.projected.spaceId ||
    !Number.isSafeInteger(frozen.scanEpoch) ||
    frozen.scanEpoch < 0 ||
    !HASH.test(frozen.oldBaselineEvidenceHash)
  )
    throw new TypeError("INVALID_UPGRADE_PREVIEW_INPUT");
  if (
    (await treeCapabilitiesHashV3(frozen.capabilities)) !==
    frozen.capabilitiesHash
  )
    throw new Error("CAPABILITIES_CHANGED");
  const resolved = frozen.merge
    ? frozen.merge
    : await mergeLegacyUpgrade(frozen);
  if (frozen.merge && !sameFixedMerge(resolved, frozen))
    throw new Error("STALE_UPGRADE_MERGE");
  if (frozen.merge) {
    const rebuilt = await rebuildTreeCalculationPreviewV3(resolved);
    if (
      canonicalBytes(mergeResultEvidence(rebuilt)).toString() !==
      canonicalBytes(mergeResultEvidence(resolved)).toString()
    )
      throw new Error("STALE_UPGRADE_MERGE");
  }
  if (pendingTreeDecisionCount(resolved) > 0)
    throw new Error("UPGRADE_PREVIEW_DECISION_REQUIRED");
  const rawCandidate: UpgradeTree = {
    protocolVersion: "3",
    spaceId: frozen.remote.projected.spaceId,
    folders: structuredClone(resolved.resolvedFolders),
    pages: structuredClone(resolved.resolvedPages),
    attachments: structuredClone(resolved.resolvedAttachments),
  };
  if (rawCandidate.attachments.length === 0)
    throw new Error("UPGRADE_PREVIEW_NO_IMAGES_RECONFIRM_TEXT");
  const payloadRoot = `${frozen.controlRoot}/local-image-upgrade/${parsedBinding.operationId}/payload`;
  try {
    const prepared = await prepareTreePushChangesV3({
      base: frozen.remote.projected,
      candidate: rawCandidate,
      vaultRoot: frozen.local.rootPath,
      control,
      payloadRoot,
      options,
    });
    if (prepared.changes.length === 0) throw new Error("UPGRADE_PREVIEW_EMPTY");
    const candidateHash = await treeRevisionContentHashV3(prepared.candidate);
    const localActions = structuredClone(resolved.actions);
    const expectedPathStates = expectedV3PathStates(frozen.local, localActions);
    const localPlanEvidence = deepFreeze(
      structuredClone({
        actions: localActions,
        rawPathStates: frozen.local.rawPathStates,
        expectedPathStates,
        scanEpoch: frozen.scanEpoch,
        identities: frozen.identities,
      }),
    );
    const localPlanHash = await hashUpgradeLocalPlan(localPlanEvidence);
    const confirmationHash = await treeConfirmationHashV3({
      protocolVersion: "3",
      spaceId: prepared.candidate.spaceId,
      baseRevision: frozen.remote.sourceRevision,
      capabilitiesHash: frozen.capabilitiesHash,
      changes: prepared.changes.map(manifestChange),
    });
    const push: TreePushPreviewV3 = {
      protocolVersion: "3",
      spaceId: prepared.candidate.spaceId,
      baseRevision: frozen.remote.sourceRevision,
      changes: prepared.changes,
      capabilities: structuredClone(frozen.capabilities),
      capabilitiesHash: frozen.capabilitiesHash,
      confirmationHash,
      credentialId: parsedBinding.credentialId,
      previewId: parsedBinding.operationId,
    };
    const authorizationHash = await hashUpgradeAuthorization({
      binding: parsedBinding,
      sourceRevision: frozen.remote.sourceRevision,
      sourceV2RevisionHash: frozen.remote.sourceV2RevisionHash,
      projectedV3BaseHash: frozen.remote.projectedV3BaseHash,
      oldBaselineEvidenceHash: frozen.oldBaselineEvidenceHash,
      candidateHash,
      localPlanHash,
      confirmationHash,
    });
    return {
      binding: parsedBinding,
      remoteBase: structuredClone(frozen.remote),
      oldBaselineEvidenceHash: frozen.oldBaselineEvidenceHash,
      merge: resolved,
      candidate: prepared.candidate,
      candidateHash,
      localActions,
      expectedPathStates,
      localPlanEvidence,
      localPlanHash,
      push,
      authorizationHash,
    };
  } catch (error) {
    try {
      await control.removeTree?.(payloadRoot);
    } catch {
      // Preview payloads are inert, but the original failure remains authoritative.
    }
    throw error;
  }
}

export async function projectLegacyBase(
  input: TreeSnapshot & { protocolVersion: "2" },
): Promise<LegacyUpgradeBase> {
  const source = validateTreeSnapshot(input) as TreeSnapshot & {
    protocolVersion: "2";
  };
  for (const page of source.pages) {
    if ((await contentHash(page.body)) !== page.contentHash)
      throw new Error("快照页面内容哈希不匹配");
  }
  const sourceHash = await treeRevisionContentHashV2({
    protocolVersion: "2",
    spaceId: source.spaceId,
    folders: source.folders,
    pages: source.pages,
  });
  const strictEmptyGenesis =
    source.revision === "0" &&
    source.revisionContentHash ===
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" &&
    source.folders.length === 0 &&
    source.pages.length === 0;
  if (!strictEmptyGenesis && sourceHash !== source.revisionContentHash)
    throw new Error("快照完整性不匹配");
  for (const page of source.pages) {
    const references = parseAttachmentReferences(page.body, page.path);
    if (references.some((reference) => reference.classification === "invalid"))
      throw new Error("LEGACY_IMAGE_REFERENCE_INVALID");
    if (
      references.some(
        (reference) =>
          reference.classification === "local" ||
          reference.classification === "legacy",
      )
    )
      throw new Error("LEGACY_IMAGE_CANDIDATE_REQUIRES_MODE_REFRESH");
  }
  const projected: UpgradeTree = {
    protocolVersion: "3",
    spaceId: source.spaceId,
    folders: source.folders.map((folder) => ({ ...folder })),
    pages: source.pages.map((page) => ({
      ...page,
      referencedAttachmentIds: [],
    })),
    attachments: [],
  };
  return {
    sourceProtocolVersion: "2",
    sourceRevision: source.revision,
    sourceV2RevisionHash: source.revisionContentHash,
    source: structuredClone(source),
    projected,
    projectedV3BaseHash: await treeRevisionContentHashV3(projected),
  };
}
