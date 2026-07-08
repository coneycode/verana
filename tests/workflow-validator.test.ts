import { validateGraphWorkflow } from "../src/workflow-validator.js";
import type { GraphWorkflowSpec } from "../src/types.js";

function makeSpec(overrides: Partial<GraphWorkflowSpec> = {}): GraphWorkflowSpec {
  return {
    version: "0.2",
    project_id: "test",
    phase: "solution",
    flow_type: "graph",
    goal: { raw: "r", clarified: "c", deliverable_type: "creative", iterative: true, acceptance: ["a1"] },
    clarifications: [],
    required_capabilities: ["web"],
    selected_executor: "hermes",
    agents: ["writer"],
    skills: [],
    scripts: [],
    capabilities: [{
      id: "write_chapter", kind: "agent", desc: "写一章",
      checks: [{ method: "llm_rubric", desc: ">=3000字" }],
      updates: ["summary"],
    }],
    guardrails: { hard: { max_iterations: 30 }, soft: [], human_checkpoint_every: 3 },
    blackboard_schema: { fields: [{ key: "summary", desc: "摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到20章"],
    hard_constraints: [],
    soft_guidance: [],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
    ...overrides,
  };
}

import { test } from "node:test";
import assert from "node:assert";

test("valid spec passes", () => {
  const r = validateGraphWorkflow(makeSpec());
  assert.ok(r.passed, r.errors.join("; "));
});

test("empty capabilities fails", () => {
  const r = validateGraphWorkflow(makeSpec({ capabilities: [] }));
  assert.ok(!r.passed);
  assert.ok(r.errors.some((e: string) => e.includes("capabilities")));
});

test("no max_iterations fails (no safety valve)", () => {
  const r = validateGraphWorkflow(makeSpec({ guardrails: { hard: { max_iterations: 0 }, soft: [], human_checkpoint_every: 3 } }));
  assert.ok(!r.passed);
  assert.ok(r.errors.some((e: string) => e.includes("max_iterations")));
});

test("bounded field with no updater fails", () => {
  const r = validateGraphWorkflow(makeSpec({ blackboard_schema: { fields: [{ key: "chars", desc: "人物", bounded: true }] } }));
  assert.ok(!r.passed);
  assert.ok(r.errors.some((e: string) => e.includes("no node updates")));
});

test("node without checks fails", () => {
  const r = validateGraphWorkflow(makeSpec({ capabilities: [{ id: "x", kind: "light", desc: "d", checks: [] }] }));
  assert.ok(!r.passed);
  assert.ok(r.errors.some((e: string) => e.includes("checks")));
});
