export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.join("/");
}

export class TFile {
  constructor(
    public readonly path: string,
    public readonly stat = { size: 0, mtime: 0 },
  ) {}
  get extension(): string {
    const name = this.path.slice(this.path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot + 1) : "";
  }
}

export class TFolder {
  constructor(
    public readonly path: string,
    public readonly children: Array<TFile | TFolder> = [],
  ) {}
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

interface MockPluginApp {
  __pluginData?: unknown;
  __savedData?: unknown[];
}

export class Plugin {
  constructor(
    public readonly app: MockPluginApp,
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
  addStatusBarItem(): MockElement {
    return new MockElement();
  }
  registerEvent(): void {}
  registerDomEvent(): void {}
}

export class PluginSettingTab {
  containerEl = new MockElement();
  constructor(
    public readonly app: unknown,
    public readonly plugin: unknown,
  ) {}
}

export class Modal {
  contentEl = new MockElement();
  modalEl = new MockElement();
  constructor(public readonly app: unknown) {}
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(public readonly containerEl: unknown) {}
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
