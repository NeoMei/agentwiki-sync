import type { ControlStorePort } from "../ports/control-store";

interface VaultIdentity { schemaVersion: 1; vaultId: string }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class VaultIdentityService {
  constructor(private readonly shared: ControlStorePort, private readonly local?: ControlStorePort) {}
  async getOrCreate(): Promise<string> {
    const raw = await this.shared.read(".agentwiki/vault.json");
    if (raw) { const identity = JSON.parse(raw) as VaultIdentity; if (identity.schemaVersion !== 1 || !UUID_V4.test(identity.vaultId)) throw new Error("Invalid Vault identity"); return identity.vaultId; }
    const vaultId = crypto.randomUUID(); await this.shared.write(".agentwiki/vault.json.next", JSON.stringify({ schemaVersion: 1, vaultId }));
    const verify = JSON.parse((await this.shared.read(".agentwiki/vault.json.next")) ?? "null") as VaultIdentity | null;
    if (verify?.vaultId !== vaultId) throw new Error("Vault identity verification failed"); await this.shared.rename(".agentwiki/vault.json.next", ".agentwiki/vault.json"); return vaultId;
  }
  async bind(vaultId: string): Promise<void> { await (this.local ?? this.shared).write("bound-vault-id", vaultId); }
  async assertBound(): Promise<void> { const expected = await (this.local ?? this.shared).read("bound-vault-id"); const actual = await this.getOrCreate(); if (expected !== actual) throw new Error("Vault identity mismatch"); }
}
