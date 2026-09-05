import { describe, expect, it } from "vitest";
import { SyncRuntime } from "../../src/application/sync-runtime";
import {
  canonicalBytes,
  contentHash,
  sha256Hex,
} from "../../src/agentwiki/protocol";
import type { TreeAttachment, TreePageV3 } from "../../src/core/tree-model";
import type { ControlStorePort } from "../../src/ports/control-store";
import { FakeTreeRemote, FakeTreeRemoteV3 } from "../fakes/fake-tree-remote";
import { MemoryControlStore } from "../fakes/memory-control-store";
import { MemoryVault } from "../fakes/memory-vault";

const IMAGE = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  ),
  (value) => value.charCodeAt(0),
);
const ATTACHMENT_ID = "11111111-1111-4111-8111-111111111111";
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const mapping = () => ({
  spaceId: "space",
  rootPath: "Wiki",
  status: "pending" as const,
});

class StrictControlStore implements ControlStorePort {
  constructor(readonly backing = new MemoryControlStore()) {}
  private safe(path: string): void {
    if (
      !path.startsWith(".agentwiki/") ||
      path.includes("..") ||
      path.includes("\\")
    )
      throw new TypeError("Unsafe control path");
  }
  read(path: string) {
    this.safe(path);
    return this.backing.read(path);
  }
  write(path: string, value: string) {
    this.safe(path);
    return this.backing.write(path, value);
  }
  readBinary(path: string) {
    this.safe(path);
    return this.backing.readBinary(path);
  }
  writeBinary(path: string, value: Uint8Array) {
    this.safe(path);
    return this.backing.writeBinary(path, value);
  }
  remove(path: string) {
    this.safe(path);
    return this.backing.remove(path);
  }
  rename(from: string, to: string) {
    this.safe(from);
    this.safe(to);
    return this.backing.rename(from, to);
  }
  removeTree(path: string) {
    this.safe(path);
    return this.backing.removeTree(path);
  }
  list(path: string) {
    this.safe(path);
    return this.backing.list(path);
  }
}

function previewSidecar(device: string): string {
  return `.agentwiki/devices/d-${device}/spaces/s-space/tree-preview-body/${PAGE_ID}.md`;
}

