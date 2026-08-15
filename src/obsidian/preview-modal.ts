import { Modal, Notice, Setting, type App } from "obsidian";
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
      .setDesc("确认将应用以上全部变更（包括其他分页）。")
      .addButton((button) =>
        button.setButtonText("取消").onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText("确认执行")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.confirm();
              this.close();
            } catch (error) {
              new Notice(
                `同步失败：${error instanceof Error ? error.message : "未知错误"}`,
              );
            } finally {
              button.setDisabled(false);
            }
          }),
      );
  }
  private renderBinding(binding: InitialBindingChoice): void {
    const setting = new Setting(this.contentEl)
      .setName(`${binding.localPath ?? "新文件"} ↔ ${binding.remotePath}`)
      .setDesc("选择本地文件对应关系，或使用远端版本。");
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
  private renderConflict(conflict: StructuredConflict): void {
    const setting = new Setting(this.contentEl)
      .setName(`${conflict.field}: ${conflict.pageId}`)
      .setDesc("正在加载预览…");
    const refs = this.pullPreview?.conflictValuePaths[conflict.conflictId];
    if (refs)
      void Promise.all(
        [refs.base, refs.local, refs.remote].map((path) =>
          this.app.vault.adapter.read(path),
        ),
      )
        .then(([base, local, remote]) =>
          setting.setDesc(
            `原版：${(base ?? "").slice(0, 120)} · 本地：${(local ?? "").slice(0, 120)} · 远端：${(remote ?? "").slice(0, 120)}`,
          ),
        )
        .catch(() =>
          setting.setDesc("无法加载冲突预览。请直接选择一方或手动输入。"),
        );
    else
      setting.setDesc(
        `原版：${conflict.base.slice(0, 120)} · 本地：${conflict.local.slice(0, 120)} · 远端：${conflict.remote.slice(0, 120)}`,
      );
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
