import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { approveGate, createProject, getProject } from "../src/project-store.js";
import { composeSolutionWorkflow, runProject } from "../src/pipeline.js";
import type { WorkflowRecord } from "../src/types.js";

test("composeSolutionWorkflow writes a solution workflow, project agents, skills, and self-check report", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-compose-"));
  const project = await createProject(root, "调研海外红人监控系统");

  const workflow = await composeSolutionWorkflow(root, project.id);

  assert.equal(workflow.phase, "solution");
  assert.equal(workflow.selected_executor, "hermes");
  assert.deepEqual(workflow.required_capabilities, ["web", "browser", "long_running"]);
  assert.equal(workflow.tasks.length, 3);
  assert.equal(workflow.gates.some((gate) => gate.id === "plan_review"), true);
  assert.equal(workflow.gates.some((gate) => gate.id === "final_review"), true);

  const loaded = await getProject(root, project.id);
  assert.equal(loaded.project.status, "solutioning");
  assert.equal(loaded.status.active_workflow, "solution");
  assert.equal(requireSolution(loaded.status.workflows).status, "plan_review");

  await readFile(join(root, "projects", project.id, "solution", "workflow.yaml"), "utf8");
  await readFile(join(root, "projects", project.id, "agents", "researcher.yaml"), "utf8");
  await readFile(join(root, "projects", project.id, "skills", "web-research", "SKILL.md"), "utf8");

  const selfCheck = parse(await readFile(join(root, "projects", project.id, "solution", "self-check.yaml"), "utf8"));
  assert.equal(selfCheck.hard_checks.passed, true);
  assert.equal(selfCheck.evaluation.model_role, "evaluator");
});

test("runProject executes approved solution DAG, writes claim/verdict logs, and enters final_review", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-run-"));
  const project = await createProject(root, "调研海外红人监控系统");
  await composeSolutionWorkflow(root, project.id);
  await approveGate(root, project.id, "plan_review", "任务拆解通过");

  await runProject(root, project.id);

  const loaded = await getProject(root, project.id);
  const workflow = requireSolution(loaded.status.workflows);
  assert.equal(workflow.status, "final_review");
  assert.equal(workflow.tasks.t1?.status, "delivered");
  assert.equal(workflow.tasks.t2?.status, "delivered");
  assert.equal(workflow.tasks.t3?.status, "delivered");

  const solution = await readFile(join(root, "projects", project.id, "solution", "solution.md"), "utf8");
  assert.match(solution, /推荐方案/);

  const runsDir = join(root, "projects", project.id, "runs");
  await readFile(join(runsDir, "run-0001", "claim.md"), "utf8");
  const verdict = parse(await readFile(join(runsDir, "run-0001", "verdict.yaml"), "utf8"));
  assert.equal(verdict.passed, true);
});

test("approving final_review closes solution and records the decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-close-solution-"));
  const project = await createProject(root, "调研海外红人监控系统");
  await composeSolutionWorkflow(root, project.id);
  await approveGate(root, project.id, "plan_review", "任务拆解通过");
  await runProject(root, project.id);

  await approveGate(root, project.id, "final_review", "方案闭环");

  const loaded = await getProject(root, project.id);
  assert.equal(loaded.project.status, "solution_approved");
  assert.equal(requireSolution(loaded.status.workflows).status, "approved");
  const decisions = await readFile(join(root, "projects", project.id, "decisions.md"), "utf8");
  assert.match(decisions, /final_review/);
});

function requireSolution(workflows: { solution?: WorkflowRecord }): WorkflowRecord {
  assert.ok(workflows.solution);
  return workflows.solution;
}
