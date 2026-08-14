import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type AgentWikiSyncPlugin from "../main";

export class AgentWikiSyncSettingTab extends PluginSettingTab {
  private connectionCode = "";
  constructor(
    app: App,
    private readonly plugin: AgentWikiSyncPlugin,
  ) {
    super(app, plugin);
  }
  display(): void {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("AgentWiki server")
      .setDesc(
        this.plugin.settings.serverInstanceId
          ? "Disconnect this device before changing its AgentWiki origin."
          : "HTTPS AgentWiki origin. Connection stays inside this settings page.",
      )
      .addText((text) =>
        text
          .setPlaceholder("https://wiki.example.com")
          .setValue(this.plugin.settings.serverUrl)
          .setDisabled(this.plugin.settings.serverInstanceId !== null)
          .onChange(async (value) => {
            if (this.plugin.settings.serverInstanceId !== null) return;
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          }),
      );
    new Setting(this.containerEl)
      .setName("One-time connection code")
      .setDesc(
        "Create the code in AgentWiki, paste it here, then connect this human device.",
      )
      .addText((text) =>
        text.setPlaceholder("Connection code").onChange((value) => {
          this.connectionCode = value;
        }),
      )
      .addButton((button) =>
        button
          .setButtonText("Connect")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.connect(this.connectionCode);
              this.connectionCode = "";
              this.display();
            } catch (error) {
              new Notice(
                `Connection failed: ${error instanceof Error ? error.message : "unknown error"}`,
              );
            } finally {
              button.setDisabled(false);
            }
          }),
      );
    this.containerEl.createEl("h3", { text: "Space mappings" });
    if (this.plugin.settings.mappings.length === 0)
      this.containerEl.createEl("p", {
        text: "Connect first, then add a Space and a non-overlapping Vault folder.",
      });
    for (const mapping of this.plugin.settings.mappings)
      new Setting(this.containerEl)
        .setName(mapping.spaceId)
        .setDesc(`${mapping.rootPath} · ${mapping.status}`)
        .addButton((button) =>
          button
            .setButtonText(
              mapping.status === "pending"
                ? "Cancel mapping"
                : "Remove mapping",
            )
            .setWarning()
            .onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.removeMapping(mapping.spaceId);
                this.display();
              } catch (error) {
                new Notice(
                  `Remove mapping failed: ${error instanceof Error ? error.message : "unknown error"}`,
                );
              } finally {
                button.setDisabled(false);
              }
            }),
        );
    new Setting(this.containerEl)
      .setName("Add mapping")
      .setDesc(
        "Enter a Space ID and a non-overlapping Vault folder as space-id | folder/path.",
      )
      .addText((text) => text.setPlaceholder("space-id | Wiki"))
      .addButton((button) =>
        button.setButtonText("Add").onClick(async () => {
          const input =
            button.buttonEl.parentElement?.querySelector("input")?.value ?? "";
          const [spaceId, rootPath] = input
            .split("|")
            .map((part) => part.trim());
          if (!spaceId || !rootPath) {
            new Notice("Enter a Space ID and folder as space-id | folder/path.");
            return;
          }
          button.setDisabled(true);
          try {
            await this.plugin.addMapping(spaceId, rootPath);
            this.display();
          } catch (error) {
            new Notice(
              `Add mapping failed: ${error instanceof Error ? error.message : "unknown error"}`,
            );
            button.setDisabled(false);
          }
        }),
      );
    new Setting(this.containerEl)
      .setName("Disconnect this device")
      .setDesc(
        "Clears the local credential. If offline, revoke the device later in AgentWiki Web.",
      )
      .addButton((button) =>
        button
          .setButtonText("Disconnect")
          .setWarning()
          .onClick(async () => {
            button.setDisabled(true);
            try {
              await this.plugin.disconnect();
              this.display();
            } catch (error) {
              new Notice(
                `Disconnect failed: ${error instanceof Error ? error.message : "unknown error"}`,
              );
              button.setDisabled(false);
            }
          }),
      );
  }
}
