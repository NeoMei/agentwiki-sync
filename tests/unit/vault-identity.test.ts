import { describe, expect, it } from "vitest";
import { VaultIdentityService } from "../../src/storage/vault-identity";
import { MemoryControlStore } from "../fakes/memory-control-store";

describe("VaultIdentityService", () => {
  it("creates one shared vault ID and detects external replacement", async () => {
    const store = new MemoryControlStore();
    const service = new VaultIdentityService(store);
    const first = await service.getOrCreate();
    const second = await service.getOrCreate();
    expect(second).toBe(first);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    await service.bind(first);
    await store.write(
      ".agentwiki/vault.json",
      JSON.stringify({ schemaVersion: 1, vaultId: crypto.randomUUID() }),
    );
    await expect(service.assertBound()).rejects.toThrow(/身份不匹配/);
  });
});
