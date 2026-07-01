export type ModelRole = "composer" | "evaluator";

export interface ModelConfig {
  role: ModelRole;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
}

export interface LlmClient {
  complete(role: ModelRole, prompt: string): Promise<string>;
}

export class ConfiguredLlmClient implements LlmClient {
  constructor(private readonly configs: Record<ModelRole, ModelConfig>) {}

  async complete(role: ModelRole, prompt: string): Promise<string> {
    const config = this.configs[role];
    if (!config) throw new Error(`Missing model config for ${role}`);
    if (prompt.trim().length === 0) throw new Error("Prompt is empty");

    return JSON.stringify({
      role,
      model: config.model,
      note: "MVP placeholder: wire provider call here",
    });
  }
}

export function defaultModelConfigs(): Record<ModelRole, ModelConfig> {
  return {
    composer: { role: "composer", model: process.env.VERANA_COMPOSER_MODEL ?? "composer-model-placeholder" },
    evaluator: { role: "evaluator", model: process.env.VERANA_EVALUATOR_MODEL ?? "evaluator-model-placeholder" },
  };
}
