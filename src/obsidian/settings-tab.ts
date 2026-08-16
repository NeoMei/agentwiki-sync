import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type AgentWikiSyncPlugin from "../main";
import { userErrorMessage } from "../core/user-errors";
import type { SyncSpaceSummary } from "../agentwiki/protocol";

const roleLabels: Record<SyncSpaceSummary["role"], string> = {
  viewer: "只读",
  editor: "可编辑",
  admin: "管理员",
  owner: "所有者",
};

export class AgentWikiSyncSettingTab extends PluginSettingTab {
  private connectionCode = "";
  private availableSpaces: SyncSpaceSummary[] | null = null;
  private selectedSpaceId = "";

  constructor(
    app: App,
    private readonly plugin: AgentWikiSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.renderConnectionSection();
    this.renderMappingSection();
    this.renderDisconnectSection();
    if (
      this.plugin.settings.serverInstanceId !== null &&
      !this.availableSpaces
    ) {
      void this.loadSpaces();
    }
  }

  private renderConnectionSection(): void {
    this.containerEl.createEl("h3", { text: "连接" });
    new Setting(this.containerEl)
      .setName("AgentWiki 服务器")
      .setDesc(
        this.plugin.settings.serverInstanceId
          ? "已连接。断开后可更改服务器。"
          : "输入服务器地址，如 https://agentwiki.quukk.com",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://agentwiki.quukk.com")
          .setValue(this.plugin.settings.serverUrl)
          .setDisabled(this.plugin.settings.serverInstanceId !== null)
          .onChange(async (value) => {
            if (this.plugin.settings.serverInstanceId !== null) return;
            this.plugin.settings.serverUrl = value.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
      );

    if (this.plugin.settings.serverInstanceId !== null) {
      new Setting(this.containerEl)
        .setName("已连接")
        .setDesc("此设备已通过人类凭据连接到 AgentWiki。");
    } else {
      new Setting(this.containerEl)
        .setName("一次性连接码")
        .setDesc(
          "在 AgentWiki 网页的「集成 → Obsidian 设备」中生成连接码，粘贴到此处。",
        )
        .addText((text) =>
          text.setPlaceholder("粘贴连接码").onChange((value) => {
            this.connectionCode = value.trim();
          }),
        )
        .addButton((button) =>
          button
            .setButtonText("连接")
            .setCta()
            .onClick(async () => {
              if (!this.plugin.settings.serverUrl) {
                new Notice("请先输入服务器地址。");
                return;
              }
              if (!this.connectionCode) {
                new Notice("请粘贴连接码。");
                return;
              }
              button.setDisabled(true);
              button.setButtonText("连接中…");
              try {
                await this.plugin.connect(this.connectionCode);
                this.connectionCode = "";
                new Notice("连接成功。");
                this.display();
              } catch (error) {
                new Notice(userErrorMessage(error));
                button.setDisabled(false);
                button.setButtonText("连接");
              }
            }),
        );
    }
  }

  private renderMappingSection(): void {
    this.containerEl.createEl("h3", { text: "空间映射" });

    for (const mapping of this.plugin.settings.mappings) {
      const space = this.availableSpaces?.find(
        (s) => s.spaceId === mapping.spaceId,
      );
      new Setting(this.containerEl)
        .setName(space?.displayName ?? mapping.spaceId)
        .setDesc(
          mapping.rootPath +
            " · " +
            (mapping.status === "active" ? "已激活" : "待首次拉取"),
        )
        .addButton((button) =>
          button
            .setButtonText(mapping.status === "pending" ? "取消" : "移除")
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.removeMapping(mapping.spaceId);
                this.display();
              } catch (error) {
                new Notice(userErrorMessage(error));
                button.setDisabled(false);
              }
            }),
        );
    }

    if (this.plugin.settings.serverInstanceId === null) {
      this.containerEl.createEl("p", {
        text: "连接后可选择要同步的空间。",
      });
      return;
    }

    if (this.availableSpaces === null) {
      this.containerEl.createEl("p", { text: "正在加载空间列表…" });
      return;
    }

    if (this.availableSpaces.length === 0) {
      this.containerEl.createEl("p", {
        text: "暂无可访问的空间。请先在 AgentWiki 中创建或获取授权。",
      });
      return;
    }

    const rootPathInput = { value: "" };
    new Setting(this.containerEl)
      .setName("添加映射")
      .setDesc("选择要同步的空间和本地文件夹。")
      .addDropdown((dropdown) => {
        const spaces = this.availableSpaces ?? [];
        dropdown.addOption("", "选择空间…");
        for (const space of spaces) {
          const label =
            space.displayName +
            "（" +
            roleLabels[space.role] +
            (space.canPublish ? "" : "，只读") +
            "）";
          dropdown.addOption(space.spaceId, label);
        }
        dropdown.onChange((value) => {
          this.selectedSpaceId = value;
        });
      })
      .addText((text) =>
        text.setPlaceholder("Wiki").onChange((value) => {
          rootPathInput.value = value.trim();
        }),
      )
      .addButton((button) =>
        button.setButtonText("添加").onClick(async () => {
          if (!this.selectedSpaceId) {
            new Notice("请选择一个空间。");
            return;
          }
          if (!rootPathInput.value) {
            new Notice("请输入本地文件夹名，如 Wiki");
            return;
          }
          const selectedSpace = this.availableSpaces?.find(
            (s) => s.spaceId === this.selectedSpaceId,
          );
          if (selectedSpace && !selectedSpace.canPublish) {
            new Notice("此空间为只读，无法推送。请选择可编辑空间。");
            button.setDisabled(false);
            return;
          }
          button.setDisabled(true);
          try {
            await this.plugin.addMapping(
              this.selectedSpaceId,
              rootPathInput.value,
            );
            new Notice("映射已添加。执行拉取（Pull）后开始同步。");
            this.display();
          } catch (error) {
            new Notice(userErrorMessage(error));
            button.setDisabled(false);
          }
        }),
      );
  }

  private renderDisconnectSection(): void {
    if (this.plugin.settings.serverInstanceId === null) return;
    new Setting(this.containerEl)
      .setName("断开连接")
      .setDesc("清除本地凭据。如需撤销远端凭据，请在 AgentWiki 网页操作。")
      .addButton((button) =>
        button
          .setButtonText("断开")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.disconnect();
              this.availableSpaces = null;
              this.display();
            } catch (error) {
              new Notice(userErrorMessage(error));
              button.setDisabled(false);
            }
          }),
      );
  }

  private async loadSpaces(): Promise<void> {
    try {
      const spaces = await this.plugin.listAccessibleSpaces();
      this.availableSpaces = spaces;
      this.display();
    } catch {
      this.availableSpaces = [];
      this.display();
    }
  }
}
