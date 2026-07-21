import { test } from "node:test";
import assert from "node:assert";
import { rm, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { createProject, getProject } from "../src/project-store.js";
import { composeGraphWorkflow } from "../src/pipeline.js";
import type { GraphWorkflowSpec } from "../src/types.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";

const TMP = join(process.cwd(), "tmp-test-pipe");

const fakeClient = buildSmartFakeClient();

function makeSpec(pid: string): GraphWorkflowSpec {
  return {
    version: "0.2", project_id: pid, phase: "solution", flow_type: "graph",
    goal: { raw: "写小说", clarified: "写20章悬疑小说", deliverable_type: "creative", iterative: true, acceptance: ["每章3000字"] },
    clarifications: [], required_capabilities: ["web"], selected_executor: "hermes",
    agents: ["writer"], skills: [], scripts: [],
    capabilities: [
      { id: "write_chapter", kind: "agent", desc: "写一章", outputs: [{ path: "solution/chapters/", desc: "章节正文" }], checks: [{ method: "llm_rubric", desc: ">=3000字" }], updates: ["summary"] },
      { id: "update_memory", kind: "light", desc: "更新摘要", checks: [{ method: "llm_rubric", desc: "摘要有界" }], updates: ["summary"] },
    ],
    guardrails: { hard: { max_iterations: 30 }, soft: [], human_checkpoint_every: 3 },
    blackboard_schema: { fields: [{ key: "summary", desc: "滚动摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到20章"],
    hard_constraints: [],
    soft_guidance: [],
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

test("composeGraphWorkflow writes workflow.yaml + sets plan_review", async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const p = await createProject(TMP, "写小说", "小说");
  const spec = makeSpec(p.id);
  await composeGraphWorkflow(TMP, p.id, fakeClient, spec);
  const state = await getProject(TMP, p.id);
  assert.equal(state.status.workflows.solution?.workflow_status, "plan_review");
  assert.equal(state.status.flow_type, "graph");
  // workflow.yaml 存在
  const raw = await readFile(join(projectPath(TMP, p.id), "solution", "workflow.yaml"), "utf8");
  const parsed = parse(raw) as GraphWorkflowSpec;
  assert.equal(parsed.capabilities.length, 2);
});

test("planGraphWorkflow (Composer 自动规划,不传 spec)", async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const p = await createProject(TMP, "写小说", "小说");
  const { planGraphWorkflow } = await import("../src/pipeline.js");
  const spec = await planGraphWorkflow(TMP, p.id, fakeClient);
  assert.equal(spec.flow_type, "graph");
  assert.ok(spec.capabilities.length > 0);
  assert.ok(spec.guardrails.hard.max_iterations > 0);
  assert.ok(spec.entry_node);
  const state = await getProject(TMP, p.id);
  assert.equal(state.status.workflows.solution?.workflow_status, "plan_review");
});

function projectPath(root: string, id: string) { return join(root, "projects", id); }
