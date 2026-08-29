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
} from "../application/sync-runtime";
import type { FolderConflict, StructuredConflict } from "../core/merge";
import {
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

export class PreviewModal extends Modal {
  private released = false;
  private bindingPage = 0;
  private conflictPage = 0;
  private folderConflictPage = 0;
  private readonly folderManualDrafts = new Map<string, string>();
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
    private readonly pullPreview: PullPreview | null = null,
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
    const list = this.contentEl.createEl("ul");
    for (const line of pageSlice(this.lines, 0))
      list.createEl("li", { text: line });
    if (this.lines.length > PREVIEW_PAGE_SIZE)
      this.contentEl.createEl("p", {
        text: `${this.lines.length - PREVIEW_PAGE_SIZE} 其余变更已在下方分页中列出.`,
      });
    const pendingDecisionCount = () =>
      pendingPreviewDecisionCount(this.bindings, this.pullPreview);
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
    const conflicts = this.pullPreview?.conflicts ?? [];
    for (const conflict of pageSlice(conflicts, this.conflictPage))
      this.renderConflict(conflict, refreshActionState);
    this.pager(conflicts.length, this.conflictPage, (page) => {
      this.conflictPage = page;
    });
    const folderConflicts = this.pullPreview?.folderConflicts ?? [];
    this.folderConflictPage = clampPage(
      this.folderConflictPage,
      folderConflicts.length,
    );
    for (const conflict of pageSlice(folderConflicts, this.folderConflictPage))
      this.renderFolderConflict(conflict, refreshActionState);
    this.pager(folderConflicts.length, this.folderConflictPage, (page) => {
      this.folderConflictPage = page;
    });
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
        const candidates = this.pullPreview?.localCandidates ?? [];
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
        this.pullPreview?.localCandidates ?? [],
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
          this.pullPreview?.localCandidates ?? [],
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
          refreshActionState();
        }),
    );
    setting.addTextArea((text) =>
      text
        .setPlaceholder("手动输入最终内容")
        .setValue(
          this.pullPreview
            ? conflictManualValue(this.pullPreview, conflict.conflictId)
            : "",
        )
        .onChange((value) => {
          if (this.pullPreview) {
            applyConflictResolution(
              this.pullPreview,
              conflict.conflictId,
              "manual",
              value,
            );
            refreshActionState();
          }
        }),
    );
  }

  private renderFolderConflict(
    conflict: FolderConflict,
    refreshActionState: () => void,
  ): void {
    const preview = this.pullPreview;
    if (!preview) return;
    const baseDescription = `原位置：${conflict.basePath ?? "无"} · 本地：${conflict.localPath ?? "无"} · 服务器：${conflict.remotePath ?? "无"}`;
    const setting = new Setting(this.contentEl)
      .setName(`目录：${conflict.folderId}`)
      .setDesc(baseDescription);
    setting.settingEl.addClass("agentwiki-sync-preview-setting");
    setting.settingEl.addClass("agentwiki-sync-folder-setting");
    setting.controlEl?.addClass("agentwiki-sync-resolution-controls");

    const draftValue = () =>
      this.folderManualDrafts.get(conflict.conflictId) ??
      folderConflictManualValue(preview, conflict.conflictId);
    const showValidation = (value: string) => {
      const error = folderConflictValidationError(
        preview,
        conflict.conflictId,
        value,
      );
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
            applyFolderConflictResolution(preview, conflict.conflictId, value);
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
  }
}
