import { contentHash } from "../agentwiki/protocol";
import { assertUpgradePreviewEvidence } from "../application/local-image-upgrade";
import {
  assertUpgradePreviewMaterialization,
  type UpgradePreview,
} from "../application/local-image-upgrade-plan";
import type { ControlStorePort } from "../ports/control-store";
import {
  UpgradeBindingSchema,
  UpgradeIntentSchema,
  type UpgradeIntent,
} from "./local-image-upgrade";

const PRIVATE_ROOT = /^\.agentwiki\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

function assertRoot(root: string): void {
  if (!PRIVATE_ROOT.test(root) || root.includes("..") || root.includes("\\"))
    throw new TypeError("Confirmed upgrade preview requires a private root");
}

function previewPath(root: string, intent: UpgradeIntent): string {
  const expected = `${root}/local-image-upgrade/${intent.binding.operationId}/payload/confirmed-preview.json`;
  if (!intent.payloadPaths.includes(expected))
    throw new Error("CONFIRMED_PREVIEW_PATH_NOT_OWNED");
  return expected;
}

export class ConfirmedUpgradePreviewRepository {
  constructor(
    private readonly store: ControlStorePort,
    private readonly controlRoot: string,
  ) {
    assertRoot(controlRoot);
  }

  async persist(
    intentInput: UpgradeIntent,
    preview: UpgradePreview,
  ): Promise<void> {
    const intent = UpgradeIntentSchema.parse(intentInput);
    UpgradeBindingSchema.parse(preview.binding);
    await assertUpgradePreviewEvidence(preview, intent);
    await assertUpgradePreviewMaterialization(preview);
    const path = previewPath(this.controlRoot, intent);
    await this.store.write(path, JSON.stringify(preview));
    await this.load(intent);
  }

  async load(intentInput: UpgradeIntent): Promise<UpgradePreview> {
    const intent = UpgradeIntentSchema.parse(intentInput);
    const raw = await this.store.read(previewPath(this.controlRoot, intent));
    if (raw === null) throw new Error("CONFIRMED_PREVIEW_MISSING");
    let preview: UpgradePreview;
    try {
      preview = JSON.parse(raw) as UpgradePreview;
    } catch {
      throw new Error("CONFIRMED_PREVIEW_CORRUPT");
    }
    await assertUpgradePreviewEvidence(preview, intent);
    await assertUpgradePreviewMaterialization(preview);
    for (const change of preview.push.changes) {
      if (change.operation !== "upsert_page") continue;
      if (!intent.payloadPaths.includes(change.page.payloadPath))
        throw new Error("CONFIRMED_PREVIEW_SIDECAR_NOT_OWNED");
      const body = await this.store.read(change.page.payloadPath);
      if (
        body === null ||
        (await contentHash(body)) !== change.page.contentHash ||
        new TextEncoder().encode(body).byteLength !== change.page.bodyBytes
      )
        throw new Error("CONFIRMED_PREVIEW_SIDECAR_MISMATCH");
    }
    return structuredClone(preview);
  }
}
