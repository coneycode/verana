import assert from "node:assert/strict";
import test from "node:test";

import { ConfiguredLlmClient, defaultModelConfigs } from "../src/llm.js";

test("ConfiguredLlmClient keeps composer and evaluator model roles separate", async () => {
  const configs = defaultModelConfigs();
  configs.composer.model = "composer-a";
  configs.evaluator.model = "evaluator-b";
  const client = new ConfiguredLlmClient(configs);

  const composer = JSON.parse(await client.complete("composer", "compose"));
  const evaluator = JSON.parse(await client.complete("evaluator", "evaluate"));

  assert.equal(composer.role, "composer");
  assert.equal(evaluator.role, "evaluator");
  assert.notEqual(composer.model, evaluator.model);
});
