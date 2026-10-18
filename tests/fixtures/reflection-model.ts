import type { Model } from "@earendil-works/pi-ai";

export const reflectionTestModel: Model<"openai-completions"> = {
  id: "reflection-test",
  name: "Reflection test",
  api: "openai-completions",
  provider: "test",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};
