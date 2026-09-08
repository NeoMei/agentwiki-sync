import {
  Modal,
  Notice,
  Setting,
  type App,
  type ButtonComponent,
  type TextAreaComponent,
} from "obsidian";
import { userErrorMessage } from "../core/user-errors";
import type {
  InitialBindingChoice,
  PullPreview,
  PushPreviewV3,
} from "../application/sync-runtime";
import type {
  AttachmentConflict,
  FolderConflict,
  StructuredConflict,
} from "../core/merge";
import type { TreePullPreviewV3 } from "../application/tree-diff";
import type { TreeContentV3 } from "../core/tree-validation";

type CalculationPreviewV3 = TreePullPreviewV3<TreeContentV3>;
import type { TreeBootstrapPreviewV3 } from "../ports/tree-remote";
import {
  resolveAttachmentConflict,
  resolveFolderConflictV3,
  resolvePageConflictV3,
} from "../application/tree-diff";
import {
  attachmentConflictResolutionComplete,
  applyFolderConflictResolution,
  applyBindingMode,
  applyBindingPath,
  applyBindingSearch,
  applyConflictResolution,
  bindingsRequiringInput,
  clampPage,
  conflictManualValue,
  folderConflictManualValue,
  folderConflictValidationError,
  pendingPreviewDecisionCount,
  pageCount,
  pageSlice,
  PREVIEW_PAGE_SIZE,
  canConfirmV3Push,
  localImageRepairLines,
} from "./preview-logic";
import {
  progressLabel,
  type SyncOperationOptions,
} from "../application/progress";
import { completeModalAction, type ModalTransition } from "./modal-handoff";

type PreviewState =
  | PullPreview
  | CalculationPreviewV3
  | TreeBootstrapPreviewV3
  | PushPreviewV3
  | null;

export interface PreviewModalActionOptions {
  closeLabel?: string;
  files?: { path: string; open: () => Promise<void> }[];
  confirmLabel?: string;
  canConfirm?: () => boolean;
  disabledReason?: string;
  subscribeInvalidation?: (listener: () => void) => () => void;
}

interface AttachmentResolutionDraft {
  mode: "" | "local" | "remote" | "keep_both";
  primary: "local" | "remote";
  secondaryAttachmentId: string;
  secondaryPath: string;
  redirectPageIds: Set<string>;
}

function isPullPreview(
  preview: PreviewState,
): preview is PullPreview | CalculationPreviewV3 {
  return !!preview && "folderConflicts" in preview;
}

function isPullPreviewV3(
  preview: PreviewState,
): preview is CalculationPreviewV3 {
  return isPullPreview(preview) && "attachmentConflicts" in preview;
}

function isBlockedPushPreview(
  preview: PreviewState,
): preview is Extract<PushPreviewV3, { publishable: false }> {
  return !!preview && "publishable" in preview && !preview.publishable;
}

