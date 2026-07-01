import assert from "node:assert/strict";
import test from "node:test";

import { validateWorkflowSpec } from "../src/workflow-validator.js";
import type { WorkflowSpec } from "../src/types.js";

test("validateWorkflowSpec rejects missing checks, missing dependencies, invalid gate bounces, and cycles", () => {
  const invalid = baseWorkflow({
    tasks: [
      { id: "t1", desc: "one", agent: "a", outputs: [], checks: [], depends_on: ["t3"] },
      { id: "t2", desc: "two", agent: "a", outputs: [], checks: [{ method: "manual", desc: "ok" }], depends_on: ["t1"] },
      { id: "t3", desc: "three", agent: "a", outputs: [], checks: [{ method: "manual", desc: "ok" }], depends_on: ["t2"] },
    ],
    gates: [
      {
        id: "g1",
        type: "human_approval",
        title: "gate",
        options: ["approve", "reject"],
        on_reject: { bounce_to: "missing", cascade: "downstream", feedback_to_context: true },
      },
    ],
  });

  const result = validateWorkflowSpec(invalid);

  assert.equal(result.passed, false);
  assert.equal(result.errors.some((error) => error.includes("has no checks")), true);
  assert.equal(result.errors.some((error) => error.includes("bounces to missing task")), true);
  assert.equal(result.errors.some((error) => error.includes("DAG cycle")), true);
});

test("validateWorkflowSpec accepts a well-formed workflow", () => {
  const valid = baseWorkflow({
    tasks: [
      { id: "t1", desc: "one", agent: "a", outputs: [], checks: [{ method: "manual", desc: "ok" }] },
      { id: "t2", desc: "two", agent: "a", outputs: [], checks: [{ method: "manual", desc: "ok" }], depends_on: ["t1"] },
    ],
    gates: [
      {
        id: "g1",
        type: "human_approval",
        title: "gate",
        options: ["approve", "reject"],
        on_reject: { bounce_to: "t1", cascade: "downstream", feedback_to_context: true },
      },
    ],
  });

  assert.deepEqual(validateWorkflowSpec(valid), { passed: true, errors: [] });
});

function baseWorkflow(overrides: Partial<WorkflowSpec>): WorkflowSpec {
  return {
    version: "0.1",
    project_id: "p1",
    phase: "solution",
    goal: { raw: "goal", clarified: "goal", deliverable_type: "research", acceptance: [] },
    clarifications: [],
    required_capabilities: [],
    selected_executor: "hermes",
    agents: [],
    skills: [],
    scripts: [],
    tasks: [],
    gates: [],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
    ...overrides,
  };
}
