import { afterEach, describe, expect, it, vi } from "vitest";
import { Notice } from "../fakes/obsidian-mock";
import { contentHash } from "../../src/agentwiki/protocol";
import { SyncRuntime } from "../../src/application/sync-runtime";
import type { ModalTransition } from "../../src/obsidian/modal-handoff";
import { PreviewModal } from "../../src/obsidian/preview-modal";
import type { MockElement } from "../fakes/obsidian-mock";
import { FakeTreeRemote } from "../fakes/fake-tree-remote";
import { MemoryVault } from "../fakes/memory-vault";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { makePlugin, modalButton } from "../fakes/plugin-harness";

const folder = (
  id: string,
  path: string,
  parentFolderId: string | null = null,
) => ({
  folderId: id,
  parentFolderId,
  name: path.split("/").at(-1)!,
  path,
  sortOrder: 0,
  updatedAt: "2026-10-09T00:00:00.000Z",
});
const page = async (
  id: string,
  path: string,
  body: string,
  folderId: string | null = null,
) => ({
  pageId: id,
  folderId,
  title: path.split("/").at(-1)!.slice(0, -3),
  path,
  body,
  contentHash: await contentHash(body),
  updatedAt: "2026-10-09T00:00:00.000Z",
});

async function openAuto(strategy: "auto" | "local" = "auto") {
  const remote = new FakeTreeRemote();
  const parent = folder("f", "pages/F");
  const keep = await page("keep", "pages/Keep.md", "unchanged");
  await remote.seedTree({ folders: [parent], pages: [keep] });
  const vault = new MemoryVault({});
  const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
    spaceId: "space",
    rootPath: "Wiki",
    status: "active",
  });
  await runtime.applyPull(await runtime.previewPull());
  await vault.trashDirectory("Wiki/pages/F");
  await remote.seedTree({
    folders: [parent, folder("c", "pages/F/C", "f")],
    pages: [keep, await page("new", "pages/F/C/New.md", "new child", "c")],
  });
  await remote.advanceEmptyRevision();
  const { modal, root, summary, open } = await openStrategy(runtime, strategy);
  const row = root.queryAll((e) =>
    e.classes.has("agentwiki-sync-folder-setting"),
  )[0]!;
  const choice = row.queryAll((e) => e.tag === "select")[0]!;
  const manual = row.queryAll((e) => e.tag === "textarea")[0]!;
  const confirm = modalButton(modal, "确认执行");
  return {
    runtime,
    remote,
    vault,
    modal,
    summary,
    choice,
    manual,
    confirm,
    open,
  };
}
async function openStrategy(
  runtime: SyncRuntime,
  strategy: "auto" | "local" = "auto",
) {
  const harness = await makePlugin({
    data: {
      schemaVersion: 2,
      serverUrl: "https://wiki.example.com",
      mappings: [{ spaceId: "space", rootPath: "Wiki", status: "active" }],
    },
  });
  await harness.plugin.onload();
  const subject = harness.plugin as unknown as {
    runtime: () => Promise<SyncRuntime>;
    runSyncStrategy: (
      id: string,
      strategy: "auto" | "local",
      options: object,
    ) => Promise<ModalTransition | void>;
  };
  subject.runtime = async () => runtime;
  const open = vi
    .spyOn(PreviewModal.prototype, "open")
    .mockImplementation(function (this: PreviewModal) {
      this.onOpen();
    });
  const transition = await subject.runSyncStrategy("space", strategy, {});
  transition?.();
  const modal: PreviewModal = open.mock.instances.at(-1)!;
  const root = modal.contentEl as unknown as MockElement;
  const summary = root.queryAll((e) =>
    e.classes.has("agentwiki-sync-preview-summary"),
  )[0]!;
  return { modal, root, summary, open };
}
const change = (e: MockElement, value: string) => {
  e.value = value;
  e.dispatchEvent({ type: "change" });
};
afterEach(() => vi.restoreAllMocks());

