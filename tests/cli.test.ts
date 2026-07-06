import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";
import type { GraphWorkflowSpec } from "../src/types.js";

function makeSpec(pid: string): GraphWorkflowSpec {
  return {
    version: "0.2", project_id: pid, phase: "solution", flow_type: "graph",
    goal: { raw: "写小说", clarified: "写20章悬疑小说", deliverable_type: "creative", iterative: true, acceptance: ["每章3000字"] },
    clarifications: [], required_capabilities: ["web"], selected_executor: "hermes",
    agents: ["writer"], skills: [], scripts: [],
    capabilities: [
      { id: "write_chapter", kind: "agent", desc: "写一章", checks: [{ method: "llm_rubric", desc: ">=3000字" }], updates: ["summary"] },
    ],
    guardrails: { hard: { max_iterations: 5 }, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [{ key: "summary", desc: "滚动摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到2章"],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

test("CLI: new → approve plan → run → status", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-cli-graph-"));
  const client = buildSmartFakeClient();
  const lines: string[] = [];

  await runCli(["new", "写小说", "--root", root], (line: string) => lines.push(line), client);
  const projectId = lines.find((l) => l.startsWith("created "))?.split(" ")[1];
  assert.ok(projectId);

  // 手动写 workflow.yaml + 设 plan_review(plan 端点要 spec,CLI 暂不直接支持;用 approve 测状态切换)
  const { createProject, getProject, saveProjectState } = await import("../src/project-store.js");
  const { composeGraphWorkflow } = await import("../src/pipeline.js");
  await composeGraphWorkflow(root, projectId, client, makeSpec(projectId));

  lines.length = 0;
  await runCli(["approve", projectId, "plan_review", "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((l) => l.includes("approved plan_review")), true);

  lines.length = 0;
  await runCli(["run", projectId, "--root", root], (line: string) => lines.push(line), client);
  // 图引擎跑完(scheduler 2轮后 is_complete) → final_review
  assert.equal(lines.some((l) => l.includes("final_review")), true, `got: ${lines.join(",")}`);

  lines.length = 0;
  await runCli(["status", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((l) => l.includes("solution")), true);
});
