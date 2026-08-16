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