export class PreviewModal extends Modal {
  private released = false;
  private linePage = 0;
  private bindingPage = 0;
  private conflictPage = 0;
  private folderConflictPage = 0;
  private attachmentConflictPage = 0;
  private readonly folderManualDrafts = new Map<string, string>();
  private readonly pageManualDrafts = new Map<string, string>();
  private readonly attachmentDrafts = new Map<
    string,
    AttachmentResolutionDraft
  >();
  private readonly decisionGenerations = new Map<string, number>();
  private readonly unsettledDecisions = new Set<string>();
  private readonly resolutionSourcePreview: CalculationPreviewV3 | null;
  private resolutionQueue: Promise<void> = Promise.resolve();
  private operation: AbortController | null = null;
  private running = false;
  private closeRequested = false;
  private refreshCurrentActionState: (() => void) | null = null;
  private refreshCurrentSummary: (() => void) | null = null;
  private unsubscribeInvalidation: (() => void) | null = null;
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: readonly string[] | (() => readonly string[]),
    private readonly confirm: (
      options: SyncOperationOptions,
    ) => Promise<ModalTransition | void>,
    private readonly release: () => void = () => {},
    private readonly bindings: InitialBindingChoice[] = [],
    private readonly preview: PreviewState = null,
    private readonly actionOptions: PreviewModalActionOptions = {},
  ) {
    super(app);
    this.resolutionSourcePreview = isPullPreviewV3(preview)
      ? structuredClone(preview)
      : null;
    this.modalEl.addClass("agentwiki-sync-modal");
  }
  onClose(): void {
    this.unsubscribeInvalidation?.();
    this.unsubscribeInvalidation = null;
    this.operation?.abort();
    if (this.running) {
      this.closeRequested = true;
      return;
    }
    this.releaseOnce();
  }
  private releaseOnce(): void {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }
  onOpen(): void {
    this.render();
    this.unsubscribeInvalidation =
      this.actionOptions.subscribeInvalidation?.(() => this.render()) ?? null;
  }
  private pager(
    container: HTMLElement,
    total: number,
    page: number,
    setPage: (page: number) => void,
  ): void {
    if (total <= PREVIEW_PAGE_SIZE) return;
    new Setting(container)
      .setDesc(`第 ${page + 1} / ${pageCount(total)} 页 · 共 ${total} 项`)
      .addButton((button) =>
        button
          .setButtonText("上一页")
          .setDisabled(page === 0)
          .onClick(() => {
            setPage(page - 1);
            this.render();
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("下一页")
          .setDisabled((page + 1) * PREVIEW_PAGE_SIZE >= total)
          .onClick(() => {
            setPage(page + 1);
            this.render();
          }),
      );
  }
  private clearDecision(
    key: string,
    clearResolution: () => void,
    refreshActionState: () => void,
  ): number {
    const generation = (this.decisionGenerations.get(key) ?? 0) + 1;
    this.decisionGenerations.set(key, generation);
    this.unsettledDecisions.add(key);
    clearResolution();
    refreshActionState();
    return generation;
  }
  private queueDecision(
    key: string,
    clearResolution: () => void,
    resolve: (candidate: CalculationPreviewV3) => Promise<void>,
    refreshActionState: () => void,
  ): void {
    const generation = this.clearDecision(
      key,
      clearResolution,
      refreshActionState,
    );
    const work = this.resolutionQueue.then(async () => {
      if (this.decisionGenerations.get(key) !== generation) return;
      if (!isPullPreviewV3(this.preview) || !this.resolutionSourcePreview)
        return;
      const candidate = structuredClone(this.resolutionSourcePreview);
      candidate.pageConflictResolutions = structuredClone(
        this.preview.pageConflictResolutions,
      );
      candidate.folderConflictResolutions = structuredClone(
        this.preview.folderConflictResolutions,
      );
      candidate.attachmentConflictResolutions = structuredClone(
        this.preview.attachmentConflictResolutions,
      );
      await resolve(candidate);
      if (this.decisionGenerations.get(key) === generation) {
        this.installResolvedPreview(candidate);
        this.unsettledDecisions.delete(key);
      }
    });
    this.resolutionQueue = work.catch(() => undefined);
    void work
      .catch((error) => new Notice(userErrorMessage(error)))
      .finally(() => this.refreshCurrentActionState?.());
  }
  private installResolvedPreview(candidate: CalculationPreviewV3): void {
    if (!isPullPreviewV3(this.preview)) return;
    this.preview.actions = candidate.actions;
    this.preview.blockers = candidate.blockers;
    this.preview.attachmentConflicts = candidate.attachmentConflicts;
    this.preview.attachmentConflictResolutions =
      candidate.attachmentConflictResolutions;
    this.preview.folderConflicts = candidate.folderConflicts;
    this.preview.folderConflictResolutions =
      candidate.folderConflictResolutions;
    this.preview.pageConflicts = candidate.pageConflicts;
    this.preview.pageConflictResolutions = candidate.pageConflictResolutions;
    this.preview.pagePlan = candidate.pagePlan;
    this.preview.attachmentPlan = candidate.attachmentPlan;
    this.preview.resolvedFolders = candidate.resolvedFolders;
    this.preview.resolvedPages = candidate.resolvedPages;
    this.preview.resolvedAttachments = candidate.resolvedAttachments;
    this.refreshCurrentSummary?.();
  }
  private unsettledDecisionCount(): number {
    if (!isPullPreviewV3(this.preview)) return 0;
    let count = 0;
    for (const key of this.unsettledDecisions) {
      const separator = key.indexOf(":");
      const kind = key.slice(0, separator);
      const conflictId = key.slice(separator + 1);
      const alreadyCounted =
        kind === "page"
          ? this.preview.pageConflicts.some(
              (conflict) => conflict.conflictId === conflictId,
            ) && !this.preview.pageConflictResolutions[conflictId]
          : kind === "folder"
            ? this.preview.folderConflicts.some(
                (conflict) => conflict.conflictId === conflictId,
              ) && !this.preview.folderConflictResolutions[conflictId]
            : this.preview.attachmentConflicts.some(
                (conflict) => conflict.conflictId === conflictId,
              ) && !this.preview.attachmentConflictResolutions[conflictId];
      if (!alreadyCounted) count += 1;
    }
    return count;
  }
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.renderBlockers();
    const summary = this.contentEl.createDiv({
      cls: "agentwiki-sync-preview-summary",
    });
    const refreshSummary = () => {
      summary.empty();
      const originalLines =
        typeof this.lines === "function" ? this.lines() : this.lines;
      const localLines =
        this.preview &&
        ("normalizedPush" in this.preview || isPullPreviewV3(this.preview))
          ? localImageRepairLines(this.preview)
          : [];
      const lines = [
        ...localLines,
        ...originalLines,
        ...(this.actionOptions.files ?? []),
      ];
      this.linePage = clampPage(this.linePage, lines.length);
      const list = summary.createEl("ul");
      for (const line of pageSlice(lines, this.linePage)) {
        if (typeof line === "string") list.createEl("li", { text: line });
        else
          new Setting(list.createEl("li")).addButton((button) =>
            button.setButtonText(`查看文件：${line.path}`).onClick(async () => {
              try {
                await line.open();
              } catch (error) {
                new Notice(`打开文件失败：${userErrorMessage(error)}`);
              }
            }),
          );
      }
      this.pager(summary, lines.length, this.linePage, (page) => {
        this.linePage = page;
        refreshSummary();
      });
    };
    this.refreshCurrentSummary = refreshSummary;
    refreshSummary();
    const pendingDecisionCount = () =>
      isPullPreview(this.preview)
        ? pendingPreviewDecisionCount(this.bindings, this.preview) +
          this.unsettledDecisionCount()
        : isBlockedPushPreview(this.preview)
          ? this.preview.blockers.length
          : this.preview && "mode" in this.preview
            ? this.preview.blockers.length
            : 0;
    const canConfirm = () =>
      this.actionOptions.canConfirm?.() !== false &&
      (!this.preview ||
        !("normalizedPush" in this.preview) ||
        canConfirmV3Push(this.preview));
    const actionDescription = () => {
      const pending = pendingDecisionCount();
      if (!canConfirm())
        return (
          this.actionOptions.disabledReason ??
          "当前预览不可确认，请刷新后重试。"
        );
      return pending > 0
        ? `还有 ${pending} 项待处理，完成选择后才能执行。`
        : "确认将应用全部变更（包括其他分页）。";
    };
    const actions = new Setting(this.contentEl).setDesc(actionDescription());
    actions.settingEl.addClass("agentwiki-sync-preview-actions");
    let cancelButton: ButtonComponent | null = null;
    let confirmButton: ButtonComponent | null = null;
    const refreshActionState = () => {
      actions.setDesc(actionDescription());
      confirmButton?.setDisabled(
        this.running || pendingDecisionCount() > 0 || !canConfirm(),
      );
    };
    this.refreshCurrentActionState = refreshActionState;
    actions
      .addButton((button) => {
        cancelButton = button;
        button
          .setButtonText(this.actionOptions.closeLabel ?? "取消")
          .onClick(() => {
            if (this.running && this.actionOptions.closeLabel) return;
            if (this.running) this.operation?.abort();
            else this.close();
          });
      })
      .addButton((button) => {
        confirmButton = button;
        button
          .setButtonText(
            this.actionOptions.confirmLabel ??
              (this.preview &&
              "normalizedPush" in this.preview &&
              this.preview.normalizedPush?.plan.mode === "local_only"
                ? "确认修正本地链接"
                : "确认执行"),
          )
          .setWarning()
          .setDisabled(
            this.running || pendingDecisionCount() > 0 || !canConfirm(),
          )
          .onClick(async () => {
            if (this.running || !canConfirm()) return;
            const pending = pendingDecisionCount();
            if (pending > 0) {
              new Notice(`还有 ${pending} 项待处理，请先完成选择。`);
              refreshActionState();
              return;
            }
            this.running = true;
            if (this.actionOptions.closeLabel) cancelButton?.setDisabled(true);
            this.operation = new AbortController();
            button.setDisabled(true);
            let completed = false;
            try {
              await completeModalAction(
                () =>
                  this.confirm({
                    signal: this.operation!.signal,
                    onProgress: (progress) => {
                      actions.setDesc(progressLabel(progress));
                      cancelButton?.setDisabled(
                        !!this.actionOptions.closeLabel ||
                          !progress.cancellable,
                      );
                    },
                  }),
                () => {
                  this.operation = null;
                  this.close();
                },
              );
              completed = true;
            } catch (error) {
              new Notice(`同步失败：${userErrorMessage(error)}`);
            } finally {
              this.running = false;
              this.operation = null;
              if (!completed) refreshActionState();
              cancelButton?.setDisabled(false);
              if (this.closeRequested) this.releaseOnce();
            }
          });
      });
    const pendingBindings = bindingsRequiringInput(this.bindings);
    this.bindingPage = clampPage(this.bindingPage, pendingBindings.length);
    for (const binding of pageSlice(pendingBindings, this.bindingPage))
      this.renderBinding(binding, refreshActionState);
    this.pager(
      this.contentEl,
      pendingBindings.length,
      this.bindingPage,
      (page) => {
        this.bindingPage = page;
      },
    );
    const conflicts = isPullPreview(this.preview)
      ? "attachmentConflicts" in this.preview
        ? this.preview.pageConflicts
        : this.preview.conflicts
      : [];
    for (const conflict of pageSlice(conflicts, this.conflictPage))
      this.renderConflict(conflict, refreshActionState);
    this.pager(this.contentEl, conflicts.length, this.conflictPage, (page) => {
      this.conflictPage = page;
    });
    const folderConflicts = isPullPreview(this.preview)
      ? this.preview.folderConflicts
      : [];
    this.folderConflictPage = clampPage(
      this.folderConflictPage,
      folderConflicts.length,
    );
    for (const conflict of pageSlice(folderConflicts, this.folderConflictPage))
      this.renderFolderConflict(conflict, refreshActionState);
    this.pager(
      this.contentEl,
      folderConflicts.length,
      this.folderConflictPage,
      (page) => {
        this.folderConflictPage = page;
      },
    );
    const attachmentConflicts = isPullPreviewV3(this.preview)
      ? this.preview.attachmentConflicts
      : [];
    this.attachmentConflictPage = clampPage(
      this.attachmentConflictPage,
      attachmentConflicts.length,
    );
    for (const conflict of pageSlice(
      attachmentConflicts,
      this.attachmentConflictPage,
    ))
      this.renderAttachmentConflict(conflict, refreshActionState);
    this.pager(
      this.contentEl,
      attachmentConflicts.length,
      this.attachmentConflictPage,
      (page) => {
        this.attachmentConflictPage = page;
      },
    );
  }

  private renderBlockers(): void {
    if (isBlockedPushPreview(this.preview)) {
      const blockers = this.contentEl.createDiv({
        cls: "agentwiki-sync-blockers",
      });
      blockers.createEl("h3", { text: "图片阻塞项" });
      const list = blockers.createEl("ul");
      for (const blocker of this.preview.blockers)
        list.createEl("li", {
          text: `${blocker.pagePath ?? blocker.path ?? "Page"}: ${userErrorMessage(new Error(blocker.code))}`,
        });
      return;
    }
    if (
      this.preview &&
      "mode" in this.preview &&
      this.preview.blockers.length
    ) {
      const blockers = this.contentEl.createDiv({
        cls: "agentwiki-sync-blockers",
      });
      blockers.createEl("h3", { text: "需先处理" });
      const list = blockers.createEl("ul");
      for (const blocker of this.preview.blockers)
        list.createEl("li", {
          text: `${blocker.pageId}: ${userErrorMessage(new Error(blocker.code))}`,
        });
    }
    if (!isPullPreviewV3(this.preview) || !this.preview.blockers.length) return;
    const blockers = this.contentEl.createDiv({
      cls: "agentwiki-sync-blockers",
    });
    blockers.createEl("h3", { text: "图片阻塞项" });
    const list = blockers.createEl("ul");
    for (const blocker of this.preview.blockers) {
      const location =
        "pagePath" in blocker
          ? (blocker.pagePath ?? "Page")
          : "pageId" in blocker
            ? `Page ${blocker.pageId}`
            : "Page";
      list.createEl("li", {
        text: `${location}: ${userErrorMessage(new Error(blocker.code))}`,
      });
    }
  }
  private renderBinding(
    binding: InitialBindingChoice,
    refreshActionState: () => void,
  ): void {
    const setting = new Setting(this.contentEl)
      .setName(`${binding.localPath ?? "新文件"} ↔ ${binding.remotePath}`)
      .setDesc("选择本地文件对应关系，或使用远端版本。");
    setting.settingEl.addClass("agentwiki-sync-preview-setting");
    setting.settingEl.addClass("agentwiki-sync-binding-setting");
    setting.controlEl?.addClass("agentwiki-sync-resolution-controls");
    let searchTouched = false;
    if (binding.remoteBodyPath)
      void this.app.vault.adapter
        .read(binding.remoteBodyPath)
        .then((body) => {
          if (!searchTouched)
            setting.setDesc(`远端内容预览：${body.slice(0, 160)}`);
        })
        .catch(() => {
          if (!searchTouched) setting.setDesc("无法加载远端预览。");
        });
    setting.addText((text) =>
      text.setPlaceholder("输入本地文件路径（支持搜索）").onChange((value) => {
        searchTouched = true;
        const candidates =
          this.preview && "localCandidates" in this.preview
            ? this.preview.localCandidates
            : [];
        const matches = applyBindingSearch(binding, candidates, value);
        refreshActionState();
        setting.setDesc(
          matches.length
            ? `匹配：${matches.join(" · ")}`
            : "未找到匹配的本地文件。留空则使用远端路径。",
        );
      }),
    );
    setting.addDropdown((dropdown) => {
      dropdown.addOption("", "使用远端路径");
      const visibleCandidates = pageSlice(
        this.preview && "localCandidates" in this.preview
          ? this.preview.localCandidates
          : [],
        0,
      );
      for (const candidate of visibleCandidates)
        dropdown.addOption(candidate.path, candidate.path);
      if (
        binding.localPath &&
        !visibleCandidates.some(
          (candidate) => candidate.path === binding.localPath,
        )
      )
        dropdown.addOption(binding.localPath, binding.localPath);
      dropdown.setValue(binding.localPath ?? "").onChange((value) => {
        applyBindingPath(
          binding,
          this.preview && "localCandidates" in this.preview
            ? this.preview.localCandidates
            : [],
          value,
        );
        refreshActionState();
      });
    });
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "请选择…")
        .addOption("local", "保留本地")
        .addOption("remote", "使用远端")
        .addOption("manual", "手动内容")
        .setValue(binding.resolution ?? "")
        .onChange((value) => {
          applyBindingMode(binding, value);
          refreshActionState();
        }),
    );
    setting.addTextArea((text) =>
      text
        .setPlaceholder("手动内容（选择手动模式时生效）")
        .setValue(binding.manualBody ?? "")
        .onChange((value) => {
          binding.manualBody = value;
        }),
    );
  }
  private renderConflict(
    conflict: StructuredConflict,
    refreshActionState: () => void,
  ): void {
    const setting = new Setting(this.contentEl)
      .setName(`${conflict.field}: ${conflict.pageId}`)
      .setDesc(
        `原版：${conflict.base} · 本地：${conflict.local} · 远端：${conflict.remote}`,
      );
    setting.settingEl.addClass("agentwiki-sync-preview-setting");
    setting.settingEl.addClass("agentwiki-sync-conflict-setting");
    setting.controlEl?.addClass("agentwiki-sync-resolution-controls");
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "请选择…")
        .addOption("local", "保留本地")
        .addOption("remote", "使用远端")
        .addOption("manual", "手动内容")
        .setValue(
          isPullPreview(this.preview)
            ? "attachmentConflicts" in this.preview
              ? (this.preview.pageConflictResolutions[conflict.conflictId]
                  ?.choice ?? "")
              : (this.preview.conflictResolutions[conflict.conflictId]
                  ?.choice ?? "")
            : "",
        )
        .onChange((value) => {
          if (!isPullPreview(this.preview)) return;
          if ("attachmentConflicts" in this.preview) {
            const preview = this.preview;
            const key = `page:${conflict.conflictId}`;
            if (value === "manual") {
              this.pageManualDrafts.set(
                conflict.conflictId,
                this.pageManualDrafts.get(conflict.conflictId) ?? "",
              );
              this.clearDecision(
                key,
                () =>
                  delete preview.pageConflictResolutions[conflict.conflictId],
                refreshActionState,
              );
            } else if (value !== "local" && value !== "remote")
              this.clearDecision(
                key,
                () =>
                  delete preview.pageConflictResolutions[conflict.conflictId],
                refreshActionState,
              );
            else {
              const choice = value;
              this.queueDecision(
                key,
                () =>
                  delete preview.pageConflictResolutions[conflict.conflictId],
                (candidate) =>
                  resolvePageConflictV3(candidate, conflict.conflictId, {
                    choice,
                  }),
                refreshActionState,
              );
            }
          } else {
            applyConflictResolution(
              this.preview,
              conflict.conflictId,
              value,
              conflictManualValue(this.preview, conflict.conflictId),
            );
            refreshActionState();
          }
        }),
    );
    setting.addTextArea((text) =>
      text
        .setPlaceholder("手动输入最终内容")
        .setValue(
          isPullPreview(this.preview)
            ? "attachmentConflicts" in this.preview
              ? (this.pageManualDrafts.get(conflict.conflictId) ?? "")
              : conflictManualValue(this.preview, conflict.conflictId)
            : "",
        )
        .onChange((value) => {
          if (isPullPreview(this.preview)) {
            if ("attachmentConflicts" in this.preview) {
              this.pageManualDrafts.set(conflict.conflictId, value);
              const preview = this.preview;
              this.clearDecision(
                `page:${conflict.conflictId}`,
                () =>
                  delete preview.pageConflictResolutions[conflict.conflictId],
                refreshActionState,
              );
              return;
            }
            applyConflictResolution(
              this.preview,
              conflict.conflictId,
              "manual",
              value,
            );
            refreshActionState();
          }
        }),
    );
    if (isPullPreviewV3(this.preview))
      setting.addButton((button) =>
        button.setButtonText("应用手动内容").onClick(() => {
          if (!isPullPreviewV3(this.preview)) return;
          const preview = this.preview;
          const manualValue =
            this.pageManualDrafts.get(conflict.conflictId) ?? "";
          this.queueDecision(
            `page:${conflict.conflictId}`,
            () => delete preview.pageConflictResolutions[conflict.conflictId],
            (candidate) =>
              resolvePageConflictV3(candidate, conflict.conflictId, {
                choice: "manual",
                manualValue,
              }),
            refreshActionState,
          );
        }),
      );
  }

  private renderFolderConflict(
    conflict: FolderConflict,
    refreshActionState: () => void,
  ): void {
    const preview = this.preview;
    if (!isPullPreview(preview)) return;
    const baseDescription = `原位置：${conflict.basePath ?? "无"} · 本地：${conflict.localPath ?? "无"} · 服务器：${conflict.remotePath ?? "无"}`;
    const setting = new Setting(this.contentEl)
      .setName(`目录：${conflict.folderId}`)
      .setDesc(baseDescription);
    setting.settingEl.addClass("agentwiki-sync-preview-setting");
    setting.settingEl.addClass("agentwiki-sync-folder-setting");
    setting.controlEl?.addClass("agentwiki-sync-resolution-controls");

    const draftValue = () =>
      this.folderManualDrafts.get(conflict.conflictId) ??
      ("attachmentConflicts" in preview
        ? preview.folderConflictResolutions[conflict.conflictId]?.choice ===
          "manual"
          ? (preview.folderConflictResolutions[conflict.conflictId]
              ?.manualPath ?? "")
          : ""
        : folderConflictManualValue(preview, conflict.conflictId));
    const showValidation = (value: string) => {
      const error =
        "attachmentConflicts" in preview
          ? value.trim()
            ? null
            : "请填写目标路径。"
          : folderConflictValidationError(preview, conflict.conflictId, value);
      setting.setDesc(
        error ? `${baseDescription}（错误：${error}）` : baseDescription,
      );
    };
    let textArea: TextAreaComponent | null = null;

    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "请选择…")
        .addOption("local", "保留本地位置")
        .addOption("remote", "使用服务器位置")
        .addOption("manual", "手动输入最终路径")
        .setValue(
          preview.folderConflictResolutions[conflict.conflictId]?.choice ?? "",
        )
        .onChange((value) => {
          if (value === "manual") {
            const current = draftValue();
            this.folderManualDrafts.set(conflict.conflictId, current);
            if ("attachmentConflicts" in preview) {
              this.clearDecision(
                `folder:${conflict.conflictId}`,
                () =>
                  delete preview.folderConflictResolutions[conflict.conflictId],
                refreshActionState,
              );
            } else
              applyFolderConflictResolution(
                preview,
                conflict.conflictId,
                "manual",
                current,
              );
            showValidation(current);
            textArea?.setDisabled(false);
          } else {
            this.folderManualDrafts.delete(conflict.conflictId);
            if (
              "attachmentConflicts" in preview &&
              (value === "local" || value === "remote")
            ) {
              const choice = value;
              this.queueDecision(
                `folder:${conflict.conflictId}`,
                () =>
                  delete preview.folderConflictResolutions[conflict.conflictId],
                (candidate) =>
                  resolveFolderConflictV3(candidate, conflict.conflictId, {
                    choice,
                  }),
                refreshActionState,
              );
            } else if (!("attachmentConflicts" in preview))
              applyFolderConflictResolution(
                preview,
                conflict.conflictId,
                value,
              );
            setting.setDesc(baseDescription);
            textArea?.setDisabled(true);
          }
          refreshActionState();
        }),
    );
    setting.addTextArea((text) => {
      textArea = text;
      text
        .setPlaceholder("手动输入最终目录路径（例如 pages/新目录）")
        .setValue(draftValue())
        .setDisabled(
          preview.folderConflictResolutions[conflict.conflictId]?.choice !==
            "manual",
        )
        .onChange((value) => {
          this.folderManualDrafts.set(conflict.conflictId, value);
          if ("attachmentConflicts" in preview) {
            this.clearDecision(
              `folder:${conflict.conflictId}`,
              () =>
                delete preview.folderConflictResolutions[conflict.conflictId],
              refreshActionState,
            );
          } else
            applyFolderConflictResolution(
              preview,
              conflict.conflictId,
              "manual",
              value,
            );
          showValidation(value);
          refreshActionState();
        });
    });
    if ("attachmentConflicts" in preview)
      setting.addButton((button) =>
        button.setButtonText("应用手动路径").onClick(() => {
          const value = draftValue();
          if (!value) {
            showValidation(value);
            return;
          }
          this.queueDecision(
            `folder:${conflict.conflictId}`,
            () => delete preview.folderConflictResolutions[conflict.conflictId],
            (candidate) =>
              resolveFolderConflictV3(candidate, conflict.conflictId, {
                choice: "manual",
                manualPath: value,
              }),
            refreshActionState,
          );
        }),
      );
  }

  private renderAttachmentConflict(
    conflict: AttachmentConflict,
    refreshActionState: () => void,
  ): void {
    if (!isPullPreviewV3(this.preview)) return;
    const preview = this.preview;
    const applied =
      preview.attachmentConflictResolutions[conflict.conflictId] ?? null;
    const draft =
      this.attachmentDrafts.get(conflict.conflictId) ??
      ({
        mode: applied?.choice ?? "",
        primary: applied?.choice === "keep_both" ? applied.primary : "local",
        secondaryAttachmentId:
          applied?.choice === "keep_both"
            ? applied.secondaryAttachmentId
            : crypto.randomUUID(),
        secondaryPath:
          applied?.choice === "keep_both" ? applied.secondaryPath : "",
        redirectPageIds: new Set(
          applied?.choice === "keep_both" ? applied.redirectPageIds : [],
        ),
      } satisfies AttachmentResolutionDraft);
    this.attachmentDrafts.set(conflict.conflictId, draft);
    const setting = new Setting(this.contentEl)
      .setName(
        `图片：${conflict.local?.path ?? conflict.remote?.path ?? conflict.attachmentId}`,
      )
      .setDesc(
        `冲突类型：${conflict.kind} · 影响 ${conflict.affectedPageIds.length} 个 Page`,
      );
    setting.settingEl.addClass("agentwiki-sync-preview-setting");
    setting.settingEl.addClass("agentwiki-sync-attachment-setting");
    setting.controlEl?.addClass("agentwiki-sync-resolution-controls");

    const applyDraft = (): void => {
      if (draft.mode === "local" || draft.mode === "remote") {
        const choice = draft.mode;
        this.queueDecision(
          `attachment:${conflict.conflictId}`,
          () =>
            delete preview.attachmentConflictResolutions[conflict.conflictId],
          (candidate) =>
            resolveAttachmentConflict(candidate, conflict.conflictId, {
              choice,
            }),
          refreshActionState,
        );
      } else if (draft.mode === "keep_both") {
        const resolution = {
          choice: "keep_both" as const,
          primary: draft.primary,
          secondaryAttachmentId: draft.secondaryAttachmentId,
          secondaryPath: draft.secondaryPath.trim(),
          redirectPageIds: [...draft.redirectPageIds].sort(),
        };
        if (!attachmentConflictResolutionComplete(conflict, resolution)) return;
        this.queueDecision(
          `attachment:${conflict.conflictId}`,
          () =>
            delete preview.attachmentConflictResolutions[conflict.conflictId],
          (candidate) =>
            resolveAttachmentConflict(
              candidate,
              conflict.conflictId,
              resolution,
            ),
          refreshActionState,
        );
      }
    };

    const canKeepBoth = conflict.affectedPageIds.length >= 2;
    if (!canKeepBoth && draft.mode === "keep_both") draft.mode = "";
    setting.addDropdown((dropdown) => {
      dropdown
        .addOption("", "请选择…")
        .addOption("local", "保留本地")
        .addOption("remote", "使用服务器");
      if (canKeepBoth) dropdown.addOption("keep_both", "同时保留");
      dropdown.setValue(draft.mode).onChange((value) => {
        draft.mode =
          value === "local" ||
          value === "remote" ||
          (value === "keep_both" && canKeepBoth)
            ? value
            : "";
        if (draft.mode === "local" || draft.mode === "remote") applyDraft();
        else
          this.clearDecision(
            `attachment:${conflict.conflictId}`,
            () =>
              delete preview.attachmentConflictResolutions[conflict.conflictId],
            refreshActionState,
          );
      });
    });
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("local", "主版本：本地")
        .addOption("remote", "主版本：服务器")
        .setValue(draft.primary)
        .onChange((value) => {
          draft.primary = value === "remote" ? "remote" : "local";
          this.clearDecision(
            `attachment:${conflict.conflictId}`,
            () =>
              delete preview.attachmentConflictResolutions[conflict.conflictId],
            refreshActionState,
          );
        }),
    );
    setting.addText((text) =>
      text
        .setPlaceholder("副本路径（assets/文件名）")
        .setValue(draft.secondaryPath)
        .onChange((value) => {
          draft.secondaryPath = value;
          this.clearDecision(
            `attachment:${conflict.conflictId}`,
            () =>
              delete preview.attachmentConflictResolutions[conflict.conflictId],
            refreshActionState,
          );
        }),
    );
    const redirects = this.contentEl.createEl("fieldset", {
      cls: "agentwiki-sync-attachment-redirects",
    });
    redirects.createEl("legend", { text: "改用副本的页面" });
    for (const pageId of conflict.affectedPageIds) {
      const label = redirects.createEl("label");
      const input = label.createEl("input", { type: "checkbox" });
      input.checked = draft.redirectPageIds.has(pageId);
      input.addEventListener("change", () => {
        if (input.checked) draft.redirectPageIds.add(pageId);
        else draft.redirectPageIds.delete(pageId);
        this.clearDecision(
          `attachment:${conflict.conflictId}`,
          () =>
            delete preview.attachmentConflictResolutions[conflict.conflictId],
          refreshActionState,
        );
      });
      const pagePath =
        preview.resolvedPages.find((page) => page.pageId === pageId)?.path ??
        preview.local.pages.find((page) => page.pageId === pageId)?.path ??
        preview.remote.pages.find((page) => page.pageId === pageId)?.path ??
        preview.base.pages.find((page) => page.pageId === pageId)?.path ??
        pageId;
      label.appendText(pagePath);
    }
    setting.addButton((button) =>
      button.setButtonText("应用图片选择").onClick(() => {
        if (!draft.mode) return;
        if (draft.mode === "keep_both") {
          const resolution = {
            choice: "keep_both" as const,
            primary: draft.primary,
            secondaryAttachmentId: draft.secondaryAttachmentId,
            secondaryPath: draft.secondaryPath.trim(),
            redirectPageIds: [...draft.redirectPageIds].sort(),
          };
          if (!attachmentConflictResolutionComplete(conflict, resolution)) {
            new Notice("请选择主版本、填写副本路径，并显式勾选部分页面。");
            return;
          }
        }
        applyDraft();
      }),
    );
  }
}
