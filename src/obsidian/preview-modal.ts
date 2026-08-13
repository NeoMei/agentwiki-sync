import { Modal, Setting, type App } from "obsidian";

export class PreviewModal extends Modal {
  private released=false;
  constructor(app: App, private readonly title: string, private readonly lines: string[], private readonly confirm: () => Promise<void>,private readonly release:()=>void=()=>{}) { super(app); }
  onClose():void{if(!this.released){this.released=true;this.release();}}
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: this.title });
    const list = this.contentEl.createEl("ul"); for (const line of this.lines.slice(0, 100)) list.createEl("li", { text: line });
    if (this.lines.length > 100) this.contentEl.createEl("p", { text: `${this.lines.length - 100} more actions are hidden from this page.` });
    new Setting(this.contentEl).setDesc("This confirmation applies only to the preview above.").addButton((button) => button.setButtonText("Cancel").onClick(() => this.close())).addButton((button) => button.setButtonText("Confirm").setWarning().onClick(async () => { button.setDisabled(true); try { await this.confirm(); this.close(); } finally { button.setDisabled(false); } }));
  }
}
