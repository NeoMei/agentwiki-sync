import type { ControlStorePort } from "../ports/control-store";
import { DeviceStateRepository } from "./device-state";

interface VaultIdentity {
  schemaVersion: 1;
  vaultId: string;
}
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class VaultIdentityService {
  private readonly deviceState: DeviceStateRepository | null;
  constructor(
    private readonly shared: ControlStorePort,
    private readonly local?: ControlStorePort,
  ) {
    this.deviceState = local ? new DeviceStateRepository(local) : null;
  }
  async getOrCreate(): Promise<string> {
    const paths = [
      ".agentwiki/vault.json",
      ".agentwiki/vault.json.prev",
      ".agentwiki/vault.json.next",
    ];
    const raws = await Promise.all(paths.map((path) => this.shared.read(path)));
    const candidates = raws.flatMap((raw) => {
      if (!raw) return [];
      let identity: VaultIdentity;
      try {
        identity = JSON.parse(raw) as VaultIdentity;
      } catch {
        throw new Error("无效的库身份");
      }
      if (identity.schemaVersion !== 1 || !UUID_V4.test(identity.vaultId))
        throw new Error("无效的库身份");
      return [identity];
    });
    const ids = new Set(candidates.map((item) => item.vaultId));
    if (ids.size > 1) throw new Error("库身份分叉");
    if (candidates[0]) {
      if (!raws[0])
        await this.shared.write(paths[0]!, JSON.stringify(candidates[0]));
      return candidates[0].vaultId;
    }
    const vaultId = crypto.randomUUID();
    await this.shared.write(
      ".agentwiki/vault.json.next",
      JSON.stringify({ schemaVersion: 1, vaultId }),
    );
    const verify = JSON.parse(
      (await this.shared.read(".agentwiki/vault.json.next")) ?? "null",
    ) as VaultIdentity | null;
    if (verify?.vaultId !== vaultId) throw new Error("库身份验证失败");
    await this.shared.rename(
      ".agentwiki/vault.json.next",
      ".agentwiki/vault.json",
    );
    return vaultId;
  }
  async bind(vaultId: string): Promise<void> {
    if (this.deviceState) await this.deviceState.setBoundVaultId(vaultId);
    else await this.shared.write("bound-vault-id", vaultId);
  }
  async assertBound(): Promise<void> {
    const expected = this.deviceState
      ? await this.deviceState.getBoundVaultId()
      : await this.shared.read("bound-vault-id");
    const actual = await this.getOrCreate();
    if (expected !== actual) throw new Error("库身份不匹配");
  }
}
