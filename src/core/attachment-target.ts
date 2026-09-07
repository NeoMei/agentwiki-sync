export function relativeAttachmentPath(
  pagePath: string,
  attachmentPath: string,
): string {
  const from = pagePath.split("/");
  from.pop();
  const to = attachmentPath.split("/");
  let common = 0;
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  )
    common += 1;
  return `${"../".repeat(from.length - common)}${to.slice(common).join("/")}`;
}

export function preserveMarkdownTargetStyle(
  original: string,
  target: string,
  insideAngles: boolean,
): string {
  if (insideAngles) return target;
  if (/%[0-9a-f]{2}/iu.test(original)) return encodeURI(target);
  if (original.includes("\\")) return target.replace(/[ ()]/gu, "\\$&");
  return /\s/u.test(target) ? encodeURI(target) : target;
}
