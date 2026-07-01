import assert from "node:assert/strict";
import test from "node:test";

import { ConfiguredLlmClient } from "../src/llm.js";

test("ConfiguredLlmClient keeps composer and evaluator model roles separate", async () => {
  const configs = {
    composer: { role: "composer" as const, model: "composer-a", base_url: "", api_key: "" },
    evaluator: { role: "evaluator" as const, model: "evaluator-b", base_url: "", api_key: "" },
  };
  const client = new ConfiguredLlmClient(configs);

  const composer = JSON.parse(await client.complete("composer", "sys", "usr"));
  const evaluator = JSON.parse(await client.complete("evaluator", "sys", "usr"));

  assert.equal(composer.role, "composer");
  assert.equal(evaluator.role, "evaluator");
  assert.notEqual(composer.model, evaluator.model);
});

test("parseJsonLoose extracts JSON from fenced LLM output", async () => {
  const { parseJsonLoose } = await import("../src/llm.js");
  const raw = '```json\n{"passed": true, "reasons": ["ok"]}\n```';
  const result = parseJsonLoose<{ passed: boolean; reasons: string[] }>(raw);
  assert.equal(result.passed, true);
  assert.equal(result.reasons[0], "ok");
});

test("normalizeConfig rejects same model for composer and evaluator", async () => {
  const { normalizeConfig } = await import("../src/llm.js");
  assert.throws(() =>
    normalizeConfig({
      composer: { role: "composer", base_url: "x", model: "same", api_key: "k" },
      evaluator: { role: "evaluator", base_url: "x", model: "same", api_key: "k" },
    }),
  );
});
