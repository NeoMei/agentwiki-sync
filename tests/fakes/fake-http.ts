import type { HttpPort, HttpResponse } from "../../src/ports/http";
export class FakeHttp implements HttpPort {
  static capabilities = {
    maxPageBytes: 1048576,
    maxBatchBytes: 4194304,
    maxBatchItems: 100,
    maxChangeCount: 5000,
    maxConfirmationBytes: 4194304,
    maxClientSpacePages: 5000,
    maxClientManifestBytes: 4194304,
    maxClientTotalBodyBytes: 104857600,
    maxResponseBytes: 4194304,
    maxPageItems: 200,
    pushSessionTtlSeconds: 900,
  };
  readonly calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    authorization?: string;
    canonicalBody?: Uint8Array;
  }> = [];
  readonly responses: HttpResponse[] = [];
  private readonly routes = new Map<string, HttpResponse>();
  route(method: string, path: string, response: HttpResponse): void {
    this.routes.set(`${method} ${path}`, response);
  }
  async request(request: {
    method: string;
    url: string;
    body?: unknown;
    canonicalBody?: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpResponse> {
    const url = new URL(request.url);
    this.calls.push({
      method: request.method,
      path: url.pathname + url.search,
      body: request.body,
      authorization: request.headers?.Authorization,
      canonicalBody: request.canonicalBody,
    });
    return (
      this.responses.shift() ??
      this.routes.get(`${request.method} ${url.pathname}`) ?? {
        status: 404,
        json: {
          protocolVersion: "1",
          error: {
            code: "PUSH_SESSION_NOT_FOUND",
            message: "not found",
            retryable: false,
          },
        },
      }
    );
  }
}