describe("V2 real main Pull preview", () => {
  it("rejects deleting a parent with remote descendants before confirmation without changing Vault or plan", async () => {
    const f = await openAuto();
    const before = [...f.vault.operationLog];
    const summary = f.summary.textContent;
    const notices = Notice.messages.length;
    change(f.choice, "local");
    expect(f.confirm.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(Notice.messages.slice(notices).join(" ")).toMatch(
        /FOLDER_HAS_DEPENDENTS|目录仍有后代/u,
      ),
    );
    expect(f.summary.textContent).toBe(summary);
    f.confirm.dispatchEvent({ type: "click" });
    expect(f.vault.operationLog).toEqual(before);
    change(f.choice, "remote");
    await vi.waitFor(() => expect(f.confirm.disabled).toBe(false));
    f.confirm.dispatchEvent({ type: "click" });
    await vi.waitFor(() =>
      expect(f.vault.exists("Wiki/pages/F/C/New.md")).toBe(true),
    );
    expect(
      new TextDecoder().decode((await f.vault.read("Wiki/pages/Keep.md"))!),
    ).toBe("unchanged");
  });

  it("validates the preselected local choice when the real local strategy opens", async () => {
    const notices = Notice.messages.length;
    const f = await openAuto("local");
    expect(f.choice.value).toBe("local");
    expect(f.confirm.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(Notice.messages.slice(notices).join(" ")).toMatch(
        /FOLDER_HAS_DEPENDENTS|目录仍有后代/u,
      ),
    );
    change(f.choice, "manual");
    change(f.manual, "pages/Recovered");
    await vi.waitFor(() => expect(f.confirm.disabled).toBe(false));
    expect(f.summary.textContent).toContain("pages/Recovered/C/New.md");
  });

  it("shows manual descendant paths, supports clearing/reselecting, and applies exactly the reviewed plan", async () => {
    const f = await openAuto();
    change(f.choice, "manual");
    change(f.manual, "pages/Recovered");
    await vi.waitFor(() => expect(f.confirm.disabled).toBe(false));
    expect(f.summary.textContent).toContain("pages/Recovered/C/New.md");
    expect(f.summary.textContent).not.toContain("pages/F");
    change(f.choice, "");
    expect(f.confirm.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(f.summary.textContent).toContain("pages/F/C/New.md"),
    );
    change(f.choice, "remote");
    await vi.waitFor(() => expect(f.confirm.disabled).toBe(false));
    expect(f.summary.textContent).toContain("pages/F/C/New.md");
    change(f.choice, "manual");
    change(f.manual, "pages/Latest");
    await vi.waitFor(() =>
      expect(f.summary.textContent).toContain("pages/Latest/C/New.md"),
    );
    expect(f.confirm.disabled).toBe(false);
    f.confirm.dispatchEvent({ type: "click" });
    await vi.waitFor(() => expect(f.open).toHaveBeenCalledTimes(2));
    expect(
      new TextDecoder().decode(
        (await f.vault.read("Wiki/pages/Latest/C/New.md"))!,
      ),
    ).toBe("new child");
    expect(f.vault.exists("Wiki/pages/F/C/New.md")).toBe(false);
    const push = f.open.mock.instances.at(-1)!;
    modalButton(push, "确认执行").dispatchEvent({ type: "click" });
    await vi.waitFor(() =>
      expect(
        f.remote.tree().pages.find((p) => p.body === "new child")?.path,
      ).toBe("pages/Latest/C/New.md"),
    );
    expect(f.remote.tree().pages.find((p) => p.pageId === "keep")?.body).toBe(
      "unchanged",
    );
  });
  it("ignores stale async page choices and keeps the latest choice unconfirmable until validated", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([await page("note", "pages/Note.md", "base")]);
    const vault = new MemoryVault({});
    const runtime = new SyncRuntime(vault, new MemoryControlStore(), remote, {
      spaceId: "space",
      rootPath: "Wiki",
      status: "active",
    });
    await runtime.applyPull(await runtime.previewPull());
    vault.seedMarkdown("Wiki/pages/Note.md", "local choice");
    await remote.replace([
      await page("note", "pages/Note.md", "remote choice"),
    ]);
    const f = await openStrategy(runtime);
    const row = f.root.queryAll((e) =>
      e.classes.has("agentwiki-sync-conflict-setting"),
    )[0]!;
    const choice = row.queryAll((e) => e.tag === "select")[0]!;
    const confirm = modalButton(f.modal, "确认执行");
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const localHash = await digest(
      "SHA-256",
      new TextEncoder().encode("local choice"),
    );
    let finishLocal!: (hash: ArrayBuffer) => void;
    let startLocal!: () => void;
    const started = new Promise<void>((resolve) => {
      startLocal = resolve;
    });
    const delayed = new Promise<ArrayBuffer>((resolve) => {
      finishLocal = resolve;
    });
    vi.spyOn(crypto.subtle, "digest").mockImplementation((algorithm, data) => {
      if (new TextDecoder().decode(data) === "local choice") {
        startLocal();
        return delayed;
      }
      return digest(algorithm, data);
    });
    change(choice, "local");
    await started;
    expect(confirm.disabled).toBe(true);
    change(choice, "remote");
    expect(confirm.disabled).toBe(true);
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    change(choice, "");
    expect(confirm.disabled).toBe(true);
    finishLocal(localHash);
    await Promise.resolve();
    await Promise.resolve();
    expect(confirm.disabled).toBe(true);
    change(choice, "remote");
    await vi.waitFor(() => expect(confirm.disabled).toBe(false));
    confirm.dispatchEvent({ type: "click" });
    await vi.waitFor(async () =>
      expect(
        new TextDecoder().decode((await vault.read("Wiki/pages/Note.md"))!),
      ).toBe("remote choice"),
    );
  });
});
