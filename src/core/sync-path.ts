import { validatePortablePath } from "./portable-path";

/**
 * 校验是否为合法的 syncPath（可读路径）
 * syncPath 必须是合法的 portable path，且以 .md 结尾
 */
export function isValidSyncPath(path: string): boolean {
  try {
    const validated = validatePortablePath(path);
    return validated.path.endsWith(".md");
  } catch {
    return false;
  }
}
