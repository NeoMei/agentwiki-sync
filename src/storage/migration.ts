import { opaqueFileKey } from "../core/identity-key";
import { isValidSyncPath } from "../core/sync-path";
import { contentHash } from "../agentwiki/protocol";
import type { ControlStorePort } from "../ports/control-store";

interface ManifestRecord {
  pages: Record<string, PageRecord>;
}

interface PageRecord {
  relativePath: string;
  contentHash?: string;
}

interface JournalRecord {
  payload: { changes: ChangeRecord[] };
}

interface ChangeRecord {
  operation: string;
  pageId: string;
  path?: string;
  contentHash?: string;
}

function isManifestRecord(value: unknown): value is ManifestRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "pages" in value &&
    typeof (value as ManifestRecord).pages === "object" &&
    (value as ManifestRecord).pages !== null
  );
}

function isPageRecord(value: unknown): value is PageRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PageRecord).relativePath === "string"
  );
}

function isJournalRecord(value: unknown): value is JournalRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "payload" in value &&
    typeof (value as JournalRecord).payload === "object" &&
    (value as JournalRecord).payload !== null &&
    Array.isArray((value as JournalRecord).payload.changes)
  );
}

function isChangeRecord(value: unknown): value is ChangeRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ChangeRecord).operation === "string" &&
    typeof (value as ChangeRecord).pageId === "string"
  );
}

/**
 * 迁移工具：将哈希文件名迁移到可读文件名
 *
 * 迁移策略：
 * 1. 扫描所有 generation 目录
 * 2. 对于每个 base/ 目录下的 p-{hash}.md 文件
 * 3. 从 manifest.json 读取对应的 relativePath
 * 4. 如果 relativePath 合法，重命名为可读路径
 * 5. 保留原文件作为备份，直到验证成功
 */
export class StorageMigration {
  constructor(private readonly store: ControlStorePort) {}

  /**
   * 迁移单个 generation 的 base bodies
   */
  async migrateGeneration(
    generationRoot: string,
    generationId: string,
  ): Promise<{ migrated: number; skipped: number; errors: string[] }> {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] };

    try {
      // 读取 manifest
      const manifestPath = `${generationRoot}/generations/${generationId}/manifest.json`;
      const manifestRaw = await this.store.read(manifestPath);
      if (!manifestRaw) {
        result.errors.push(`Manifest not found: ${manifestPath}`);
        return result;
      }

      const manifest: unknown = JSON.parse(manifestRaw);
      if (!isManifestRecord(manifest)) {
        result.errors.push(`Invalid manifest: missing pages`);
        return result;
      }

      // 迁移每个页面
      for (const [pageId, page] of Object.entries(manifest.pages)) {
        if (!isPageRecord(page)) {
          result.skipped++;
          continue;
        }
        const pageData = page;
        const hashFileName = `p-${await opaqueFileKey(pageId)}.md`;
        const hashPath = `${generationRoot}/generations/${generationId}/base/${hashFileName}`;

        // 检查是否使用可读路径
        if (!isValidSyncPath(pageData.relativePath)) {
          result.skipped++;
          continue;
        }

        const readablePath = `${generationRoot}/generations/${generationId}/base/${pageData.relativePath}`;

        // 检查可读路径文件是否已存在
        const readableExists = await this.store.read(readablePath);
        if (readableExists !== null) {
          // 可读路径已存在，跳过
          result.skipped++;
          continue;
        }

        // 读取哈希路径文件
        const hashContent = await this.store.read(hashPath);
        if (hashContent === null) {
          result.errors.push(`Hash file not found: ${hashPath}`);
          continue;
        }

        // 验证内容哈希是否匹配 manifest
        if (
          page.contentHash &&
          (await contentHash(hashContent)) !==
            page.contentHash
        )
          throw new Error(`迁移内容哈希不匹配：${hashPath}`);

        // 写入可读路径
        await this.store.write(readablePath, hashContent);

        // 删除哈希路径文件
        await this.store.remove(hashPath);

        result.migrated++;
      }
    } catch (error) {
      result.errors.push(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }

  /**
   * 迁移 push payload 文件
   */
  async migratePushPayloads(
    pushRoot: string,
  ): Promise<{ migrated: number; skipped: number; errors: string[] }> {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] };

    try {
      // 读取 journal
      const journalPath = `${pushRoot}/journal.json`;
      const journalRaw = await this.store.read(journalPath);
      if (!journalRaw) {
        // 没有 journal，无需迁移
        return result;
      }

      const journal: unknown = JSON.parse(journalRaw);
      if (!isJournalRecord(journal)) {
        return result;
      }

      // 迁移每个 change
      for (const change of journal.payload.changes) {
        if (!isChangeRecord(change)) continue;
        if (change.operation !== "upsert") continue;

        const hashFileName = `p-${await opaqueFileKey(change.pageId)}.md`;
        const hashPath = `${pushRoot}/payload/${hashFileName}`;

        // 检查是否使用可读路径
        if (!change.path || !isValidSyncPath(change.path)) {
          result.skipped++;
          continue;
        }

        const readablePath = `${pushRoot}/payload/${change.path}`;

        // 检查可读路径文件是否已存在
        const readableExists = await this.store.read(readablePath);
        if (readableExists !== null) {
          result.skipped++;
          continue;
        }

        // 读取哈希路径文件
        const hashContent = await this.store.read(hashPath);
        if (hashContent === null) {
          // 哈希文件不存在，可能已经迁移或删除
          continue;
        }

        // 验证内容哈希是否匹配 journal
        if (
          change.contentHash &&
          (await contentHash(hashContent)) !==
            change.contentHash
        )
          throw new Error(`迁移内容哈希不匹配：${hashPath}`);

        // 写入可读路径
        await this.store.write(readablePath, hashContent);

        // 删除哈希路径文件
        await this.store.remove(hashPath);

        result.migrated++;
      }
    } catch (error) {
      result.errors.push(
        `Migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return result;
  }
}
