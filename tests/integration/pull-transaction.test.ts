import { describe, expect, it } from "vitest";
import { PullTransaction } from "../../src/application/pull-transaction";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";
import { sha256Hex } from "../../src/agentwiki/protocol";

describe("PullTransaction", () => {
  it("applies writes, creates, rename cycles and trash as one recoverable plan", async () => {
    const vault = new MemoryVault({
      "A.md": "A",
      "B.md": "B",
      "Gone.md": "gone",
    });
    const control = new MemoryControlStore();
    const transaction = new PullTransaction(vault, control, ".agentwiki/tx/t1");
    await transaction.prepare(
      [
        { kind: "rename", fromPath: "A.md", path: "B.md", body: "A2" },
        { kind: "rename", fromPath: "B.md", path: "A.md", body: "B2" },
        { kind: "create", path: "New.md", body: "new" },
        { kind: "trash", path: "Gone.md" },
      ],
      1,
    );
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
    await transaction.prepare(
      [{ kind: "write", path: "A.md", body: "remote" }],
      1,
    );
    vault.failAfterOperations = 1;
    await expect(transaction.apply(1)).rejects.toThrow();
    vault.failAfterOperations = null;
    await transaction.recover();
    expect(vault.text("A.md")).toBe("old");
  });

  it("invalidates a preview when scan epoch changes", async () => {
    const transaction = new PullTransaction(
      new MemoryVault({}),
      new MemoryControlStore(),
      ".agentwiki/tx/t3",
    );
    await transaction.prepare([{ kind: "create", path: "A.md", body: "a" }], 1);
    await expect(transaction.apply(2)).rejects.toThrow(/扫描纪元/);
  });

  it("recognizes a fully materialized rename after temporary cleanup as committed", async () => {
    const vault = new MemoryVault({ "A.md": "old" });
    const control = new MemoryControlStore();
    const transaction = new PullTransaction(
      vault,
      control,
      ".agentwiki/tx/final-window",
    );
    await transaction.prepare(
      [{ kind: "rename", fromPath: "A.md", path: "B.md", body: "new" }],
      1,
      "tx-final",
    );
    const original = new TextEncoder().encode("old");
    const result = new TextEncoder().encode("new");
    const originalHash = await sha256Hex(original);
    const resultHash = await sha256Hex(result);
    await transaction.replaceForRecoveryTest((raw) => {
      raw.state = "applying";
      raw.temporaryPaths = [
        {
          original: "A.md",
          temporary: "A.md.agentwiki-tmp-0",
          expectedHash: originalHash,
        },
      ];
      raw.materialized = [{ path: "B.md", resultHash, expectedHash: null }];
    });
    await vault.rename("A.md", "A.md.agentwiki-tmp-0");
    await vault.write("B.md", result);
    await vault.remove("A.md.agentwiki-tmp-0");
    await transaction.recover();
    expect(vault.text("B.md")).toBe("new");
    expect((await transaction.inspect())?.state).toBe("committed");
  });

  it("freezes instead of deleting a file that appeared after prepare", async () => {
    const vault = new MemoryVault({});
    const transaction = new PullTransaction(
      vault,
      new MemoryControlStore(),
      ".agentwiki/tx/concurrent-create",
    );
    await transaction.prepare(
      [{ kind: "create", path: "A.md", body: "remote" }],
      1,
    );
    await vault.write("A.md", new TextEncoder().encode("user"));
    await expect(transaction.recover()).rejects.toThrow(/恢复失败/);
    expect(vault.text("A.md")).toBe("user");
    expect((await transaction.inspect())?.state).toBe("failed");
  });

  it("does not rerun a successful rollback after later user edits", async () => {
    const vault = new MemoryVault({ "A.md": "old" });
    const transaction = new PullTransaction(
      vault,
      new MemoryControlStore(),
      ".agentwiki/tx/rolled-back",
    );
    await transaction.prepare(
      [{ kind: "write", path: "A.md", body: "remote" }],
      1,
    );
    await transaction.recover();
    expect((await transaction.inspect())?.state).toBe("rolled_back");
    await vault.write("A.md", new TextEncoder().encode("later"));
    await transaction.recover();
    expect(vault.text("A.md")).toBe("later");
  });
});
