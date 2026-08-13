import { Modal, Setting, type App } from "obsidian";

export type SyncAction = "status" | "pull" | "push";
export class SyncModal extends Modal {
  constructor(
    app: App,
    private readonly action: SyncAction,
    private readonly run: () => Promise<void>,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", {
      text: this.action[0]!.toUpperCase() + this.action.slice(1),
    });
    this.contentEl.createEl("p", {
      text:
        this.action === "status"
          ? "Scan local files and compare the remote revision."
          : "Review is required before any files or remote pages change.",
    });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(
          this.action === "status" ? "Run status" : "Continue to preview",
        )
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          try {
            await this.run();
          } finally {
            button.setDisabled(false);
          }
        }),
    );
  }
}
