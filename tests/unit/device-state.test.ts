import { describe, expect, it } from "vitest";
import { DeviceStateRepository } from "../../src/storage/device-state";
import { MemoryControlStore } from "../fakes/memory-control-store";

describe("DeviceStateRepository", () => {
  it("generates a stable device id and persists it through the envelope", async () => {
    const store = new MemoryControlStore();
    const repo = new DeviceStateRepository(store);
    const first = await repo.getOrCreateDeviceId();
    const second = await repo.getOrCreateDeviceId();
    expect(second).toBe(first);
    expect(await store.read("agentwiki-sync-device-v1")).toContain(first);
  });

  it("migrates legacy single keys into the envelope exactly once", async () => {
    const store = new MemoryControlStore();
    await store.write("device-id", "device-1");
    await store.write("bound-vault-id", "vault-1");
    const repo = new DeviceStateRepository(store);
    const state = await repo.read();
    expect(state).toEqual({
      schemaVersion: 1,
      deviceId: "device-1",
      boundVaultId: "vault-1",
    });
    expect(await store.read("device-id")).toBeNull();
    expect(await store.read("bound-vault-id")).toBeNull();
    expect(await store.read("agentwiki-sync-device-v1")).toContain("device-1");
  });

  it("updates boundVaultId without losing the device id", async () => {
    const store = new MemoryControlStore();
    const repo = new DeviceStateRepository(store);
    const deviceId = await repo.getOrCreateDeviceId();
    await repo.setBoundVaultId("vault-2");
    expect(await repo.getBoundVaultId()).toBe("vault-2");
    expect((await repo.read())?.deviceId).toBe(deviceId);
  });

  it("recovers the newest valid envelope generation", async () => {
    const store = new MemoryControlStore();
    const repo = new DeviceStateRepository(store);
    await repo.setBoundVaultId("vault-a");
    await repo.setBoundVaultId("vault-b");
    expect(await repo.getBoundVaultId()).toBe("vault-b");
    expect(await store.read("agentwiki-sync-device-v1.prev")).toContain(
      "vault-a",
    );
  });
});
