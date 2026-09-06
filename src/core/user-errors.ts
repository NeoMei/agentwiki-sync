import { AgentWikiHttpError } from "../agentwiki/client";

const errorMessages: Record<string, string> = {
  INSTALLATION_CODE_INVALID: "连接码无效。请在 AgentWiki 网页重新生成。",
  INSTALLATION_CODE_EXPIRED: "连接码已过期。请在 AgentWiki 网页重新生成。",
  INSTALLATION_ALREADY_EXCHANGED:
    "此连接码已被使用。每个连接码只能连接一台设备，请重新生成。",
  INSTALLATION_REVOKED: "此连接码已被撤销。请重新生成。",
  DEVICE_CREDENTIAL_EXPIRED: "设备凭据已过期。请断开后重新连接。",
  DEVICE_CREDENTIAL_REVOKED: "设备凭据已被撤销。请断开后重新连接。",
  USER_INACTIVE: "账号已被停用或锁定。请联系管理员。",
  AUTHENTICATION_REQUIRED: "认证失败。请断开后重新连接。",
  CREDENTIAL_COLLISION: "凭据冲突。请重试，插件会自动重新生成。",
  RATE_LIMITED: "请求过于频繁。请稍后再试。",
  BASE_STALE: "远端已有更新。请先执行拉取（Pull）再推送。",
  SPACE_FORBIDDEN: "没有此空间的访问权限。",
  SPACE_READ_ONLY: "此空间只读，无法推送。请联系管理员获取编辑权限。",
  SPACE_TOO_LARGE: "空间超出同步限制（5000 页 / 100MB）。",
  PAGE_TOO_LARGE: "单页超出大小限制（1MB）。",
  BATCH_TOO_LARGE: "批次超出限制。请分批推送。",
  PUSH_SESSION_EXPIRED: "上传会话已过期。请重新预览并推送。",
  PUSH_SESSION_NOT_FOUND: "上传会话不存在。请重新预览并推送。",
  PUSH_SESSION_STATE_INVALID: "上传会话状态异常。请重新预览并推送。",
  CAPABILITIES_CHANGED: "服务端配置已变更。请重新预览。",
  IDEMPOTENCY_MISMATCH: "请求不一致。请重新预览并推送。",
  REVISION_GONE: "远端版本已过期。请先拉取最新版本。",
  PAYLOAD_INVALID: "数据校验失败。请重新预览。",
  CONFIRMATION_MISMATCH: "确认内容与服务端不匹配。请重新预览。",
  USER_CANCELLED: "用户取消了操作。",
  PROTOCOL_UNSUPPORTED: "协议版本不兼容。请更新插件。",
  INITIAL_PULL_REQUIRED: "远端已有内容。请先拉取（Pull）建立基线。",
  IDENTITY_REQUIRED: "无法唯一确定页面身份。请重命名其中一个文件后重试。",
  PATH_COLLISION: "目标路径已被占用。请选择其他路径。",
  SYNC_PROTOCOL_UPGRADE_REQUIRED:
    "需要升级同步协议。请升级服务端或更新插件后重试。",
  ATTACHMENT_REFERENCE_INVALID:
    "图片引用格式无效。请修复 Page 中的图片引用后重新预览。",
  ATTACHMENT_MISSING:
    "已引用的图片不存在。请恢复图片文件，或移除 Page 中的引用。",
  ATTACHMENT_CONTENT_INVALID:
    "图片内容与格式不符或无法解码。请重新导出为 PNG、JPEG、WebP 或 GIF。",
  ATTACHMENT_NAME_CONFLICT:
    "图片名称在当前系统上会冲突。请重命名其中一张图片。",
  ATTACHMENT_REFERENCED: "图片仍被 Page 引用。请先修改引用，再重新预览。",
  ATTACHMENT_BLOB_MISSING:
    "服务端图片数据不完整。请重新执行 Pull；若仍失败请联系管理员。",
  ATTACHMENT_QUOTA_EXCEEDED:
    "图片超出同步限制。请压缩图片、缩小尺寸或减少本次引用数量。",
  PUSH_CONFIRMATION_REQUIRED:
    "预览后内容或服务端能力已变化。请重新预览并明确确认。",
  V3_PUSH_BLOCKED: "推送预览包含未处理的图片阻塞项。请按预览定位修复后重试。",
  FOLDER_ID_CONFLICT: "目录标识冲突。请重新预览后重试。",
  UPGRADE_REMOTE_PUBLISHED_LOCAL_PENDING:
    "服务器升级已完成，但本地应用尚未完成。请保留当前 Vault 状态，点击“恢复已确认升级”重试；若仍有本地编辑冲突，请先处理冲突，不要重新发起上传。",
};

