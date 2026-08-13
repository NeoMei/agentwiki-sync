import { Modal, Setting, type App } from "obsidian";
import type {
  InitialBindingChoice,
  PullPreview,
} from "../application/sync-runtime";

const PAGE_SIZE = 100;
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
    if (total <= PAGE_SIZE) return;
    new Setting(this.contentEl)
      .setDesc(
        `Page ${page + 1} / ${Math.ceil(total / PAGE_SIZE)} · ${total} items`,
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
          .setDisabled((page + 1) * PAGE_SIZE >= total)
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
    for (const line of this.lines.slice(0, PAGE_SIZE))
      list.createEl("li", { text: line });
    if (this.lines.length > PAGE_SIZE)
      this.contentEl.createEl("p", {
        text: `${this.lines.length - PAGE_SIZE} more actions are summarized by the paged controls below.`,
      });
    const bindingStart = this.bindingPage * PAGE_SIZE;
    for (const binding of this.bindings.slice(
      bindingStart,
      bindingStart + PAGE_SIZE,
    ))
      this.renderBinding(binding);
    this.pager(this.bindings.length, this.bindingPage, (page) => {
      this.bindingPage = page;
    });
    const conflicts = this.pullPreview?.conflicts ?? [];
    const conflictStart = this.conflictPage * PAGE_SIZE;
    for (const conflict of conflicts.slice(
      conflictStart,
      conflictStart + PAGE_SIZE,
    ))
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
    setting.addText((text) =>
      text
        .setPlaceholder("Exact local path (searches all candidates)")
        .onChange((value) => {
          const candidates = this.pullPreview?.localCandidates ?? [];
          const candidate = candidates.find((item) => item.path === value);
          if (candidate) {
            binding.localPath = candidate.path;
            binding.localVaultByteHash = candidate.vaultByteHash;
            binding.resolution = null;
          }
          const matches = candidates
            .filter((item) =>
              item.path.toLocaleLowerCase().includes(value.toLocaleLowerCase()),
            )
            .slice(0, 20);
          setting.setDesc(
            matches.length
              ? `Matches: ${matches.map((item) => item.path).join(" · ")}`
              : "No matching local path.",
          );
        }),
    );
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "Create/use remote path");
      for (const candidate of (this.pullPreview?.localCandidates ?? []).slice(
        0,
        PAGE_SIZE,
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
      text.setPlaceholder("Manual body").onChange((value) => {
        binding.manualBody = value;
      }),
    );
  }
  private renderConflict(conflict: PullPreview["conflicts"][number]): void {
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
          if (value === "local" || value === "remote" || value === "manual")
            this.pullPreview.conflictResolutions[conflict.conflictId] = {
              choice: value,
            };
          else delete this.pullPreview.conflictResolutions[conflict.conflictId];
        }),
    );
    setting.addTextArea((text) =>
      text.setPlaceholder("Manual final value").onChange((value) => {
        if (this.pullPreview)
          this.pullPreview.conflictResolutions[conflict.conflictId] = {
            choice: "manual",
            manualValue: value,
          };
      }),
    );
  }
}
