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
  transactionId: string;
  state: "prepared" | "applying" | "committed" | "rolling_back" | "failed";
  scanEpoch: number;
  actions: PullAction[];
  snapshots: SnapshotEntry[];
  temporaryPaths: Array<{ original: string; temporary: string; expectedHash: string | null }>;
  materialized: Array<{ path: string; resultHash: string; expectedHash: string | null }>;
}

const encoder = new TextEncoder();

export class PullTransaction {
  constructor(private readonly vault: VaultPort, private readonly control: ControlStorePort, private readonly root: string) {}
  private get journalPath(): string { return `${this.root}/journal.json`; }

  private async save(journal: PullJournal): Promise<void> { await this.control.write(this.journalPath, JSON.stringify(journal)); }
  private async load(): Promise<PullJournal> { const raw = await this.control.read(this.journalPath); if (!raw) throw new Error("Missing pull journal"); return JSON.parse(raw) as PullJournal; }

  async prepare(actions: PullAction[], scanEpoch: number, transactionId: string = crypto.randomUUID()): Promise<void> {
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
    const journal: PullJournal = { schemaVersion: 1, transactionId, state: "prepared", scanEpoch, actions, snapshots, temporaryPaths: [], materialized: [] };
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
          const temporary = `${action.fromPath}.agentwiki-tmp-${index}`;
          const expectedHash = journal.snapshots.find((item) => item.path === action.fromPath)?.hash ?? null;
          journal.temporaryPaths.push({ original: action.fromPath, temporary, expectedHash }); await this.save(journal);
          await this.vault.rename(action.fromPath, temporary);
        }
      }
      for (let index = 0; index < journal.actions.length; index += 1) {
        const action = journal.actions[index]!;
        if (action.kind === "trash") {
          const expected = journal.snapshots.find((item) => item.path === action.path); const current = await this.vault.read(action.path); const currentHash = current ? await sha256Hex(current) : null;
          if (currentHash !== (expected?.hash ?? null)) throw new Error("Vault changed before trash");
          await this.vault.trashFile(action.path);
        } else {
          const body = encoder.encode(action.body);
          const snapshot = journal.snapshots.find((item) => item.path === action.path); const expected = action.kind === "rename" || snapshot?.bytes === null || !snapshot ? null : new Uint8Array(snapshot.bytes); const resultHash = await sha256Hex(body);
          journal.materialized.push({ path: action.path, resultHash, expectedHash: action.kind === "rename" ? null : snapshot?.hash ?? null }); await this.save(journal);
          await this.vault.ensureParentDirectories(action.path);
          if (!await this.vault.compareAndSwap(action.path, expected, body)) throw new Error("Vault changed before conditional write");
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
        const currentHash = current ? await sha256Hex(current) : null;
        if (currentHash === materialized.expectedHash) continue;
        if (currentHash !== materialized.resultHash) throw new Error("User edited an applied result");
        if (current) await this.vault.remove(materialized.path);
      }
      for (const temporary of [...journal.temporaryPaths].reverse()) {
        const bytes = await this.vault.read(temporary.temporary);
        if (bytes) {
          const current = await this.vault.read(temporary.original);
          if (current) throw new Error("User created a file at a rename source");
          await this.vault.rename(temporary.temporary, temporary.original);
        } else { const original = await this.vault.read(temporary.original); const hash = original ? await sha256Hex(original) : null; if (hash !== temporary.expectedHash) throw new Error("Rename recovery is ambiguous"); }
      }
      for (const snapshot of journal.snapshots) {
        const current = await this.vault.read(snapshot.path);
        if (snapshot.bytes === null) { if (current) await this.vault.remove(snapshot.path); }
        else if (!current) await this.vault.write(snapshot.path, new Uint8Array(snapshot.bytes));
        else if (await sha256Hex(current) !== snapshot.hash) throw new Error("Rollback target was edited after the transaction stopped");
      }
      for(const snapshot of journal.snapshots){const current=await this.vault.read(snapshot.path);const hash=current?await sha256Hex(current):null;if(hash!==snapshot.hash)throw new Error("Rollback snapshot verification failed");}
      journal.state = "prepared"; journal.materialized = []; journal.temporaryPaths = []; await this.save(journal);
    } catch {
      journal.state = "failed"; await this.save(journal); throw new Error("Pull recovery failed safely");
    }
  }
}
