export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.join("/");
}

export class TFile {
  constructor(public readonly path: string) {}
}

export class TFolder {
  constructor(public readonly path: string) {}
}

class MockElement {
  text = "";
  empty(): void {}
  addClass(): void {}
  setText(value: string): void {
    this.text = value;
  }
  createEl(): MockElement {
    return new MockElement();
  }
}

export class Notice {
  constructor(public readonly message: string) {}
}

export class Plugin {
  constructor(
    public readonly app: any,
    public readonly manifest: { version: string } = { version: "0.0.0" },
  ) {}
  async loadData(): Promise<unknown> {
    return this.app.__pluginData ?? null;
  }
  async saveData(value: unknown): Promise<void> {
    this.app.__pluginData = structuredClone(value);
    this.app.__savedData?.push(structuredClone(value));
  }
  addSettingTab(): void {}
  addRibbonIcon(): void {}
  addCommand(): void {}
  addStatusBarItem(): any {
    return new MockElement();
  }
  registerEvent(): void {}
  registerDomEvent(): void {}
}

export class PluginSettingTab {
  containerEl = new MockElement();
  constructor(
    public readonly app: any,
    public readonly plugin: any,
  ) {}
}

export class Modal {
  contentEl = new MockElement();
  modalEl = new MockElement();
  constructor(public readonly app: any) {}
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(public readonly containerEl: any) {}
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
  addDropdown(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
}

export interface MockRequestUrlResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

export type RequestUrlImpl = (
  request: unknown,
) => Promise<MockRequestUrlResponse>;

export const requestUrlState: { impl: RequestUrlImpl } = {
  impl: async () => {
    throw new Error("requestUrl is not stubbed");
  },
};

export function requestUrl(request: unknown): Promise<MockRequestUrlResponse> {
  return requestUrlState.impl(request);
}

export function resetObsidianMock(): void {
  requestUrlState.impl = async () => {
    throw new Error("requestUrl is not stubbed");
  };
}
