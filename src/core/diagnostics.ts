const sensitiveKey =
  /(?:authorization|cookie|credential|secret|code|markdown|body)/iu;

export function redactDiagnostic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnostic);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>))
    result[key] = sensitiveKey.test(key)
      ? "[redacted]"
      : redactDiagnostic(item);
  return result;
}
