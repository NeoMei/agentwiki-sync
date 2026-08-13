import { Plugin } from "obsidian";

export default class AgentWikiSyncPlugin extends Plugin {
  override onload(): void {
    this.addCommand({ id: "status", name: "Status", callback: () => undefined });
    this.addCommand({ id: "pull", name: "Pull", callback: () => undefined });
    this.addCommand({ id: "push", name: "Push", callback: () => undefined });
  }
}
