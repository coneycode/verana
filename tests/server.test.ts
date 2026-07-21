import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";
import { setExecutorForTest } from "../src/graph-engine.js";
import { FakeExecutorAdapter } from "../src/fake-llm.js";
import type { ExecutorAdapter, AgentRun } from "../src/executors.js";
import type { GraphWorkflowSpec } from "../src/types.js";

class BadResearchExecutorAdapter implements ExecutorAdapter {
  readonly name = "bad-research-executor";
  readonly capabilities = { name: "bad-research-executor", capabilities: ["web", "browser", "long_running", "skills", "terminal", "file"] };
  async probe() { return { available: true, command: "bad-fake" }; }
  async execute(_prompt: string, workdir: string): Promise<AgentRun> {
    await mkdir(join(workdir, "solution"), { recursive: true });
    await writeFile(join(workdir, "solution", "report.md"), "# 调研报告\n\n## 产品概览\n\n让我先说明我查了哪些资料。\n", "utf8");
    return { claim: "已完成调研报告", raw: "bad fake output", exitCode: 0 };
  }
}

function makeSpec(pid: string): GraphWorkflowSpec {
  return {
    version: "0.2", project_id: pid, phase: "solution", flow_type: "graph",
    goal: { raw: "写小说", clarified: "写20章小说", deliverable_type: "creative", iterative: true, acceptance: ["每章3000字"] },
    clarifications: [], required_capabilities: ["web"], selected_executor: "hermes",
    agents: ["writer"], skills: [], scripts: [],
    capabilities: [
      { id: "write_chapter", kind: "agent", desc: "写一章", outputs: [{ path: "solution/chapters/", desc: "章节正文" }], checks: [{ method: "llm_rubric", desc: ">=3000字" }], updates: ["summary"] },
    ],
    guardrails: { hard: { max_iterations: 5 }, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [{ key: "summary", desc: "摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到2章"],
    hard_constraints: [],
    soft_guidance: [],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

function makeResearchSpec(pid: string): GraphWorkflowSpec {
  return {
    version: "0.2", project_id: pid, phase: "solution", flow_type: "graph",
    goal: { raw: "调研产品", clarified: "调研产品", deliverable_type: "research", iterative: false, acceptance: ["结构化调研报告"] },
    clarifications: [], required_capabilities: ["web"], selected_executor: "hermes",
    agents: ["researcher"], skills: [], scripts: [],
    capabilities: [
      { id: "write_chapter", kind: "agent", desc: "写结构化调研报告", outputs: [{ path: "solution/report.md", desc: "调研报告", min_bytes: 40, min_lines: 3 }], checks: [{ method: "llm_rubric", desc: "结构完整" }] },
    ],
    guardrails: { hard: { max_iterations: 1, max_retries_per_node: 1 }, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [{ key: "summary", desc: "摘要", bounded: false }] },
    entry_node: "write_chapter",
    completion_criteria: ["报告通过验证"],
    hard_constraints: [],
    soft_guidance: [],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

test("graph workflow: create → plan → approve → run → final_review", async () => {
  setExecutorForTest(new FakeExecutorAdapter());  // 不调真实 hermes
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
    // fire-and-forget: 返回 composing 状态,不等 plan 完成
    assert.equal(planResponse.json().status, "composing");
    // 等 plan 完成(composeGraphWorkflow 是 fire-and-forget)
    await new Promise((r) => setTimeout(r, 500));

    // 验证 workflow 已落盘
    const wfResponse = await app.inject({ method: "GET", url: `/projects/${pid}/workflow` });
    assert.equal(wfResponse.statusCode, 200);
    assert.equal(wfResponse.json().flow_type, "graph");

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

    const verdictRaw = await readFile(join(root, "projects", pid, "runs", "run-0001", "verdict.yaml"), "utf8");
    assert.match(verdictRaw, /artifact_report: runs\/run-0001\/artifact-report\.yaml/);
    assert.match(verdictRaw, /artifact_paths:/);
    assert.match(verdictRaw, /runs\/run-0001\/artifacts\/solution\/chapters/);
  } finally {
    setExecutorForTest(null);
    await app.close();
  }
});

test("graph workflow records artifact contract failure when runtime deliverable structure is invalid", async () => {
  setExecutorForTest(new BadResearchExecutorAdapter());
  const root = await mkdtemp(join(tmpdir(), "verana-srv-artifact-"));
  const client = buildSmartFakeClient();
  const app = await buildServer({ rootDir: root, client });

  try {
    const createResponse = await app.inject({ method: "POST", url: "/projects", payload: { goal: "调研产品" } });
    assert.equal(createResponse.statusCode, 200);
    const pid = createResponse.json().project.id;

    const planResponse = await app.inject({ method: "POST", url: `/projects/${pid}/plan`, payload: { spec: makeResearchSpec(pid) } });
    assert.equal(planResponse.statusCode, 200);
    await new Promise((r) => setTimeout(r, 500));

    const approvePlan = await app.inject({ method: "POST", url: `/projects/${pid}/approve`, payload: { gate: "plan_review", note: "ok" } });
    assert.equal(approvePlan.statusCode, 200);

    const runResponse = await app.inject({ method: "POST", url: `/projects/${pid}/run` });
    assert.equal(runResponse.statusCode, 200);
    await new Promise((r) => setTimeout(r, 500));

    const stateResponse = await app.inject({ method: "GET", url: `/projects/${pid}` });
    const wf = stateResponse.json().status.workflows.solution;
    assert.equal(wf.workflow_status, "awaiting_human");
    assert.match(wf.awaiting_reason, /F_artifact_contract_failure|缺少|missing|结构|禁止|forbidden/);

    const reportRaw = await readFile(join(root, "projects", pid, "runs", "run-0001", "artifact-report.yaml"), "utf8");
    assert.match(reportRaw, /deliverable_structure_missing_section/);
    assert.match(reportRaw, /deliverable_structure_forbidden_pattern/);

    const verdictRaw = await readFile(join(root, "projects", pid, "runs", "run-0001", "verdict.yaml"), "utf8");
    assert.match(verdictRaw, /F_artifact_contract_failure/);
  } finally {
    setExecutorForTest(null);
    await app.close();
  }
});
