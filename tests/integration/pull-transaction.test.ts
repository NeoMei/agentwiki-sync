import { describe, expect, it } from "vitest";
import { PullTransaction } from "../../src/application/pull-transaction";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

describe("PullTransaction", () => {
  it("applies writes, creates, rename cycles and trash as one recoverable plan", async () => {
    const vault = new MemoryVault({ "A.md": "A", "B.md": "B", "Gone.md": "gone" });
    const control = new MemoryControlStore();
    const transaction = new PullTransaction(vault, control, ".agentwiki/tx/t1");
    await transaction.prepare([
      { kind: "rename", fromPath: "A.md", path: "B.md", body: "A2" },
      { kind: "rename", fromPath: "B.md", path: "A.md", body: "B2" },
      { kind: "create", path: "New.md", body: "new" },
      { kind: "trash", path: "Gone.md" }
    ], 1);
    await transaction.apply(1);
    expect(vault.text("A.md")).toBe("B2");
    expect(vault.text("B.md")).toBe("A2");
    expect(vault.text("New.md")).toBe("new");
    expect(vault.exists("Gone.md")).toBe(false);
  });

  it("rolls back without overwriting a concurrent user edit", async () => {
    const vault = new MemoryVault({ "A.md": "old" });
    const control = new MemoryControlStore();
    const transaction = new PullTransaction(vault, control, ".agentwiki/tx/t2");
    await transaction.prepare([{ kind: "write", path: "A.md", body: "remote" }], 1);
    vault.failAfterOperations = 1;
    await expect(transaction.apply(1)).rejects.toThrow();
    vault.failAfterOperations = null;
    await transaction.recover();
    expect(vault.text("A.md")).toBe("old");
  });

  it("invalidates a preview when scan epoch changes", async () => {
    const transaction = new PullTransaction(new MemoryVault({}), new MemoryControlStore(), ".agentwiki/tx/t3");
    await transaction.prepare([{ kind: "create", path: "A.md", body: "a" }], 1);
    await expect(transaction.apply(2)).rejects.toThrow(/scan epoch/);
  });
});