async function attachment(): Promise<TreeAttachment> {
  return {
    attachmentId: ATTACHMENT_ID,
    path: "assets/image.png",
    mimeType: "image/png",
    sizeBytes: String(IMAGE.byteLength),
    width: 1,
    height: 1,
    contentHash: await sha256Hex(IMAGE),
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

async function page(
  body: string,
  references: string[] = [],
): Promise<TreePageV3> {
  return {
    pageId: PAGE_ID,
    folderId: null,
    path: "pages/Note.md",
    title: "Note",
    body,
    contentHash: await contentHash(body),
    updatedAt: "2026-09-06T00:00:00.000Z",
    referencedAttachmentIds: references,
  };
}

describe("Pull preview control sidecars", () => {
  it("preserves a local edit when recovering after a completed v3 Pull", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ pages: [await page("remote")] });
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    vault.seedMarkdown("Wiki/pages/Note.md", "local edit");

    const restarted = SyncRuntime.v3(vault, control, remote, mapping());
    await restarted.recover();
    const status = await restarted.statusV3();
    const push = await restarted.previewPushV3();

    expect(vault.text("Wiki/pages/Note.md")).toBe("local edit");
    expect(status.local.modified).toHaveLength(1);
    expect(push.changes).toHaveLength(1);
  });

  it("treats a completed Pull as terminal after a Push replaces the baseline journal", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ pages: [await page("remote")] });
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const first = SyncRuntime.v3(vault, control, remote, mapping());
    await first.applyPullV3(await first.previewPullV3());
    vault.seedMarkdown("Wiki/pages/Note.md", "first local edit");
    await first.applyPushV3(await first.previewPushV3());

    const restarted = SyncRuntime.v3(vault, control, remote, mapping());
    await restarted.recover();
    expect((await restarted.previewPushV3()).changes).toEqual([]);
    vault.seedMarkdown("Wiki/pages/Note.md", "second local edit");
    await restarted.applyPushV3(await restarted.previewPushV3());

    const follower = SyncRuntime.v3(
      new MemoryVault({}),
      new StrictControlStore(),
      remote,
      mapping(),
      "follower",
    );
    const preview = await follower.previewPullV3();
    expect(preview.remote.pages[0]?.body).toBe("second local edit");
  });

  it("fails closed when a committed v3 Pull still has pending control evidence", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ pages: [await page("remote")] });
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    const path =
      ".agentwiki/devices/d-local/spaces/s-space/v3-pull-control-after.json";
    const envelope = JSON.parse(control.backing.files.get(path)!) as {
      payloadHash: string;
      payload: { phase: string };
    };
    envelope.payload.phase = "pending";
    envelope.payloadHash = await sha256Hex(canonicalBytes(envelope.payload));
    control.backing.files.set(path, JSON.stringify(envelope));

    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).recover(),
    ).rejects.toThrow(/V3_PULL_CONTROL_STATE_INCONSISTENT/);
  });

  it("fails closed when a schema-v3 Pull loses its control-after evidence", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ pages: [await page("remote")] });
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const runtime = SyncRuntime.v3(vault, control, remote, mapping());
    await runtime.applyPullV3(await runtime.previewPullV3());
    const path =
      ".agentwiki/devices/d-local/spaces/s-space/v3-pull-control-after.json";
    await Promise.all(
      [path, `${path}.prev`, `${path}.next`].map((candidate) =>
        control.remove(candidate),
      ),
    );

    await expect(
      SyncRuntime.v3(vault, control, remote, mapping()).recover(),
    ).rejects.toThrow(/V3_PULL_CONTROL_RECOVERY_EVIDENCE_MISSING/);
  });

  it("rolls back a non-first verified Pull when baseline preparation never starts", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({
      revision: "rev-before",
      pages: [await page("before")],
    });
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const first = SyncRuntime.v3(vault, control, remote, mapping());
    await first.applyPullV3(await first.previewPullV3());
    await remote.seedTree({
      revision: "rev-after",
      pages: [await page("after")],
    });
    let crashed = false;
    control.backing.onTextWrite = (path) => {
      const value = control.backing.files.get(path) ?? "";
      if (!crashed && value.includes('"state":"verified"')) {
        crashed = true;
        throw new Error("simulated process stop before baseline prepare");
      }
    };

    await expect(
      first.applyPullV3(await first.previewPullV3()),
    ).rejects.toThrow(/simulated process stop/);
    control.backing.onTextWrite = undefined;
    await SyncRuntime.v3(vault, control, remote, mapping()).recover();

    expect(vault.text("Wiki/pages/Note.md")).toBe("before");
  });

  it("keeps v3 sidecars inside .agentwiki for the strict Obsidian control boundary", async () => {
    const remote = new FakeTreeRemoteV3();
    const image = await attachment();
    await remote.seedTree({
      pages: [await page("![[assets/image.png]]", [ATTACHMENT_ID])],
      attachments: [image],
      blobs: { [ATTACHMENT_ID]: IMAGE },
    });
    const vault = new MemoryVault({});
    const runtime = SyncRuntime.v3(
      vault,
      new StrictControlStore(),
      remote,
      mapping(),
    );

    await runtime.applyPullV3(await runtime.previewPullV3());

    expect(await vault.read("Wiki/assets/image.png")).toEqual(IMAGE);
    expect(vault.text("Wiki/pages/Note.md")).toBe("![[assets/image.png]]");
  });

  it("isolates the same page sidecar by device and space", async () => {
    const remote = new FakeTreeRemoteV3();
    await remote.seedTree({ pages: [await page("remote")] });
    const control = new StrictControlStore();
    const first = SyncRuntime.v3(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
      "desktop",
      "space",
    );
    const second = SyncRuntime.v3(
      new MemoryVault({}),
      control,
      remote,
      mapping(),
      "mobile",
      "space",
    );
    control.backing.failNextTextWriteAt =
      ".agentwiki/devices/d-desktop/spaces/s-space/pull/journal.json.next";
    await expect(
      first.applyPullV3(await first.previewPullV3()),
    ).rejects.toThrow(/injected text write failure/);
    control.backing.failNextTextWriteAt =
      ".agentwiki/devices/d-mobile/spaces/s-space/pull/journal.json.next";
    await expect(
      second.applyPullV3(await second.previewPullV3()),
    ).rejects.toThrow(/injected text write failure/);

    expect(control.backing.files.get(previewSidecar("desktop"))).toBe("remote");
    expect(control.backing.files.get(previewSidecar("mobile"))).toBe("remote");
    expect(control.backing.files.has(`tree-preview-body/${PAGE_ID}.md`)).toBe(
      false,
    );
  });

  it("recovers a pre-fix legacy baseline journal and retries with a scoped sidecar", async () => {
    const remote = new FakeTreeRemote();
    await remote.seed([
      {
        pageId: PAGE_ID,
        path: "pages/Note.md",
        title: "Note",
        body: "remote",
        contentHash: await contentHash("remote"),
        updatedAt: "2026-09-06T00:00:00.000Z",
      },
    ]);
    const vault = new MemoryVault({});
    const control = new StrictControlStore();
    const runtime = new SyncRuntime(vault, control, remote, mapping());
    const preview = await runtime.previewPull();
    control.backing.failNextTextWriteAt = previewSidecar("local");
    await expect(runtime.applyPull(preview)).rejects.toThrow(
      /injected text write failure/,
    );

    const restarted = new SyncRuntime(vault, control, remote, mapping());
    await restarted.recover();
    await restarted.applyPull(await restarted.previewPull());

    expect(vault.text("Wiki/pages/Note.md")).toBe("remote");
    expect(control.backing.files.has(`tree-preview-body/${PAGE_ID}.md`)).toBe(
      false,
    );
  });
});
