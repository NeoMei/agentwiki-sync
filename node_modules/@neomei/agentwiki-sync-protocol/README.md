# @neomei/agentwiki-sync-protocol

Browser-compatible canonicalization, hashing, normalization, and schema primitives for AgentWiki Sync v1.

This package contains no Node built-ins, performs no network requests, and persists no credentials. Hashing uses Web Crypto.

## Usage

```ts
import { contentHash, pathKey, canonicalBytes } from "@neomei/agentwiki-sync-protocol";

const hash = await contentHash("Hello\n");
const key = pathKey("Straße/İ.MD");
const bytes = canonicalBytes({ protocolVersion: "1", spaceId: "space-a" });
```
