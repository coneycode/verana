import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

export type ModelRole = "composer" | "evaluator";

export interface ModelConfig {
  role: ModelRole;
  base_url: string;
  model: string;
  api_key: string;
}

export interface VeranaConfig {
  composer: ModelConfig;
  evaluator: ModelConfig;
}

export interface LlmClient {
  complete(role: ModelRole, system: string, user: string): Promise<string>;
  completeJson<T = unknown>(role: ModelRole, system: string, user: string): Promise<T>;
}

const CONFIG_PATHS = ["verana.config.yaml", "verana.config.yml"];

export async function loadConfig(cwd?: string): Promise<VeranaConfig> {
  const base = cwd ?? process.cwd();
  for (const name of CONFIG_PATHS) {
    const path = join(base, name);
    if (existsSync(path)) {
      const raw = parse(await readFile(path, "utf8")) as Partial<VeranaConfig>;
      return normalizeConfig(raw);
    }
  }
  throw new Error(`Verana config not found. Copy verana.config.example.yaml to ${CONFIG_PATHS[0]} and fill in your models.`);
}

export function normalizeConfig(raw: Partial<VeranaConfig>): VeranaConfig {
  const composer = normalizeRole(raw.composer, "composer");
  const evaluator = normalizeRole(raw.evaluator, "evaluator");
  if (composer.model === evaluator.model && composer.base_url === evaluator.base_url) {
    throw new Error("composer and evaluator must be different models (design doc section 8).");
  }
  return { composer, evaluator };
}

function normalizeRole(raw: Partial<ModelConfig> | undefined, role: ModelRole): ModelConfig {
  if (!raw?.base_url) throw new Error(`Missing ${role}.base_url in config`);
  if (!raw?.model) throw new Error(`Missing ${role}.model in config`);
  if (!raw?.api_key) throw new Error(`Missing ${role}.api_key in config`);
  return { role, base_url: raw.base_url, model: raw.model, api_key: raw.api_key };
}

export class HttpLlmClient implements LlmClient {
  constructor(private readonly config: VeranaConfig) {}

  async complete(role: ModelRole, system: string, user: string): Promise<string> {
    const cfg = this.config[role];
    const url = `${cfg.base_url.replace(/\/$/, "")}/chat/completions`;
    const body = {
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LLM ${role} call failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`LLM ${role} returned empty content`);
    return content;
  }

  async completeJson<T = unknown>(role: ModelRole, system: string, user: string): Promise<T> {
    const raw = await this.complete(role, system, user);
    return parseJsonLoose<T>(raw);
  }
}

export function parseJsonLoose<T = unknown>(raw: string): T {
  const fenced = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const start = fenced.search(/[[{]/);
  const end = Math.max(fenced.lastIndexOf("}"), fenced.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error(`No JSON found in LLM output: ${raw.slice(0, 200)}`);
  return JSON.parse(fenced.slice(start, end + 1)) as T;
}

// Backward-compat stub for old tests
export class ConfiguredLlmClient implements LlmClient {
  constructor(private readonly configs: { composer: { model: string; base_url?: string; api_key?: string }; evaluator: { model: string; base_url?: string; api_key?: string } }) {}

  async complete(role: ModelRole, _system: string, _user: string): Promise<string> {
    return JSON.stringify({ role, model: this.configs[role].model });
  }

  async completeJson<T = unknown>(role: ModelRole, system: string, user: string): Promise<T> {
    return JSON.parse(await this.complete(role, system, user)) as T;
  }
}

export function defaultModelConfigs() {
  return {
    composer: { role: "composer" as const, model: process.env.VERANA_COMPOSER_MODEL ?? "composer-model-placeholder" },
    evaluator: { role: "evaluator" as const, model: process.env.VERANA_EVALUATOR_MODEL ?? "evaluator-model-placeholder" },
  };
}
