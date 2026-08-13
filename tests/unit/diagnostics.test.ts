import { expect, it } from "vitest";
import { redactDiagnostic } from "../../src/core/diagnostics";

it("recursively redacts secrets and Markdown bodies", () => {
  expect(
    redactDiagnostic({
      authorization: "Bearer secret",
      nested: { credentialSecretId: "id", body: "private", status: 500 },
      paths: ["A.md"],
    }),
  ).toEqual({
    authorization: "[redacted]",
    nested: {
      credentialSecretId: "[redacted]",
      body: "[redacted]",
      status: 500,
    },
    paths: ["A.md"],
  });
});
