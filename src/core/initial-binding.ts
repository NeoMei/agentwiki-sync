import type { ScannedFile } from "./model";
import { titleFromPath } from "./portable-path";

export interface RemoteBindingPage {
  pageId: string;
  path: string;
  title: string;
  body: string;
  contentHash: string;
}

export interface ExplicitBindingChoice {
  localPath: string;
  remotePageId: string;
  finalPath: string;
  finalBody: string;
}

export interface BoundPage {
  pageId: string;
  relativePath: string;
  title: string;
  body: string;
  contentHash: string;
}

export function buildInitialBindingPreview(
  local: ScannedFile[],
  remote: RemoteBindingPage[],
  choices: ExplicitBindingChoice[] = [],
): { base: BoundPage[]; vault: BoundPage[]; dirty: string[] } {
  const localByPath = new Map(local.map((page) => [page.relativePath, page]));
  const choicesByRemote = new Map(
    choices.map((choice) => [choice.remotePageId, choice]),
  );
  const base = remote.map((page) => ({
    pageId: page.pageId,
    relativePath: page.path,
    title: page.title,
    body: page.body,
    contentHash: page.contentHash,
  }));
  const vault: BoundPage[] = [];
  const dirty: string[] = [];
  for (const remotePage of remote) {
    const choice = choicesByRemote.get(remotePage.pageId);
    const samePath = localByPath.get(remotePage.path);
    if (choice) {
      const localPage = localByPath.get(choice.localPath);
      if (!localPage)
        throw new TypeError("Explicit binding references a missing local page");
      vault.push({
        pageId: remotePage.pageId,
        relativePath: choice.finalPath,
        title: titleFromPath(choice.finalPath),
        body: choice.finalBody,
        contentHash: localPage.contentHash,
      });
      if (
        choice.finalPath !== remotePage.path ||
        choice.finalBody !== remotePage.body ||
        titleFromPath(choice.finalPath) !== remotePage.title
      )
        dirty.push(remotePage.pageId);
    } else if (samePath) {
      if (samePath.normalizedBody === undefined)
        throw new TypeError("Initial binding requires retained local bodies");
      vault.push({
        pageId: remotePage.pageId,
        relativePath: samePath.relativePath,
        title: samePath.title,
        body: samePath.normalizedBody,
        contentHash: samePath.contentHash,
      });
      if (
        samePath.contentHash !== remotePage.contentHash ||
        samePath.title !== remotePage.title
      )
        dirty.push(remotePage.pageId);
    } else {
      vault.push({
        pageId: remotePage.pageId,
        relativePath: remotePage.path,
        title: remotePage.title,
        body: remotePage.body,
        contentHash: remotePage.contentHash,
      });
    }
  }
  return { base, vault, dirty };
}
