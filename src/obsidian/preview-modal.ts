import { Modal, Setting, type App } from "obsidian";
import type { InitialBindingChoice } from "../application/sync-runtime";

export class PreviewModal extends Modal {
  private released=false;
  constructor(app: App, private readonly title: string, private readonly lines: string[], private readonly confirm: () => Promise<void>,private readonly release:()=>void=()=>{},private readonly bindings:InitialBindingChoice[]=[]) { super(app); }
  onClose():void{if(!this.released){this.released=true;this.release();}}
  onOpen(): void {
    this.contentEl.empty(); this.contentEl.createEl("h2", { text: this.title });
    const list = this.contentEl.createEl("ul"); for (const line of this.lines.slice(0, 100)) list.createEl("li", { text: line });
    if (this.lines.length > 100) this.contentEl.createEl("p", { text: `${this.lines.length - 100} more actions are hidden from this page.` });
    for(const binding of this.bindings.filter(item=>item.localPath)){const setting=new Setting(this.contentEl).setName(`${binding.localPath} ↔ ${binding.remotePath}`).setDesc("Choose the initial Vault content. The remote revision remains the exact base; Local/manual differences stay dirty for a later Push.");setting.addDropdown(dropdown=>dropdown.addOption("","Choose…").addOption("local","Keep Local").addOption("remote","Use Remote").addOption("manual","Manual body").onChange(value=>{binding.resolution=value==="local"||value==="remote"||value==="manual"?value:null;}));setting.addTextArea(text=>text.setPlaceholder("Manual body (used only with Manual body)").onChange(value=>{binding.manualBody=value;}));}
    new Setting(this.contentEl).setDesc("This confirmation applies only to the preview above.").addButton((button) => button.setButtonText("Cancel").onClick(() => this.close())).addButton((button) => button.setButtonText("Confirm").setWarning().onClick(async () => { button.setDisabled(true); try { await this.confirm(); this.close(); } finally { button.setDisabled(false); } }));
  }
}