const localErrorMessages: Record<string, string> = {
  TREE_TRANSACTION_AMBIGUOUS: "同步事务状态不明确。请按恢复指引处理。",
  FOLDER_CYCLE: "目录层级存在循环。请选择其他目标路径。",
  MANUAL_PATH_REQUIRED: "请填写目标路径。",
  MANAGED_ROOT: "目录必须位于 pages/ 下。",
  UNKNOWN_PARENT: "目录缺少父目录。请选择已有目录作为父级。",
  PATH_COLLISION: "目标路径已被占用。请选择其他路径。",
  PAGE_CONFLICT_NOT_FOUND: "页面冲突不存在。请重新预览。",
  FOLDER_CONFLICT_NOT_FOUND: "目录冲突不存在。请重新预览。",
  DUPLICATE_FOLDER_ID: "目录标识重复。",
  DUPLICATE_PAGE_ID: "页面标识重复。",
};

const httpMessages: Record<number, string> = {
  401: "认证失败。连接码无效或已过期，请重新生成。",
  403: "没有执行此操作的权限。",
  404: "资源不存在。请检查服务器地址和空间 ID。",
  429: "请求过于频繁。请稍后再试。",
  500: "服务器内部错误。请稍后再试。",
  502: "服务器暂时不可用。请稍后再试。",
  503: "服务器维护中。请稍后再试。",
};

const protocolValidationMessages: Array<[string, string]> = [
  [
    "Path must be relative and use slash separators",
    "路径必须是相对路径并使用 / 分隔。",
  ],
  [
    "Path contains an empty or relative segment",
    "路径包含空段或相对段。请使用相对路径，不要包含 .. 或 / 开头。",
  ],
  ["Path contains a forbidden character", "路径包含非法字符。"],
  [
    "Path segment has a forbidden trailing character",
    "路径段末尾包含非法字符。",
  ],
  [
    "Path segment is longer than 255 UTF-8 bytes",
    "路径段过长（超过 255 字节）。",
  ],
  [
    "Path uses a reserved Windows device name",
    "路径使用了 Windows 保留设备名。",
  ],
  ["Path is longer than 1024 UTF-8 bytes", "路径过长（超过 1024 字节）。"],
  ["Path must end with .md", "路径必须以 .md 结尾。"],
  ["Invalid Markdown title", "标题格式不正确。"],
  [
    "Sync v2 capability hash mismatch",
    "同步协议能力哈希不匹配。请更新插件后重试。",
  ],
];

/** Convert any error into a user-friendly Chinese message. */
export function userErrorMessage(error: unknown): string {
  if (error instanceof AgentWikiHttpError) {
    const body = error.body as
      { error?: { code?: string; message?: string } } | undefined;
    const code = body?.error?.code;
    const codeMessage = code ? errorMessages[code] : undefined;
    if (codeMessage) return codeMessage;
    const httpMessage = httpMessages[error.status];
    if (httpMessage) return httpMessage;
    return `请求失败（${error.status}）。请稍后再试。`;
  }
  if (error instanceof TypeError && error.message.includes("Server URL")) {
    return "服务器地址格式不正确。请输入完整地址，如 https://agentwiki.quukk.com";
  }
  if (error instanceof Error) {
    const localCode = error.message.match(/^([A-Z][A-Z0-9_]*)(?::|$)/)?.[1];
    if (localCode) {
      const localMessage = localErrorMessages[localCode];
      if (localMessage) return localMessage;
      const protocolMessage = errorMessages[localCode];
      if (protocolMessage) return protocolMessage;
    }
    for (const [needle, message] of protocolValidationMessages)
      if (error.message.includes(needle)) return message;
    if (error.message === "MAPPING_ROOT_MISSING")
      return "映射的本地文件夹不存在。请重新创建该文件夹，或在设置中更改映射目录。";
    if (error.message === "MAPPING_ROOT_NOT_DIRECTORY")
      return "映射路径指向了文件而不是文件夹。请在设置中更改映射目录。";
    if (error.message.includes("Path contains"))
      return "路径格式不正确。请使用相对路径，不要包含 .. 或 / 开头。";
    if (error.message.includes("映射根路径重叠"))
      return "映射目录不能重叠。请选择不同的文件夹。";
    if (error.message.includes("库身份不匹配"))
      return "库身份不匹配。请检查是否连接了正确的服务器和库。";
    if (error.message.includes("设备会话身份不匹配"))
      return "会话身份验证失败。请断开后重新连接。";
    if (error.message.includes("凭据激活未确认"))
      return "凭据激活未确认。请断开后重新连接。";
    if (error.message.includes("连接日志"))
      return "连接状态异常。请断开后重新连接。";
    if (error.message.includes("Secret Storage"))
      return "无法访问安全存储。请重启 Obsidian 后重试。";
    if (error.message.includes("network"))
      return "网络连接失败。请检查网络和服务器地址。";
    if (error.message.includes("fetch failed"))
      return "无法连接服务器。请检查网络和服务器地址。";
  }
  return error instanceof Error ? error.message : "未知错误";
}
