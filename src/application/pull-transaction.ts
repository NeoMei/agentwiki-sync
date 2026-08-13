import { sha256Hex } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";
import type { VaultPort } from "../ports/vault";

export type PullAction =
  | { kind: "create" | "write"; path: string; body: string }
  | { kind: "rename"; fromPath: string; path: string; body: string }
  | { kind: "trash"; path: string };

interface SnapshotEntry { path: string; bytes: number[] | null; hash: string | null }
interface PullJournal {
  schemaVersion: 1;
  state: "prepared" | "applying" | "committed" | "rolling_back" | "failed";
  scanEpoch: number;
  actions: PullAction[];
  snapshots: SnapshotEntry[];
  temporaryPaths: Array<{ original: string; temporary: string }>;
  materialized: Array<{ path: string; resultHash: string }>;
}

const encoder = new TextEncoder();

export class PullTransaction {
  constructor(private readonly vault: VaultPort, private readonly control: ControlStorePort, private readonly root: string) {}
  private get journalPath(): string { return `${this.root}/journal.json`; }

  private async save(journal: PullJournal): Promise<void> { await this.control.write(this.journalPath, JSON.stringify(journal)); }
  private async load(): Promise<PullJournal> { const raw = await this.control.read(this.journalPath); if (!raw) throw new Error("Missing pull journal"); return JSON.parse(raw) as PullJournal; }

  async prepare(actions: PullAction[], scanEpoch: number): Promise<void> {
    const paths = new Set<string>();
    for (const action of actions) {
      paths.add(action.path);
      if (action.kind === "rename") paths.add(action.fromPath);
    }
    const snapshots: SnapshotEntry[] = [];
    for (const path of paths) {
      const bytes = await this.vault.read(path);
      snapshots.push({ path, bytes: bytes ? Array.from(bytes) : null, hash: bytes ? await sha256Hex(bytes) : null });
    }
    const journal: PullJournal = { schemaVersion: 1, state: "prepared", scanEpoch, actions, snapshots, temporaryPaths: [], materialized: [] };
    await this.save(journal);
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index]!;
      if (action.kind !== "trash") await this.control.write(`${this.root}/results/${index}.md`, action.body);
    }
  }

  async apply(scanEpoch: number): Promise<void> {
    const journal = await this.load();
    if (journal.scanEpoch !== scanEpoch) throw new Error("scan epoch changed");
    for (const snapshot of journal.snapshots) {
      const current = await this.vault.read(snapshot.path);
      const hash = current ? await sha256Hex(current) : null;
      if (hash !== snapshot.hash) throw new Error("Vault changed after preview");
    }
    journal.state = "applying"; await this.save(journal);
    try {
      for (let index = 0; index < journal.actions.length; index += 1) {
        const action = journal.actions[index]!;
        if (action.kind === "rename") {
          const temporary = `.agentwiki-tmp-${index}`;
          await this.vault.rename(action.fromPath, temporary);
          journal.temporaryPaths.push({ original: action.fromPath, temporary }); await this.save(journal);
        }
      }
      for (let index = 0; index < journal.actions.length; index += 1) {
        const action = journal.actions[index]!;
        if (action.kind === "trash") {
          await this.vault.trashFile(action.path);
        } else {
          const existing = await this.vault.read(action.path);
          if (existing) await this.vault.remove(action.path);
          const body = encoder.encode(action.body);
          await this.vault.write(action.path, body);
          journal.materialized.push({ path: action.path, resultHash: await sha256Hex(body) }); await this.save(journal);
        }
      }
      for (const temporary of journal.temporaryPaths) if (await this.vault.read(temporary.temporary)) await this.vault.remove(temporary.temporary);
      journal.state = "committed"; await this.save(journal);
    } catch (error) {
      journal.state = "rolling_back"; await this.save(journal);
      await this.rollback(journal);
      throw error;
    }
  }

  async recover(): Promise<void> {
    const journal = await this.load();
    if (journal.state === "committed") return;
    await this.rollback(journal);
  }

  private async rollback(journal: PullJournal): Promise<void> {
    try {
      for (const materialized of [...journal.materialized].reverse()) {
        const current = await this.vault.read(materialized.path);
        if (current && await sha256Hex(current) !== materialized.resultHash) throw new Error("User edited an applied result");
        if (current) await this.vault.remove(materialized.path);
      }
      for (const temporary of [...journal.temporaryPaths].reverse()) {
        const bytes = await this.vault.read(temporary.temporary);
        if (bytes) {
          const current = await this.vault.read(temporary.original);
          if (current) await this.vault.remove(temporary.original);
          await this.vault.rename(temporary.temporary, temporary.original);
        }
      }
      for (const snapshot of journal.snapshots) {
        const current = await this.vault.read(snapshot.path);
        if (snapshot.bytes === null) { if (current) await this.vault.remove(snapshot.path); }
        else if (!current || await sha256Hex(current) === snapshot.hash || journal.materialized.some((item) => item.path === snapshot.path)) await this.vault.write(snapshot.path, new Uint8Array(snapshot.bytes));
      }
      journal.state = "prepared"; journal.materialized = []; journal.temporaryPaths = []; await this.save(journal);
    } catch {
      journal.state = "failed"; await this.save(journal); throw new Error("Pull recovery failed safely");
    }
  }
}
