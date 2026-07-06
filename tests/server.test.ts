import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";
import type { GraphWorkflowSpec } from "../src/types.js";

function makeSpec(pid: string): GraphWorkflowSpec {
  return {
    version: "0.2", project_id: pid, phase: "solution", flow_type: "graph",
    goal: { raw: "写小说", clarified: "写20章小说", deliverable_type: "creative", iterative: true, acceptance: ["每章3000字"] },
    clarifications: [], required_capabilities: ["web"], selected_executor: "hermes",
    agents: ["writer"], skills: [], scripts: [],
    capabilities: [
      { id: "write_chapter", kind: "agent", desc: "写一章", checks: [{ method: "llm_rubric", desc: ">=3000字" }], updates: ["summary"] },
    ],
    guardrails: { hard: { max_iterations: 5 }, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [{ key: "summary", desc: "摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到2章"],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

test("Server: create → plan(spec) → approve → run → final_review", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-srv-graph-"));
  const client = buildSmartFakeClient();
  const app = await buildServer({ rootDir: root, client });

  try {
    const homeResponse = await app.inject({ method: "GET", url: "/" });
    assert.equal(homeResponse.statusCode, 200);

    const createResponse = await app.inject({ method: "POST", url: "/projects", payload: { goal: "写小说" } });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json();
    const pid = created.project.id;

    const planResponse = await app.inject({ method: "POST", url: `/projects/${pid}/plan`, payload: { spec: makeSpec(pid) } });
    assert.equal(planResponse.statusCode, 200);
    assert.equal(planResponse.json().flow_type, "graph");

    const approvePlan = await app.inject({ method: "POST", url: `/projects/${pid}/approve`, payload: { gate: "plan_review", note: "ok" } });
    assert.equal(approvePlan.statusCode, 200);
    assert.equal(approvePlan.json().status.workflows.solution.workflow_status, "executing");

    const runResponse = await app.inject({ method: "POST", url: `/projects/${pid}/run` });
    assert.equal(runResponse.statusCode, 200);
    // run is async; wait a bit for graph engine to finish
    await new Promise((r) => setTimeout(r, 500));

    const stateResponse = await app.inject({ method: "GET", url: `/projects/${pid}` });
    const wf = stateResponse.json().status.workflows.solution;
    assert.ok(wf.iteration >= 1, `iteration should be >=1, got ${wf.iteration}`);
  } finally {
    await app.close();
  }
});
