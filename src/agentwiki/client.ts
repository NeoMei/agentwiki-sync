import {
  DeltaPageSchema,
  RevisionHeadResponseSchema,
  SnapshotPageSchema,
  SyncSpaceListResponseSchema,
  type DeltaItem,
  type RevisionHeadResponse,
  type SnapshotPage,
  type SyncSpaceListResponse,
  type SyncPage,
} from "./protocol";
import type { HttpPort, HttpResponse } from "../ports/http";
import { retryRead } from "./retry";

export function normalizeServerUrl(input: string, development = false): string {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new TypeError(
      "Server URL must be an origin without credentials, path, query, or fragment",
    );
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "https:" &&
    !(development && url.protocol === "http:" && loopback)
  )
    throw new TypeError("Server URL must use HTTPS");
  return url.origin;
}

export class AgentWikiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Record<string, string> = {},
    message = `AgentWiki request failed (${status})`,
  ) {
    super(message);
  }
}

export class AgentWikiClient {
  constructor(
    private readonly serverUrl: string,
    private readonly http: HttpPort,
    private readonly credential: () => string | null,
  ) {}

  async raw(
    method: string,
    path: string,
    body?: unknown,
    authenticated = true,
    canonical = false,
  ): Promise<HttpResponse> {
    const secret = authenticated ? this.credential() : null;
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (secret) headers.Authorization = `Bearer ${secret}`;
    const response = await this.http.request({
      method,
      url: `${this.serverUrl}${path}`,
      body,
      canonicalBody:
        canonical && body !== undefined
          ? (await import("./protocol")).canonicalBytes(body)
          : undefined,
      headers,
    });
    if (response.status >= 300 && response.status < 400)
      throw new AgentWikiHttpError(
        response.status,
        response.json,
        response.headers,
        "AgentWiki routes must not redirect",
      );
    if (response.status >= 400)
      throw new AgentWikiHttpError(
        response.status,
        response.json,
        response.headers,
      );
    return response;
  }

  async head(spaceId: string): Promise<RevisionHeadResponse> {
    return retryRead(async () =>
      RevisionHeadResponseSchema.parse(
        (
          await this.raw(
            "GET",
            `/api/sync/v1/spaces/${encodeURIComponent(spaceId)}/head`,
          )
        ).json,
      ),
    );
  }

  async spaces(): Promise<SyncSpaceListResponse> {
    return SyncSpaceListResponseSchema.parse(
      (await this.raw("GET", "/api/sync/v1/spaces")).json,
    );
  }

  async snapshot(
    spaceId: string,
    revision = "current",
  ): Promise<{
    metadata: Omit<SnapshotPage, "items" | "nextCursor">;
    items: SyncPage[];
  }> {
    let metadata: Omit<SnapshotPage, "items" | "nextCursor"> | null = null;
    const items: SyncPage[] = [];
    for await (const page of this.snapshotPages(spaceId, revision)) {
      metadata ??= page.metadata;
      items.push(...page.items);
    }
    if (!metadata) throw new Error("快照未返回元数据");
    return { metadata, items };
  }

  async *snapshotPages(
    spaceId: string,
    revision = "current",
  ): AsyncIterable<{
    metadata: Omit<SnapshotPage, "items" | "nextCursor">;
    items: SyncPage[];
  }> {
    let cursor: string | null = null;
    let requestRevision = revision;
    let fixed: Omit<SnapshotPage, "items" | "nextCursor"> | null = null;
    do {
      const query = new URLSearchParams({ revision: requestRevision });
      if (cursor) query.set("cursor", cursor);
      const page = await retryRead(async () =>
        SnapshotPageSchema.parse(
          (
            await this.raw(
              "GET",
              `/api/sync/v1/spaces/${encodeURIComponent(spaceId)}/snapshot?${query}`,
            )
          ).json,
        ),
      );
      const metadata = {
        protocolVersion: page.protocolVersion,
        spaceId: page.spaceId,
        revision: page.revision,
        sequence: page.sequence,
        revisionContentHash: page.revisionContentHash,
        pageCount: page.pageCount,
        revisionManifestByteLength: page.revisionManifestByteLength,
        revisionBodyBytes: page.revisionBodyBytes,
      };
      if (fixed && JSON.stringify(fixed) !== JSON.stringify(metadata))
        throw new Error("快照分页元数据已变更");
      fixed ??= metadata;
      requestRevision = page.revision;
      yield { metadata, items: page.items };
      cursor = page.nextCursor;
    } while (cursor);
    if (!fixed) throw new Error("快照未返回元数据");
  }

  async delta(
    spaceId: string,
    from: string,
  ): Promise<{ toRevision: string; items: DeltaItem[] }> {
    let cursor: string | null = null;
    let fixed: string | null = null;
    const items: DeltaItem[] = [];
    do {
      const query = new URLSearchParams({ from });
      if (cursor) query.set("cursor", cursor);
      const page = await retryRead(async () =>
        DeltaPageSchema.parse(
          (
            await this.raw(
              "GET",
              `/api/sync/v1/spaces/${encodeURIComponent(spaceId)}/delta?${query}`,
            )
          ).json,
        ),
      );
      const signature = JSON.stringify([
        page.fromRevision,
        page.toRevision,
        page.toSequence,
        page.toRevisionContentHash,
        page.toPageCount,
        page.toRevisionManifestByteLength,
        page.toRevisionBodyBytes,
      ]);
      if (fixed && fixed !== signature) throw new Error("增量分页元数据已变更");
      fixed ??= signature;
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return {
      toRevision: fixed ? (JSON.parse(fixed)[1] as string) : from,
      items,
    };
  }
}
