export interface HttpResponse {
  status: number;
  json: unknown;
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type HttpResponseType = "json" | "bounded-json" | "binary" | "empty";

export class HttpResponseTooLargeError extends RangeError {
  readonly retryable = false;
  constructor(readonly maxResponseBytes: number) {
    super(`HTTP_RESPONSE_TOO_LARGE:${maxResponseBytes}`);
  }
}

export class HttpResponseParseError extends Error {
  readonly retryable = false;
  constructor() {
    super("HTTP_RESPONSE_JSON_INVALID");
  }
}

export interface HttpPort {
  request(request: {
    method: string;
    url: string;
    body?: unknown;
    canonicalBody?: Uint8Array;
    binaryBody?: Uint8Array;
    headers?: Record<string, string>;
    responseType?: HttpResponseType;
    maxResponseBytes?: number;
  }): Promise<HttpResponse>;
}
