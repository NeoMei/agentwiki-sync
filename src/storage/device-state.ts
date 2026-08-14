import type { ControlStorePort } from "../ports/control-store";
import { MutableControlRepository } from "./envelope";

export interface DeviceLocalState {
  schemaVersion: 1;
  deviceId: string;
  boundVaultId: string | null;
}

const isDeviceLocalState = (value: unknown): value is DeviceLocalState =>
  !!value &&
  typeof value === "object" &&
  (value as Partial<DeviceLocalState>).schemaVersion === 1 &&
  typeof (value as Partial<DeviceLocalState>).deviceId === "string" &&
  ((value as Partial<DeviceLocalState>).boundVaultId === null ||
    typeof (value as Partial<DeviceLocalState>).boundVaultId === "string");

export class DeviceStateRepository {
  private readonly repo: MutableControlRepository<DeviceLocalState>;
  constructor(private readonly store: ControlStorePort) {
    this.repo = new MutableControlRepository(
      store,
      "agentwiki-sync-device-v1",
      isDeviceLocalState,
    );
  }
  async read(): Promise<DeviceLocalState | null> {
    const current = await this.repo.read();
    if (current) return current.payload;
    const deviceId = await this.store.read("device-id");
    const boundVaultId = await this.store.read("bound-vault-id");
    if (deviceId === null && boundVaultId === null) return null;
    const state: DeviceLocalState = {
      schemaVersion: 1,
      deviceId: deviceId ?? "",
      boundVaultId,
    };
    await this.repo.write(state);
    if (deviceId !== null) await this.store.remove("device-id");
    if (boundVaultId !== null) await this.store.remove("bound-vault-id");
    return state;
  }
  async getOrCreateDeviceId(): Promise<string> {
    const state = await this.read();
    if (state?.deviceId) return state.deviceId;
    const deviceId = crypto.randomUUID();
    await this.repo.write({
      schemaVersion: 1,
      deviceId,
      boundVaultId: state?.boundVaultId ?? null,
    });
    return deviceId;
  }
  async setBoundVaultId(vaultId: string): Promise<void> {
    const state = await this.read();
    await this.repo.write({
      schemaVersion: 1,
      deviceId: state?.deviceId ?? "",
      boundVaultId: vaultId,
    });
  }
  async getBoundVaultId(): Promise<string | null> {
    return (await this.read())?.boundVaultId ?? null;
  }
}
