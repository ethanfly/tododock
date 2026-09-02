import { describe, expect, it } from "vitest";

import { defaultAppSettings } from "./api";
import { isLlmConfigured } from "./llm";

describe("isLlmConfigured", () => {
  it("requires a key for remote endpoints and allows empty keys on localhost", () => {
    expect(isLlmConfigured(defaultAppSettings)).toBe(false);
    expect(isLlmConfigured({ ...defaultAppSettings, llmApiKey: "xai-key" })).toBe(true);
    expect(isLlmConfigured({
      llmEndpoint: "http://127.0.0.1:11434/v1",
      llmApiKey: "",
    })).toBe(true);
    expect(isLlmConfigured({ llmEndpoint: "", llmApiKey: "xai-key" })).toBe(false);
  });
});
