import type { SecretPort } from "../../src/ports/secrets";
export class MemorySecrets implements SecretPort {
  readonly values = new Map<string, string>();
  get(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string): void {
    if (!/^[a-z0-9-]{1,64}$/u.test(id)) throw new Error("密钥 ID 无效");
    this.values.set(id, value);
  }
}
