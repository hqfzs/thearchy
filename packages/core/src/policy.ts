import type { ModelPolicy } from "./types.js";

export const DEFAULT_MODEL_POLICY: ModelPolicy = {
  model: "gpt-5.6-luna",
  reasoningEffort: "max",
  preserveMainModel: true
};
