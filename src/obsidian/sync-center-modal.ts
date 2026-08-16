import { Modal, Notice, Setting, type App } from "obsidian";
import { userErrorMessage } from "../core/user-errors";

export type SyncStrategy = "auto" | "local" | "server";

export interface SyncDiff {
  remoteAhead: boolean;
  localAdded: string[];
  localModified: string[];
  localRenamed: string[];
  localDeleted: string[];
  remoteUpdated: string[];
  remoteArchived: string[];
  remoteListed: boolean;
  remoteFirstBind: boolean;
}

export interface SyncCenterHandlers {
  loadDiff: () => Promise<SyncDiff>;
  runStrategy: (strategy: SyncStrategy) => Promise<void>;
}

const countDiff = (diff: SyncDiff): number =>
  diff.localAdded.length +
  diff.localModified.length +
  diff.localRenamed.length +
  diff.localDeleted.length;

export class SyncCenterModal extends Modal {
  private diff: SyncDiff | null = null;
  private loadError: string | null = null;
  private running: boolean = false;

  constructor(
    app: App,
    private readonly handlers: SyncCenterHandlers,
  ) {
    super(app);
  }

  override onOpen(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    this.diff = null;
    this.loadError = null;
    this.running = false;
    this.renderLoading();
    try {
      this.diff = await this.handlers.loadDiff();
    } catch (error) {
      this.loadError = userErrorMessage(error);
    }
    this.render();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "AgentWiki 同步" });
    this.contentEl.createEl("p", { text: "正在比较本地与服务器差异…" });
  }

  private render(): void {
    this.contentEl.empty();
    if (this.loadError) {
      this.renderError();
      return;
    }
    const diff = this.diff;
    if (!diff) return;
    this.contentEl.createEl("h2", { text: "AgentWiki 同步" });
    const localCount = countDiff(diff);
    const remoteCount = diff.remoteUpdated.length + diff.remoteArchived.length;
    let summary: string;
    if (diff.remoteAhead) {
      summary =
        remoteCount > 0 && diff.remoteListed
          ? `本地 ${localCount} 处变更 · 服务器 ${remoteCount} 处更新`
          : "服务器有更新";
    } else {
      summary =
        localCount > 0
          ? `本地 ${localCount} 处变更 · 服务器已是基线版本`
          : "本地与服务器已同步，无需操作。";
    }
    this.contentEl.createEl("p", {
      text: summary,
      cls: "agentwiki-sync-summary",
    });

    this.renderLocalSection(diff);
    this.renderRemoteSection(diff);
    this.renderActions();
  }

  private renderError(): void {
    this.contentEl.createEl("h2", { text: "AgentWiki 同步" });
    this.contentEl.createEl("p", {
      text: `加载差异失败：${this.loadError}`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText("重试").onClick(() => void this.refresh()),
      )
      .addButton((button) =>
        button.setButtonText("关闭").onClick(() => this.close()),
      );
  }

  private renderLocalSection(diff: SyncDiff): void {
    new Setting(this.contentEl).setName("本地变更").setHeading();
    if (countDiff(diff) === 0) {
      this.contentEl.createEl("p", { text: "本地没有未推送的变更。" });
      return;
    }
    const list = this.contentEl.createEl("ul");
    for (const path of diff.localAdded)
      list.createEl("li", { text: `+ ${path}` });
    for (const path of diff.localModified)
      list.createEl("li", { text: `~ ${path}` });
    for (const path of diff.localRenamed)
      list.createEl("li", { text: `→ ${path}` });
    for (const path of diff.localDeleted)
      list.createEl("li", { text: `- ${path}` });
  }

  private renderRemoteSection(diff: SyncDiff): void {
    new Setting(this.contentEl).setName("服务器变更").setHeading();
    if (!diff.remoteAhead) {
      this.contentEl.createEl("p", { text: "服务器没有新的变更。" });
      return;
    }
    if (diff.remoteFirstBind) {
      this.contentEl.createEl("p", {
        text: "首次同步：服务器内容将在拉取时与本地文件建立对应关系。",
      });
      return;
    }
    if (
      !diff.remoteListed ||
      diff.remoteUpdated.length + diff.remoteArchived.length === 0
    ) {
      this.contentEl.createEl("p", {
        text: diff.remoteListed
          ? "服务器变更已与合并基线一致。"
          : "服务器有更新（明细暂时不可用，可在合并预览中查看）。",
      });
      return;
    }
    const list = this.contentEl.createEl("ul");
    for (const path of diff.remoteUpdated)
      list.createEl("li", { text: `↑ ${path}` });
    for (const path of diff.remoteArchived)
      list.createEl("li", { text: `✕ ${path}` });
  }

  private renderActions(): void {
    new Setting(this.contentEl)
      .setDesc(
        "自动合并保留双方不冲突的修改，冲突时可在预览中逐项选择；使用本地/服务器内容会在冲突处直接采用所选一侧。",
      )
      .addButton((button) =>
        button
          .setButtonText(this.running ? "执行中…" : "自动合并（推荐）")
          .setCta()
          .setDisabled(this.running)
          .onClick(() => void this.run("auto")),
      )
      .addButton((button) =>
        button
          .setButtonText("使用本地内容")
          .setDisabled(this.running)
          .onClick(() => void this.run("local")),
      )
      .addButton((button) =>
        button
          .setButtonText("使用服务器内容")
          .setDisabled(this.running)
          .onClick(() => void this.run("server")),
      );
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("刷新差异")
        .setDisabled(this.running)
        .onClick(() => void this.refresh()),
    );
  }

  private async run(strategy: SyncStrategy): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.render();
    try {
      await this.handlers.runStrategy(strategy);
      this.close();
    } catch (error) {
      new Notice(`同步失败：${userErrorMessage(error)}`);
      this.running = false;
      this.render();
    }
  }
}
