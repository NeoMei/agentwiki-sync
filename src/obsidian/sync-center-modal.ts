import { Modal, Notice, Setting, type App } from "obsidian";
import { userErrorMessage } from "../core/user-errors";
import { SyncTargetSelection } from "../application/sync-coordinator";
import { canRunSyncStrategy } from "./preview-logic";
import {
  progressLabel,
  type SyncOperationOptions,
  type SyncProgress,
} from "../application/progress";

export type SyncStrategy = "auto" | "local" | "server";

export interface SyncDiff {
  canPublish: boolean;
  displayName: string;
  rootPath: string;
  roleLabel: string;
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

export interface SyncTarget {
  spaceId: string;
  label: string;
}

export interface SyncCenterHandlers {
  targets: SyncTarget[];
  initialSpaceId: string;
  loadDiff: (
    spaceId: string,
    options: SyncOperationOptions,
  ) => Promise<SyncDiff>;
  runStrategy: (
    spaceId: string,
    strategy: SyncStrategy,
    options: SyncOperationOptions,
  ) => Promise<void>;
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
  private readonly selection: SyncTargetSelection;
  private operation: AbortController | null = null;
  private progress: SyncProgress | null = null;
  private refreshGeneration = 0;

  constructor(
    app: App,
    private readonly handlers: SyncCenterHandlers,
  ) {
    super(app);
    this.selection = new SyncTargetSelection(
      handlers.targets.map((target) => target.spaceId),
      handlers.initialSpaceId,
    );
    this.modalEl.addClass("agentwiki-sync-modal");
  }

  override onOpen(): void {
    void this.refresh();
  }

  override onClose(): void {
    this.operation?.abort();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    this.diff = null;
    this.loadError = null;
    this.running = false;
    this.progress = null;
    this.operation?.abort();
    this.operation = new AbortController();
    this.renderLoading();
    try {
      const diff = await this.handlers.loadDiff(this.selection.current, {
        signal: this.operation.signal,
        onProgress: (progress) => {
          if (generation !== this.refreshGeneration) return;
          this.progress = progress;
          this.renderLoading();
        },
      });
      if (generation !== this.refreshGeneration) return;
      this.diff = diff;
    } catch (error) {
      if (generation !== this.refreshGeneration) return;
      this.loadError = userErrorMessage(error);
    }
    this.render();
  }

  private renderLoading(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "AgentWiki 同步" });
    this.contentEl.createEl("p", {
      text: this.progress
        ? progressLabel(this.progress)
        : "正在比较本地与服务器差异…",
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText("取消")
          .setDisabled(this.progress?.cancellable === false)
          .onClick(() => this.operation?.abort()),
      )
      .addButton((button) =>
        button.setButtonText("关闭").onClick(() => this.close()),
      );
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
    new Setting(this.contentEl)
      .setName("同步空间")
      .setDesc(`${diff.displayName} · ${diff.rootPath} · ${diff.roleLabel}`)
      .addDropdown((dropdown) => {
        for (const target of this.handlers.targets)
          dropdown.addOption(target.spaceId, target.label);
        dropdown
          .setValue(this.selection.current)
          .setDisabled(this.running)
          .onChange((spaceId) => {
            this.selection.select(spaceId);
            void this.refresh();
          });
      });
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
    if (this.progress)
      this.contentEl.createEl("p", { text: progressLabel(this.progress) });

    this.renderLocalSection(diff);
    this.renderRemoteSection(diff);
    this.renderActions(diff);
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

  private renderActions(diff: SyncDiff): void {
    const actions = new Setting(this.contentEl)
      .setDesc(
        "自动合并保留双方不冲突的修改，冲突时可在预览中逐项选择；使用本地/服务器内容会在冲突处直接采用所选一侧。",
      )
      .addButton((button) =>
        button
          .setButtonText(this.running ? "执行中…" : "自动合并（推荐）")
          .setCta()
          .setDisabled(
            this.running || !canRunSyncStrategy(diff.canPublish, "auto"),
          )
          .onClick(() => void this.run("auto")),
      )
      .addButton((button) =>
        button
          .setButtonText("使用本地内容")
          .setDisabled(
            this.running || !canRunSyncStrategy(diff.canPublish, "local"),
          )
          .onClick(() => void this.run("local")),
      )
      .addButton((button) =>
        button
          .setButtonText("使用服务器内容")
          .setDisabled(this.running)
          .onClick(() => void this.run("server")),
      );
    actions.controlEl?.addClass("agentwiki-sync-actions");
    new Setting(this.contentEl).addButton((button) =>
      button
        .setButtonText("刷新差异")
        .setDisabled(this.running)
        .onClick(() => void this.refresh()),
    );
    if (this.running)
      new Setting(this.contentEl).addButton((button) =>
        button
          .setButtonText("取消当前操作")
          .setDisabled(this.progress?.cancellable === false)
          .onClick(() => this.operation?.abort()),
      );
  }

  private async run(strategy: SyncStrategy): Promise<void> {
    if (this.running) return;
    if (!this.diff || !canRunSyncStrategy(this.diff.canPublish, strategy)) {
      new Notice("当前空间不允许该同步策略。");
      return;
    }
    this.running = true;
    this.progress = null;
    this.operation?.abort();
    this.operation = new AbortController();
    this.render();
    try {
      await this.handlers.runStrategy(this.selection.current, strategy, {
        signal: this.operation.signal,
        onProgress: (progress) => {
          this.progress = progress;
          this.render();
        },
      });
      this.close();
    } catch (error) {
      new Notice(`同步失败：${userErrorMessage(error)}`);
      this.running = false;
      this.render();
    }
  }
}
