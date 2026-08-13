import { expect, it } from "vitest";
import { idFileKey } from "../../src/core/identity-key";

it("maps validated IDs to full lowercase SHA-256 file keys", async () => {
  expect(await idFileKey("Page-A")).toMatch(/^[0-9a-f]{64}$/);
  expect(await idFileKey("Page-A")).not.toBe(await idFileKey("page-a"));
  await expect(idFileKey("../bad")).rejects.toThrow();
});
