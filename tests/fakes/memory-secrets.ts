import type { SecretPort } from "../../src/ports/secrets";
export class MemorySecrets implements SecretPort {
  private readonly values = new Map<string, string>();
  get(id: string): string | null {
    return this.values.get(id) ?? null;
  }
  set(id: string, value: string): void {
    this.values.set(id, value);
  }
}
