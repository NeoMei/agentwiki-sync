const MAX_SIGNED_BIGINT = 9223372036854775807n;

export function parseDecimalCount(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value))
    throw new TypeError("Invalid canonical decimal count");
  const parsed = BigInt(value);
  if (parsed > MAX_SIGNED_BIGINT)
    throw new RangeError("Decimal count exceeds signed bigint");
  return parsed;
}

export function decimalWithinLimit(value: string, limit: number): number {
  const parsed = parseDecimalCount(value);
  if (parsed > BigInt(limit)) throw new RangeError("SPACE_TOO_LARGE");
  return Number(parsed);
}
