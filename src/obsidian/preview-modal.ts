import { Modal, Setting, type App } from "obsidian";
import type {
  InitialBindingChoice,
  PullPreview,
} from "../application/sync-runtime";

export class PreviewModal extends Modal {
  private released = false;
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
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    const list = this.contentEl.createEl("ul");
    for (const line of this.lines.slice(0, 100))
      list.createEl("li", { text: line });
    if (this.lines.length > 100)
      this.contentEl.createEl("p", {
        text: `${this.lines.length - 100} more actions are hidden from this page.`,
      });
    for (const binding of this.bindings) {
      const setting = new Setting(this.contentEl)
        .setName(`${binding.localPath ?? "new file"} ↔ ${binding.remotePath}`)
        .setDesc(
          "Choose an optional local page, then choose Local, Remote, or manual content. The remote revision remains the exact base.",
        );
      setting.addText((text) =>
        text
          .setPlaceholder("Exact local path (search all candidates)")
          .onChange((value) => {
            const candidate = this.pullPreview?.localCandidates.find(
              (item) => item.path === value,
            );
            if (candidate) {
              binding.localPath = candidate.path;
              binding.localBody = null;
              binding.localVaultByteHash = candidate.vaultByteHash;
              binding.resolution = null;
            }
            const matches = (this.pullPreview?.localCandidates ?? [])
              .filter((item) =>
                item.path
                  .toLocaleLowerCase()
                  .includes(value.toLocaleLowerCase()),
              )
              .slice(0, 20);
            setting.setDesc(
              matches.length
                ? `Matches: ${matches.map((item) => item.path).join(" · ")}`
                : "No matching local path. Leave empty to create/use remote path.",
            );
          }),
      );
      setting.addDropdown((dropdown) => {
        dropdown.addOption("", "Create/use remote path");
        for (const candidate of (this.pullPreview?.localCandidates ?? []).slice(
          0,
          100,
        ))
          dropdown.addOption(candidate.path, candidate.path);
        dropdown.setValue(binding.localPath ?? "").onChange((value) => {
          const candidate = this.pullPreview?.localCandidates.find(
            (item) => item.path === value,
          );
          binding.localPath = candidate?.path ?? null;
          binding.localBody = null;
          binding.localVaultByteHash = candidate?.vaultByteHash ?? null;
          binding.resolution = candidate ? null : "remote";
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
            binding.resolution =
              value === "local" || value === "remote" || value === "manual"
                ? value
                : null;
          }),
      );
      setting.addTextArea((text) =>
        text
          .setPlaceholder("Manual body (used only with Manual body)")
          .onChange((value) => {
            binding.manualBody = value;
          }),
      );
    }
    for (const conflict of this.pullPreview?.conflicts ?? []) {
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
              "Conflict preview unavailable; choose a side or enter the final value manually.",
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
          .onChange((value) => {
            if (!this.pullPreview) return;
            if (value === "local" || value === "remote" || value === "manual")
              this.pullPreview.conflictResolutions[conflict.conflictId] = {
                choice: value,
              };
            else
              delete this.pullPreview.conflictResolutions[conflict.conflictId];
          }),
      );
      setting.addTextArea((text) =>
        text.setPlaceholder("Manual final value").onChange((value) => {
          if (!this.pullPreview) return;
          this.pullPreview.conflictResolutions[conflict.conflictId] = {
            choice: "manual",
            manualValue: value,
          };
        }),
      );
    }
    new Setting(this.contentEl)
      .setDesc("This confirmation applies only to the preview above.")
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
}
