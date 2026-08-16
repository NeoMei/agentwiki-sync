export interface HttpResponse {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}
export interface HttpPort {
  request(request: {
    method: string;
    url: string;
    body?: unknown;
    canonicalBody?: Uint8Array;
    headers?: Record<string, string>;
  }): Promise<HttpResponse>;
}
