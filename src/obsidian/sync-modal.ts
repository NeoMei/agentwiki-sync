import { Modal, Setting, type App } from "obsidian";

export type SyncAction = "status" | "pull" | "push";

const actionLabels: Record<
  SyncAction,
  { title: string; desc: string; button: string }
> = {
  status: {
    title: "状态",
    desc: "扫描本地文件并与远端版本比较。",
    button: "查看状态",
  },
  pull: {
    title: "拉取",
    desc: "将远端变更下载到本地。执行前会显示预览。",
    button: "继续到预览",
  },
  push: {
    title: "推送",
    desc: "将本地变更发布到远端。执行前会显示预览。",
    button: "继续到预览",
  },
};

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
    const labels = actionLabels[this.action];
    this.contentEl.createEl("h2", { text: labels.title });
    this.contentEl.createEl("p", { text: labels.desc });
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText(labels.button)
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          const original = button.buttonEl.textContent;
          button.setButtonText("执行中…");
          try {
            await this.run();
            this.close();
          } finally {
            button.setDisabled(false);
            button.setButtonText(original ?? labels.button);
          }
        }),
    );
  }
}
