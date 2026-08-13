import { RevisionHeadResponseSchema, type RevisionHeadResponse } from "./protocol";
import type { HttpPort, HttpResponse } from "../ports/http";

export function normalizeServerUrl(input: string, development = false): string {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new TypeError("Server URL must be an origin without credentials, path, query, or fragment");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(development && url.protocol === "http:" && loopback)) throw new TypeError("Server URL must use HTTPS");
  return url.origin;
}

export class AgentWikiHttpError extends Error {
  constructor(readonly status: number, readonly body: unknown, message = `AgentWiki request failed (${status})`) { super(message); }
}

export class AgentWikiClient {
  constructor(private readonly serverUrl: string, private readonly http: HttpPort, private readonly credential: () => string | null) {}

  async raw(method: string, path: string, body?: unknown, authenticated = true): Promise<HttpResponse> {
    const secret = authenticated ? this.credential() : null;
    const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const response = await this.http.request({ method, url: `${this.serverUrl}${path}`, body, headers });
    if (response.status >= 300 && response.status < 400) throw new AgentWikiHttpError(response.status, response.json, "AgentWiki routes must not redirect");
    if (response.status >= 400) throw new AgentWikiHttpError(response.status, response.json);
    return response;
  }

  async head(spaceId: string): Promise<RevisionHeadResponse> {
    return RevisionHeadResponseSchema.parse((await this.raw("GET", `/api/sync/v1/spaces/${encodeURIComponent(spaceId)}/head`)).json);
  }
}
