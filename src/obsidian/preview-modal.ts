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
  PullPreviewV3,
} from "../application/sync-runtime";
import type {
  AttachmentConflict,
  FolderConflict,
  StructuredConflict,
} from "../core/merge";
import type { TreeBootstrapPreviewV3 } from "../ports/tree-remote";
import type { TreePushPreviewV3 } from "../application/tree-push-service-v3";
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
} from "./preview-logic";
import {
  progressLabel,
  type SyncOperationOptions,
} from "../application/progress";
import { completeModalAction, type ModalTransition } from "./modal-handoff";

type PreviewState =
  | PullPreview
  | PullPreviewV3
  | TreeBootstrapPreviewV3
  | TreePushPreviewV3
  | null;

interface AttachmentResolutionDraft {
  mode: "" | "local" | "remote" | "keep_both";
  primary: "local" | "remote";
  secondaryAttachmentId: string;
  secondaryPath: string;
  redirectPageIds: Set<string>;
}

function isPullPreview(
  preview: PreviewState,
): preview is PullPreview | PullPreviewV3 {
  return !!preview && "folderConflicts" in preview;
}

function isPullPreviewV3(preview: PreviewState): preview is PullPreviewV3 {
  return isPullPreview(preview) && "attachmentConflicts" in preview;
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
  private operation: AbortController | null = null;
  private running = false;
  private closeRequested = false;
  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: string[],
    private readonly confirm: (
      options: SyncOperationOptions,
    ) => Promise<ModalTransition | void>,
    private readonly release: () => void = () => {},
    private readonly bindings: InitialBindingChoice[] = [],
    private readonly preview: PreviewState = null,
  ) {
    super(app);
    this.modalEl.addClass("agentwiki-sync-modal");
  }
  onClose(): void {
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
  }
  private pager(
    total: number,
    page: number,
    setPage: (page: number) => void,
  ): void {
    if (total <= PREVIEW_PAGE_SIZE) return;
    new Setting(this.contentEl)
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
  private render(): void {
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: this.title });
    this.renderBlockers();
    const list = this.contentEl.createEl("ul");
    this.linePage = clampPage(this.linePage, this.lines.length);
    for (const line of pageSlice(this.lines, this.linePage))
      list.createEl("li", { text: line });
    this.pager(this.lines.length, this.linePage, (page) => {
      this.linePage = page;
    });
    const pendingDecisionCount = () =>
      isPullPreview(this.preview)
        ? pendingPreviewDecisionCount(this.bindings, this.preview)
        : this.preview && "mode" in this.preview
          ? this.preview.blockers.length
          : 0;
    const actionDescription = () => {
      const pending = pendingDecisionCount();
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
      confirmButton?.setDisabled(this.running || pendingDecisionCount() > 0);
    };
    actions
      .addButton((button) => {
        cancelButton = button;
        button.setButtonText("取消").onClick(() => {
          if (this.running) this.operation?.abort();
          else this.close();
        });
      })
      .addButton((button) => {
        confirmButton = button;
        button
          .setButtonText("确认执行")
          .setWarning()
          .setDisabled(this.running || pendingDecisionCount() > 0)
          .onClick(async () => {
            if (this.running) return;
            const pending = pendingDecisionCount();
            if (pending > 0) {
              new Notice(`还有 ${pending} 项待处理，请先完成选择。`);
              refreshActionState();
              return;
            }
            this.running = true;
            this.operation = new AbortController();
            button.setDisabled(true);
            try {
              await completeModalAction(
                () =>
                  this.confirm({
                    signal: this.operation!.signal,
                    onProgress: (progress) => {
                      actions.setDesc(progressLabel(progress));
                      cancelButton?.setDisabled(!progress.cancellable);
                    },
                  }),
                () => {
                  this.operation = null;
                  this.close();
                },
              );
            } catch (error) {
              new Notice(`同步失败：${userErrorMessage(error)}`);
            } finally {
              this.running = false;
              this.operation = null;
              refreshActionState();
              cancelButton?.setDisabled(false);
              if (this.closeRequested) this.releaseOnce();
            }
          });
      });
    const pendingBindings = bindingsRequiringInput(this.bindings);
    this.bindingPage = clampPage(this.bindingPage, pendingBindings.length);
    for (const binding of pageSlice(pendingBindings, this.bindingPage))
      this.renderBinding(binding, refreshActionState);
    this.pager(pendingBindings.length, this.bindingPage, (page) => {
      this.bindingPage = page;
    });
    const conflicts = isPullPreview(this.preview)
      ? "attachmentConflicts" in this.preview
        ? this.preview.pageConflicts
        : this.preview.conflicts
      : [];
    for (const conflict of pageSlice(conflicts, this.conflictPage))
      this.renderConflict(conflict, refreshActionState);
    this.pager(conflicts.length, this.conflictPage, (page) => {
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
    this.pager(folderConflicts.length, this.folderConflictPage, (page) => {
      this.folderConflictPage = page;
    });
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
      attachmentConflicts.length,
      this.attachmentConflictPage,
      (page) => {
        this.attachmentConflictPage = page;
      },
    );
  }

  private renderBlockers(): void {
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
            if (value === "manual") {
              this.pageManualDrafts.set(
                conflict.conflictId,
                this.pageManualDrafts.get(conflict.conflictId) ?? "",
              );
              delete this.preview.pageConflictResolutions[conflict.conflictId];
              refreshActionState();
            } else if (value !== "local" && value !== "remote")
              delete this.preview.pageConflictResolutions[conflict.conflictId];
            else
              void resolvePageConflictV3(this.preview, conflict.conflictId, {
                choice: value,
              })
                .catch((error) => new Notice(userErrorMessage(error)))
                .finally(refreshActionState);
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
              delete this.preview.pageConflictResolutions[conflict.conflictId];
              refreshActionState();
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
          void resolvePageConflictV3(this.preview, conflict.conflictId, {
            choice: "manual",
            manualValue: this.pageManualDrafts.get(conflict.conflictId) ?? "",
          })
            .catch((error) => new Notice(userErrorMessage(error)))
            .finally(refreshActionState);
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
              delete preview.folderConflictResolutions[conflict.conflictId];
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
            )
              void resolveFolderConflictV3(preview, conflict.conflictId, {
                choice: value,
              })
                .catch((error) => new Notice(userErrorMessage(error)))
                .finally(refreshActionState);
            else if (!("attachmentConflicts" in preview))
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
            delete preview.folderConflictResolutions[conflict.conflictId];
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
          void resolveFolderConflictV3(preview, conflict.conflictId, {
            choice: "manual",
            manualPath: value,
          })
            .catch((error) => new Notice(userErrorMessage(error)))
            .finally(refreshActionState);
        }),
      );
  }

  private renderAttachmentConflict(
    conflict: AttachmentConflict,
    refreshActionState: () => void,
  ): void {
    if (!isPullPreviewV3(this.preview)) return;
    const preview = this.preview;
    const draft =
      this.attachmentDrafts.get(conflict.conflictId) ??
      ({
        mode: "",
        primary: "local",
        secondaryAttachmentId: crypto.randomUUID(),
        secondaryPath: "",
        redirectPageIds: new Set<string>(),
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

    const applyDraft = async (): Promise<void> => {
      if (draft.mode === "local" || draft.mode === "remote") {
        await resolveAttachmentConflict(preview, conflict.conflictId, {
          choice: draft.mode,
        });
      } else if (draft.mode === "keep_both") {
        const resolution = {
          choice: "keep_both" as const,
          primary: draft.primary,
          secondaryAttachmentId: draft.secondaryAttachmentId,
          secondaryPath: draft.secondaryPath.trim(),
          redirectPageIds: [...draft.redirectPageIds].sort(),
        };
        if (!attachmentConflictResolutionComplete(conflict, resolution)) return;
        await resolveAttachmentConflict(
          preview,
          conflict.conflictId,
          resolution,
        );
      }
      refreshActionState();
    };
    const safelyApply = () =>
      void applyDraft().catch((error) => {
        new Notice(userErrorMessage(error));
        refreshActionState();
      });

    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("", "请选择…")
        .addOption("local", "保留本地")
        .addOption("remote", "使用服务器")
        .addOption("keep_both", "同时保留")
        .setValue(draft.mode)
        .onChange((value) => {
          draft.mode =
            value === "local" || value === "remote" || value === "keep_both"
              ? value
              : "";
          if (draft.mode === "local" || draft.mode === "remote") safelyApply();
          else refreshActionState();
        }),
    );
    setting.addDropdown((dropdown) =>
      dropdown
        .addOption("local", "主版本：本地")
        .addOption("remote", "主版本：服务器")
        .setValue(draft.primary)
        .onChange((value) => {
          draft.primary = value === "remote" ? "remote" : "local";
          refreshActionState();
        }),
    );
    setting.addText((text) =>
      text
        .setPlaceholder("副本路径（assets/文件名）")
        .setValue(draft.secondaryPath)
        .onChange((value) => {
          draft.secondaryPath = value;
          refreshActionState();
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
        refreshActionState();
      });
      label.appendText(pageId);
    }
    setting.addButton((button) =>
      button.setButtonText("应用图片选择").onClick(() => {
        if (draft.mode !== "keep_both") return;
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
        safelyApply();
      }),
    );
  }
}
