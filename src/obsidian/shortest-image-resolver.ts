import { FlatAttachmentPathSchema } from "@neomei/agentwiki-sync-protocol";
import { caseFold } from "unicode-case-folding";
import {
  normalizePath,
  type MetadataCache,
  type TFile,
  type Vault,
} from "obsidian";

import type { ShortestImageResolution } from "../ports/vault";

export class ObsidianShortestImageResolver {
  private readonly root: string;
  private basenameIndex: Map<string, TFile[]> | null = null;

  constructor(
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    mappingRoot: string,
  ) {
    this.root = normalizePath(mappingRoot).normalize("NFC");
  }

  invalidate(): void {
    this.basenameIndex = null;
  }

  private index(): Map<string, TFile[]> {
    if (this.basenameIndex) return this.basenameIndex;
    const index = new Map<string, TFile[]>();
    for (const file of this.vault.getFiles()) {
      const basename = file.path.slice(file.path.lastIndexOf("/") + 1);
      const key = caseFold(basename.normalize("NFC"));
      const matches = index.get(key) ?? [];
      matches.push(file);
      index.set(key, matches);
    }
    this.basenameIndex = index;
    return index;
  }

  async resolve(
    pagePath: string,
    decodedBasename: string,
  ): Promise<ShortestImageResolution> {
    const normalizedPagePath = pagePath.normalize("NFC");
    const normalizedBasename = decodedBasename.normalize("NFC");
    const pageSegments = normalizedPagePath.split("/");
    const parsedAttachment = FlatAttachmentPathSchema.safeParse(
      `assets/${normalizedBasename}`,
    );
    if (
      normalizedPagePath.includes("\\") ||
      !normalizedPagePath.startsWith("pages/") ||
      !normalizedPagePath.endsWith(".md") ||
      pageSegments.some(
        (segment) => segment === "" || segment === "." || segment === "..",
      ) ||
      normalizedBasename.includes("/") ||
      normalizedBasename.includes("\\") ||
      !/\.(?:png|jpe?g|webp|gif)$/iu.test(normalizedBasename) ||
      !parsedAttachment.success
    )
      return { kind: "out_of_scope" };

    const basenameKey = caseFold(normalizedBasename);
    const matches = this.index().get(basenameKey) ?? [];
    if (matches.length === 0) return { kind: "missing" };
    if (matches.length !== 1) return { kind: "ambiguous" };
    const match = matches[0]!;
    const sourcePath = this.root
      ? `${this.root}/${normalizedPagePath}`
      : normalizedPagePath;
    let metadataTarget: TFile | null;
    try {
      metadataTarget = this.metadataCache.getFirstLinkpathDest(
        normalizedBasename,
        sourcePath,
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (!metadataTarget) return { kind: "missing" };
    if (
      normalizePath(metadataTarget.path).normalize("NFC") !==
      normalizePath(match.path).normalize("NFC")
    )
      return { kind: "ambiguous" };

    const matchPath = normalizePath(match.path).normalize("NFC");
    const rootPrefix = this.root ? `${this.root}/` : "";
    if (rootPrefix && !matchPath.startsWith(rootPrefix))
      return { kind: "out_of_scope" };
    const mappedPath = matchPath.slice(rootPrefix.length);
    const parsedMappedPath = FlatAttachmentPathSchema.safeParse(mappedPath);
    if (!parsedMappedPath.success) return { kind: "out_of_scope" };
    return {
      kind: "resolved",
      attachmentPath: parsedMappedPath.data,
      basenameKey,
    };
  }
}
