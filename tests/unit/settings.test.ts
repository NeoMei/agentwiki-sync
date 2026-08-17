import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVER_URL,
  DEFAULT_SETTINGS,
  parseSettings,
} from "../../src/application/settings";

describe("settings defaults", () => {
  it("prefills the official server URL so mobile users do not type it", () => {
    expect(DEFAULT_SETTINGS.serverUrl).toBe(DEFAULT_SERVER_URL);
    expect(DEFAULT_SERVER_URL).toBe("https://agentwiki.quukk.com");
  });

  it("preserves an explicitly saved server URL, including empty self-host pending", () => {
    expect(
      parseSettings({
        schemaVersion: 1,
        serverUrl: "https://self.example.com",
        serverInstanceId: null,
        mappings: [],
      }).serverUrl,
    ).toBe("https://self.example.com");
  });
});
