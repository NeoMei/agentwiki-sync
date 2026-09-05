import type { HttpPort, HttpResponse } from "../../src/ports/http";
import {
  HttpResponseParseError,
  HttpResponseTooLargeError,
  type HttpResponseType,
} from "../../src/ports/http";
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
    binaryBody?: Uint8Array;
    responseType?: HttpResponseType;
    maxResponseBytes?: number;
  }> = [];
  readonly responses: HttpResponse[] = [];
  private readonly routes = new Map<string, HttpResponse>();
  enqueue(response: HttpResponse): void {
    this.responses.push(response);
  }
  route(method: string, path: string, response: HttpResponse): void {
    this.routes.set(`${method} ${path}`, response);
  }
  async request(request: {
    method: string;
    url: string;
    body?: unknown;
    canonicalBody?: Uint8Array;
    binaryBody?: Uint8Array;
    headers?: Record<string, string>;
    responseType?: HttpResponseType;
    maxResponseBytes?: number;
  }): Promise<HttpResponse> {
    const url = new URL(request.url);
    this.calls.push({
      method: request.method,
      path: url.pathname + url.search,
      body: request.body,
      authorization: request.headers?.Authorization,
      canonicalBody: request.canonicalBody,
      binaryBody: request.binaryBody?.slice(),
      responseType: request.responseType,
      maxResponseBytes: request.maxResponseBytes,
    });
    const response = this.responses.shift() ??
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
      };
    if (request.responseType === "empty" && response.status < 400)
      return {
        status: response.status,
        json: undefined,
        headers: response.headers,
      };
    if (request.responseType === "binary" && response.status < 400) {
      const bytes = response.bytes ?? new Uint8Array();
      if (
        request.maxResponseBytes !== undefined &&
        bytes.byteLength > request.maxResponseBytes
      )
        throw new HttpResponseTooLargeError(request.maxResponseBytes);
      return { ...response, json: undefined, bytes: bytes.slice() };
    }
    if (request.responseType === "bounded-json" || response.status >= 400) {
      const text = JSON.stringify(response.json);
      if (text === undefined) throw new HttpResponseParseError();
      if (
        request.maxResponseBytes !== undefined &&
        new TextEncoder().encode(text).byteLength > request.maxResponseBytes
      )
        throw new HttpResponseTooLargeError(request.maxResponseBytes);
      return { ...response, json: JSON.parse(text) as unknown };
    }
    return response;
  }
}
