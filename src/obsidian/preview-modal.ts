import { Modal, Setting, type App } from "obsidian";
import type {
  InitialBindingChoice,
  PullPreview,
} from "../application/sync-runtime";
import type { StructuredConflict } from "../core/merge";
import {
  applyBindingMode,
  applyBindingPath,
  applyBindingSearch,
  applyConflictResolution,
  conflictManualValue,
  pageCount,
  pageSlice,
  PREVIEW_PAGE_SIZE,
} from "./preview-logic";

export class PreviewModal extends Modal {
  private released = false;
  private bindingPage = 0;
  private conflictPage = 0;
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: string[],
    private readonly confirm: () => Promise<void>,
    private readonly release: () => void = () => {},
    private readonly bindings: InitialBindingChoice[] = [],
    private readonly pullPreview: PullPreview | null = null,
  ) {
    super(app);
  }
  onClose(): void {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }
  onOpen(): void {
    this.render();
  }
  private pager(
    total: number,
    page: number,
    setPage: (page: number) => void,
  ): void {
    if (total <= PREVIEW_PAGE_SIZE) return;
    new Setting(this.contentEl)
      .setDesc(
        `Page ${page + 1} / ${pageCount(total)} · ${total} items`,
      )
      .addButton((button) =>
        button
          .setButtonText("Previous")
          .setDisabled(page === 0)
          .onClick(() => {
            setPage(page - 1);
            this.render();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Next")
          .setDisabled((page + 1) * PREVIEW_PAGE_SIZE >= total)
          .onClick(() => {
            setPage(page + 1);
            this.render();
          }),
      );
  }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    const list = this.contentEl.createEl("ul");
    for (const line of pageSlice(this.lines, 0))
      list.createEl("li", { text: line });
    if (this.lines.length > PREVIEW_PAGE_SIZE)
      this.contentEl.createEl("p", {
        text: `${this.lines.length - PREVIEW_PAGE_SIZE} more actions are summarized by the paged controls below.`,
      });
    for (const binding of pageSlice(this.bindings, this.bindingPage))
      this.renderBinding(binding);
    this.pager(this.bindings.length, this.bindingPage, (page) => {
      this.bindingPage = page;
    });
    const conflicts = this.pullPreview?.conflicts ?? [];
    for (const conflict of pageSlice(conflicts, this.conflictPage))
      this.renderConflict(conflict);
    this.pager(conflicts.length, this.conflictPage, (page) => {
      this.conflictPage = page;
    });
    new Setting(this.contentEl)
      .setDesc(
        "This confirmation applies only to the complete preview, including other pages.",
      )
      .addButton((button) =>
        button.setButtonText("Cancel").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("Confirm")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.confirm();
              this.close();
            } finally {
              button.setDisabled(false);
            }
          }),
      );
  }
  private renderBinding(binding: InitialBindingChoice): void {
    const setting = new Setting(this.contentEl)
      .setName(`${binding.localPath ?? "new file"} ↔ ${binding.remotePath}`)
      .setDesc(
        "Choose an optional local page and Local, Remote, or manual content.",
      );
    let searchTouched = false;
    if (binding.remoteBodyPath)
      void this.app.vault.adapter
        .read(binding.remoteBodyPath)
        .then((body) => {
          if (!searchTouched)
            setting.setDesc(`Remote preview: ${body.slice(0, 160)}`);
        })
        .catch(() => {
          if (!searchTouched)
            setting.setDesc("Remote preview unavailable.");
        });
    setting.addText((text) =>
      text
        .setPlaceholder("Exact local path (searches all candidates)")
        .onChange((value) => {
          searchTouched = true;
          const candidates = this.pullPreview?.localCandidates ?? [];
          const matches = applyBindingSearch(binding, candidates, value);
          setting.setDesc(
            matches.length
              ? `Matches: ${matches.join(" · ")}`
              : "No matching local path. Leave empty to create/use remote path.",
          );
        }),
    );
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "Create/use remote path");
      for (const candidate of pageSlice(
        this.pullPreview?.localCandidates ?? [],
        0,
      ))
        dropdown.addOption(candidate.path, candidate.path);
      dropdown.setValue(binding.localPath ?? "").onChange((value) => {
        applyBindingPath(
          binding,
          this.pullPreview?.localCandidates ?? [],
          value,
        );
      });
    });
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "Choose…")
        .addOption("local", "Keep Local")
        .addOption("remote", "Use Remote")
        .addOption("manual", "Manual body")
        .setValue(binding.resolution ?? "")
        .onChange((value) => {
          applyBindingMode(binding, value);
        }),
    );
    setting.addTextArea((text) =>
      text
        .setPlaceholder("Manual body (used only with Manual body)")
        .setValue(binding.manualBody ?? "")
        .onChange((value) => {
          binding.manualBody = value;
        }),
    );
  }
  private renderConflict(conflict: StructuredConflict): void {
    const setting = new Setting(this.contentEl)
      .setName(`${conflict.field}: ${conflict.pageId}`)
      .setDesc("Loading Base / Local / Remote preview…");
    const refs = this.pullPreview?.conflictValuePaths[conflict.conflictId];
    if (refs)
      void Promise.all(
        [refs.base, refs.local, refs.remote].map((path) =>
          this.app.vault.adapter.read(path),
        ),
      )
        .then(([base, local, remote]) =>
          setting.setDesc(
            `Base: ${(base ?? "").slice(0, 120)} · Local: ${(local ?? "").slice(0, 120)} · Remote: ${(remote ?? "").slice(0, 120)}`,
          ),
        )
        .catch(() =>
          setting.setDesc(
            "Conflict preview unavailable; choose a side or enter a manual value.",
          ),
        );
    else
      setting.setDesc(
        `Base: ${conflict.base.slice(0, 120)} · Local: ${conflict.local.slice(0, 120)} · Remote: ${conflict.remote.slice(0, 120)}`,
      );
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "Resolve…")
        .addOption("local", "Keep Local")
        .addOption("remote", "Use Remote")
        .addOption("manual", "Manual value")
        .setValue(
          this.pullPreview?.conflictResolutions[conflict.conflictId]?.choice ??
            "",
        )
        .onChange((value) => {
          if (!this.pullPreview) return;
          applyConflictResolution(
            this.pullPreview,
            conflict.conflictId,
            value,
            conflictManualValue(this.pullPreview, conflict.conflictId),
          );
        }),
    );
    setting.addTextArea((text) =>
      text
        .setPlaceholder("Manual final value")
        .setValue(
          this.pullPreview
            ? conflictManualValue(this.pullPreview, conflict.conflictId)
            : "",
        )
        .onChange((value) => {
          if (this.pullPreview)
            applyConflictResolution(
              this.pullPreview,
              conflict.conflictId,
              "manual",
              value,
            );
        }),
    );
  }
}
