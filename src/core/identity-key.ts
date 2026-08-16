import { sha256Hex } from "../agentwiki/protocol";

const publicId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validatePublicId(id: string): void {
  if (!publicId.test(id)) throw new TypeError("Invalid public ID");
}

export async function idFileKey(id: string): Promise<string> {
  validatePublicId(id);
  return sha256Hex(new TextEncoder().encode(id));
}
export async function opaqueFileKey(id: string): Promise<string> {
  if (!id) throw new TypeError("Empty file identity");
  return `p-${await sha256Hex(new TextEncoder().encode(id))}`;
}
