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

type MockListener = () => void;

export class MockElement {
  readonly children: MockElement[] = [];
  readonly classes = new Set<string>();
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, MockListener[]>();
  text = "";
  value = "";
  checked = false;
  disabled = false;
  constructor(
    readonly tag = "div",
    readonly parent: MockElement | null = null,
  ) {}
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }
  empty(): void {
    this.children.length = 0;
    this.text = "";
  }
  addClass(value: string): void {
    this.classes.add(value);
  }
  setText(value: string): void {
    this.text = value;
  }
  createEl(
    tag: string,
    options?: { text?: string; cls?: string; type?: string },
  ): MockElement {
    const child = new MockElement(tag, this);
    if (options?.text) child.text = options.text;
    if (options?.cls) child.addClass(options.cls);
    if (options?.type) child.attributes.set("type", options.type);
    this.children.push(child);
    return child;
  }
  createDiv(options?: { text?: string; cls?: string }): MockElement {
    const child = new MockElement("div", this);
    if (options?.text) child.text = options.text;
    if (options?.cls) child.addClass(options.cls);
    this.children.push(child);
    return child;
  }
  appendText(value: string): void {
    this.text += value;
  }
  addEventListener(event: string, listener: MockListener): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  dispatchEvent(event: { type: string }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener();
    return true;
  }
  queryAll(predicate: (element: MockElement) => boolean): MockElement[] {
    return [
      ...(predicate(this) ? [this] : []),
      ...this.children.flatMap((child) => child.queryAll(predicate)),
    ];
  }
}

abstract class MockValueComponent {
  constructor(readonly inputEl: MockElement) {}
  setDisabled(value: boolean): this {
    this.inputEl.disabled = value;
    return this;
  }
}

export class ButtonComponent extends MockValueComponent {
  readonly buttonEl = this.inputEl;
  private callback: (() => void | Promise<void>) | null = null;
  setButtonText(value: string): this {
    this.buttonEl.text = value;
    return this;
  }
  setWarning(): this {
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(callback: () => void | Promise<void>): this {
    this.callback = callback;
    this.buttonEl.addEventListener("click", () => {
      if (!this.buttonEl.disabled) void this.callback?.();
    });
    return this;
  }
}

class MockTextComponent extends MockValueComponent {
  setPlaceholder(value: string): this {
    this.inputEl.attributes.set("placeholder", value);
    return this;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  onChange(callback: (value: string) => void | Promise<void>): this {
    this.inputEl.addEventListener("change", () => {
      if (!this.inputEl.disabled) void callback(this.inputEl.value);
    });
    return this;
  }
}

export class TextAreaComponent extends MockTextComponent {}

class MockDropdownComponent extends MockValueComponent {
  addOption(value: string, label: string): this {
    const option = this.inputEl.createEl("option", { text: label });
    option.value = value;
    return this;
  }
  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }
  onChange(callback: (value: string) => void | Promise<void>): this {
    this.inputEl.addEventListener("change", () => {
      if (!this.inputEl.disabled) void callback(this.inputEl.value);
    });
    return this;
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
  contentEl = new MockElement("div");
  modalEl = new MockElement("div");
  constructor(public readonly app: unknown) {}
  open(): void {
    (this as { onOpen?: () => void }).onOpen?.();
  }
  close(): void {
    (this as { onClose?: () => void }).onClose?.();
  }
}

export class Setting {
  readonly settingEl: MockElement;
  readonly controlEl: MockElement;
  private readonly infoEl: MockElement;
  private readonly nameEl: MockElement;
  private readonly descEl: MockElement;
  constructor(public readonly containerEl: MockElement) {
    this.settingEl = containerEl.createDiv({ cls: "setting-item" });
    this.infoEl = this.settingEl.createDiv({ cls: "setting-item-info" });
    this.nameEl = this.infoEl.createDiv({ cls: "setting-item-name" });
    this.descEl = this.infoEl.createDiv({ cls: "setting-item-description" });
    this.controlEl = this.settingEl.createDiv({ cls: "setting-item-control" });
  }
  setName(value: string): this {
    this.nameEl.setText(value);
    return this;
  }
  setDesc(value: string): this {
    this.descEl.setText(value);
    return this;
  }
  setHeading(): this {
    return this;
  }
  addText(callback: (component: MockTextComponent) => void): this {
    callback(new MockTextComponent(this.controlEl.createEl("input")));
    return this;
  }
  addTextArea(callback: (component: TextAreaComponent) => void): this {
    callback(new TextAreaComponent(this.controlEl.createEl("textarea")));
    return this;
  }
  addButton(callback: (component: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.controlEl.createEl("button")));
    return this;
  }
  addDropdown(callback: (component: MockDropdownComponent) => void): this {
    callback(new MockDropdownComponent(this.controlEl.createEl("select")));
    return this;
  }
  addToggle(): this {
    return this;
  }
}

export interface MockRequestUrlResponse {
  status: number;
  json: unknown;
  text?: string;
  arrayBuffer?: ArrayBuffer;
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
