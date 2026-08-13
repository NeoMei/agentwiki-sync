import {
  canonicalBytes,
  sha256Hex,
  type SyncPage,
} from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import { MutableControlRepository } from "./envelope";
import { GenerationRepository } from "./generation";
import { isCurrentPointerPayload, type CurrentPointerPayload } from "./pointer";

export interface BaselineState {
  revision: string;
  pages: Record<
    string,
    {
      pageId: string;
      relativePath: string;
      title: string;
      contentHash: string;
      body: string;
    }
  >;
}
interface BaselineJournal {
  schemaVersion: 1;
  transactionId: string;
  kind: "pull" | "push" | "initialize";
  phase:
    | "prepared"
    | "applying"
    | "committing"
    | "committed"
    | "rolled_back"
    | "failed";
  oldGenerationId: string | null;
  newGenerationId: string;
}
function isJournal(value: unknown): value is BaselineJournal {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<BaselineJournal>;
  return (
    item.schemaVersion === 1 &&
    typeof item.transactionId === "string" &&
    ["pull", "push", "initialize"].includes(item.kind ?? "") &&
    [
      "prepared",
      "applying",
      "committing",
      "committed",
      "rolled_back",
      "failed",
    ].includes(item.phase ?? "") &&
    (item.oldGenerationId === null ||
      typeof item.oldGenerationId === "string") &&
    typeof item.newGenerationId === "string"
  );
}

export class BaselineRepository {
  private readonly generations: GenerationRepository;
  private readonly pointer: MutableControlRepository<CurrentPointerPayload>;
  private readonly journal: MutableControlRepository<BaselineJournal>;
  constructor(
    private readonly store: ControlStorePort,
    private readonly root: string,
    private readonly spaceId: string,
    private readonly rootPath: string,
  ) {
    this.generations = new GenerationRepository(store, root);
    this.pointer = new MutableControlRepository(
      store,
      `${root}/current.json`,
      isCurrentPointerPayload,
    );
    this.journal = new MutableControlRepository(
      store,
      `${root}/baseline-journal.json`,
      isJournal,
    );
  }
  async read(): Promise<BaselineState> {
    const current = await this.pointer.read();
    if (!current?.payload.active) return { revision: "0", pages: {} };
    const value = await this.generations.read(current.payload.generationId);
    if (
      value.manifest.spaceId !== this.spaceId ||
      value.manifest.rootPath !== this.rootPath ||
      (await sha256Hex(canonicalBytes(value.manifest))) !==
        current.payload.manifestHash
    )
      throw new Error("baseline corrupt: pointer identity/hash mismatch");
    const pages: BaselineState["pages"] = {};
    for (const page of Object.values(value.manifest.pages))
      pages[page.pageId] = { ...page, body: value.bodies[page.pageId]! };
    return { revision: value.manifest.baseRevision, pages };
  }
  async prepare(
    revision: string,
    pages: SyncPage[],
    kind: BaselineJournal["kind"],
  ): Promise<BaselineJournal> {
    const current = await this.pointer.read();
    const generationId = crypto.randomUUID();
    const pageMap = Object.fromEntries(
      pages.map((page) => [
        page.pageId,
        {
          pageId: page.pageId,
          relativePath: page.path,
          title: page.title,
          contentHash: page.contentHash,
        },
      ]),
    );
    const bodies = Object.fromEntries(
      pages.map((page) => [page.pageId, page.body]),
    );
    await this.generations.write(
      {
        schemaVersion: 1,
        protocolVersion: "1",
        generationId,
        spaceId: this.spaceId,
        rootPath: this.rootPath,
        baseRevision: revision,
        baseRevisionContentHash: "",
        basePageCount: 0,
        baseRevisionManifestByteLength: 0,
        baseRevisionBodyBytes: 0,
        lastSuccessfulSyncAt: new Date().toISOString(),
        pages: pageMap,
      },
      bodies,
    );
    const value: BaselineJournal = {
      schemaVersion: 1,
      transactionId: crypto.randomUUID(),
      kind,
      phase: "prepared",
      oldGenerationId: current?.payload.active
        ? current.payload.generationId
        : null,
      newGenerationId: generationId,
    };
    await this.journal.write(value);
    return value;
  }
  async setPhase(phase: BaselineJournal["phase"]): Promise<void> {
    const current = await this.journal.read();
    if (!current) throw new Error("Missing baseline journal");
    await this.journal.write({ ...current.payload, phase });
  }
  async commit(): Promise<void> {
    const current = await this.journal.read();
    if (!current) throw new Error("Missing baseline journal");
    await this.journal.write({ ...current.payload, phase: "committing" });
    const manifest = await this.generations.verify(
      current.payload.newGenerationId,
    );
    if (
      manifest.spaceId !== this.spaceId ||
      manifest.rootPath !== this.rootPath
    )
      throw new Error("baseline identity mismatch");
    const manifestHash = await sha256Hex(canonicalBytes(manifest));
    await this.pointer.write({
      schemaVersion: 1,
      active: true,
      generationId: current.payload.newGenerationId,
      manifestHash,
    });
    await this.journal.write({ ...current.payload, phase: "committed" });
  }
  async recover(committedTransactionId: string | null): Promise<void> {
    const current = await this.journal.read();
    if (
      !current ||
      current.payload.phase === "committed" ||
      current.payload.phase === "rolled_back"
    )
      return;
    if (committedTransactionId === current.payload.transactionId) {
      await this.commit();
      return;
    }
    await this.journal.write({ ...current.payload, phase: "rolled_back" });
  }
}
