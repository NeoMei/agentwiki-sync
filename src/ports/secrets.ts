export interface SecretPort {
  get(id: string): string | null;
  set(id: string, value: string): void;
}
