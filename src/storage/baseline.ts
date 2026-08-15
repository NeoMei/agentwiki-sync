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
  generationId?: string;
  pages: Record<
    string,
    {
      pageId: string;
      relativePath: string;
      title: string;
      contentHash: string;
      body?: string;
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
    const manifest = await this.generations.readManifest(
      current.payload.generationId,
    );
    if (
      manifest.spaceId !== this.spaceId ||
      manifest.rootPath !== this.rootPath ||
      (await sha256Hex(canonicalBytes(manifest))) !==
        current.payload.manifestHash
    )
      throw new Error("基线损坏: 指针身份/哈希不匹配");
    const pages: BaselineState["pages"] = {};
    for (const page of Object.values(manifest.pages))
      pages[page.pageId] = { ...page };
    return {
      revision: manifest.baseRevision,
      generationId: current.payload.generationId,
      pages,
    };
  }
  async readBody(
    pageId: string,
    generationId?: string,
    expectedHash?: string,
  ): Promise<string> {
    if (generationId && expectedHash) {
      // 从 manifest 读取 relativePath 传给 generation
      const manifest = await this.generations.readManifest(generationId);
      const page = manifest.pages[pageId];
      return this.generations.readBody(
        generationId,
        pageId,
        expectedHash,
        page?.relativePath,
      );
    }
    const current = await this.pointer.read();
    if (!current?.payload.active) throw new Error("基线缺失");
    const manifest = await this.generations.readManifest(
      current.payload.generationId,
    );
    const page = manifest.pages[pageId];
    if (!page) throw new Error("基线页面缺失");
    return this.generations.readBody(
      current.payload.generationId,
      pageId,
      page.contentHash,
      page.relativePath,
    );
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
  async prepareStreaming(
    revision: string,
    pages: SyncPage[],
    kind: BaselineJournal["kind"],
    body: (page: SyncPage) => Promise<string>,
  ): Promise<BaselineJournal> {
    const current = await this.pointer.read();
    const generationId = crypto.randomUUID();
    async function* source() {
      for (const page of pages)
        yield {
          pageId: page.pageId,
          relativePath: page.path,
          title: page.title,
          contentHash: page.contentHash,
          body: await body(page),
        };
    }
    await this.generations.writeStreaming(
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
        pages: {},
      },
      source(),
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
    if (!current) throw new Error("基线日志缺失");
    await this.journal.write({ ...current.payload, phase });
  }
  async commit(): Promise<void> {
    const current = await this.journal.read();
    if (!current) throw new Error("基线日志缺失");
    await this.journal.write({ ...current.payload, phase: "committing" });
    const manifest = await this.generations.verify(
      current.payload.newGenerationId,
    );
    if (
      manifest.spaceId !== this.spaceId ||
      manifest.rootPath !== this.rootPath
    )
      throw new Error("基线身份不匹配");
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
