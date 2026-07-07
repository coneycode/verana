import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /** 完成一次 LLM 调用。onDelta 可选 — 若提供,LLM 流式产出的每个文本片段会回调推送。最终返回完整文本。 */
  complete(role: ModelRole, system: string, user: string, onDelta?: (delta: string) => void): Promise<string>;
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

  async complete(role: ModelRole, system: string, user: string, onDelta?: (delta: string) => void): Promise<string> {
    const cfg = this.config[role];
    const url = `${cfg.base_url.replace(/\/$/, "")}/v1/messages`;
    const body: Record<string, unknown> = {
      model: cfg.model,
      max_tokens: 8192,
      system,
      messages: [{ role: "user", content: user }],
    };
    // 有 onDelta → 流式;否则非流式(省一个 SSE 解析层)
    if (onDelta) body.stream = true;

    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": cfg.api_key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 && attempt < maxRetries) {
        console.log(`[llm] ${role} got 429, waiting 60s before retry (${attempt + 1}/${maxRetries})...`);
        await sleep(60_000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM ${role} call failed (${res.status}): ${text.slice(0, 500)}`);
      }

      // 非流式:一次性 JSON
      if (!onDelta || !res.body) {
        const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
        const textBlock = data.content?.find((block) => block.type === "text");
        const content = textBlock?.text;
        if (!content) throw new Error(`LLM ${role} returned empty content`);
        return content;
      }

      // 流式:逐 event 解析,每个 content_block_delta 推 delta
      let full = "";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE 事件以 \n\n 分隔
        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const line = rawEvent.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const jsonStr = line.slice(5).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(jsonStr) as { type: string; delta?: { type: string; text?: string } };
            if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
              full += evt.delta.text;
              onDelta(evt.delta.text);
            }
          } catch { /* malformed event line, skip */ }
        }
      }
      if (!full) throw new Error(`LLM ${role} stream returned empty content`);
      return full;
    }
    throw new Error(`LLM ${role} call failed: exhausted 429 retries`);
  }

  async completeJson<T = unknown>(role: ModelRole, system: string, user: string): Promise<T> {
    const raw = await this.complete(role, system, user);
    return parseJsonLoose<T>(raw);
  }
}

export function parseJsonLoose<T = unknown>(raw: string): T {
  let fenced = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const start = fenced.search(/[[{]/);
  const end = Math.max(fenced.lastIndexOf("}"), fenced.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error(`No JSON found in LLM output: ${raw.slice(0, 200)}`);
  const jsonStr = fenced.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr) as T;
  } catch (e1) {
    // 容错:尝试修复常见问题 — 字符串值内未转义的换行/引号
    try {
      const fixed = repairJson(jsonStr);
      return JSON.parse(fixed) as T;
    } catch {
      // 最后兜底:逐字段提取(适用于扁平对象)
      const extracted = extractFieldsLoose(jsonStr);
      if (extracted) return extracted as T;
      throw new Error(`JSON parse failed even after repair: ${(e1 as Error).message} | raw: ${raw.slice(0, 200)}`);
    }
  }
}

/** 修复 JSON 字符串值内的未转义字符(换行/制表符/内部引号) */
function repairJson(s: string): string {
  let result = "";
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && (i === 0 || s[i - 1] !== "\\")) {
      inString = !inString;
      result += ch;
    } else if (inString && ch === "\n") {
      result += "\\n";
    } else if (inString && ch === "\r") {
      result += "\\r";
    } else if (inString && ch === "\t") {
      result += "\\t";
    } else {
      result += ch;
    }
  }
  return result;
}

/** 扁平对象的宽松提取:从 "key": "value" 对中提取字段(最后兜底) */
function extractFieldsLoose(s: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  const re = /"(\w+)"\s*:\s*("(?:[^"\\]|\\.)*"|true|false|null|\d+(?:\.\d+)?)/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const key = match[1];
    let val: unknown = match[2];
    if (val === "true") val = true;
    else if (val === "false") val = false;
    else if (val === "null") val = null;
    else if (typeof val === "string" && val.startsWith('"')) val = val.slice(1, -1);
    else if (typeof val === "string") val = Number(val);
    result[key] = val;
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Backward-compat stub for old tests
export class ConfiguredLlmClient implements LlmClient {
  constructor(private readonly configs: { composer: { model: string; base_url?: string; api_key?: string }; evaluator: { model: string; base_url?: string; api_key?: string } }) {}

  async complete(role: ModelRole, _system: string, _user: string, _onDelta?: (delta: string) => void): Promise<string> {
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
