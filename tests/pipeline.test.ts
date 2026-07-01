import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { FakeLlmClient, fakeComposerWorkflow, fakeExecutorContent, fakeVerifierPassed } from "../src/fake-llm.js";
import { approveGate, createProject, getProject } from "../src/project-store.js";
import { composeSolutionWorkflow, runProject } from "../src/pipeline.js";
import type { ModelRole } from "../src/llm.js";

function buildFakeClient() {
  return new FakeLlmClient((role: ModelRole) => {
    if (role === "composer") {
      const user = "";
      void user;
      return { json: fakeComposerWorkflow(), complete: fakeExecutorContent() };
    }
    return { json: fakeVerifierPassed() };
  });
}

test("composeSolutionWorkflow uses LLM to generate a workflow", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-compose-llm-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const client = buildFakeClient();

  const workflow = await composeSolutionWorkflow(root, project.id, client);

  assert.equal(workflow.phase, "solution");
  assert.equal(workflow.selected_executor, "hermes");
  assert.equal(workflow.tasks.length, 2);
  assert.equal(workflow.tasks[0]?.id, "t1");
  assert.equal(workflow.tasks[1]?.depends_on?.[0], "t1");

  const loaded = await getProject(root, project.id);
  assert.equal(loaded.project.status, "solutioning");
  assert.equal(loaded.status.workflows.solution?.status, "plan_review");

  const workflowYaml = parse(await readFile(join(root, "projects", project.id, "solution", "workflow.yaml"), "utf8"));
  assert.equal(workflowYaml.tasks.length, 2);
});

test("runProject executes LLM-composed DAG and verifies with LLM evaluator", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-run-llm-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const client = buildFakeClient();
  await composeSolutionWorkflow(root, project.id, client);
  await approveGate(root, project.id, "plan_review", "通过");

  await runProject(root, project.id, client);

  const loaded = await getProject(root, project.id);
  const workflow = loaded.status.workflows.solution;
  assert.equal(workflow?.status, "final_review");
  assert.equal(workflow?.tasks.t1?.status, "delivered");
  assert.equal(workflow?.tasks.t2?.status, "delivered");

  const findings = await readFile(join(root, "projects", project.id, "solution", "research", "findings.md"), "utf8");
  assert.match(findings, /交付内容/);

  const verdict = parse(await readFile(join(root, "projects", project.id, "runs", "run-0001", "verdict.yaml"), "utf8"));
  assert.equal(verdict.passed, true);
});
