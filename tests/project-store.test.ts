import { test } from "node:test";
import assert from "node:assert";
import { createProject, getProject, saveProjectState, approveGate, projectPath } from "../src/project-store.js";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectState, GraphRuntime } from "../src/types.js";

const TMP = join(process.cwd(), "tmp-test-store");

async function setup() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
}

test("create + get project", async () => {
  await setup();
  const p = await createProject(TMP, "test goal", "测试");
  assert.ok(p.id.startsWith("20"));
  const state = await getProject(TMP, p.id);
  assert.equal(state.project.goal, "test goal");
  assert.equal(state.project.status, "created");
});

test("approve plan_review → executing", async () => {
  await setup();
  const p = await createProject(TMP, "g", "t");
  const state = await getProject(TMP, p.id);
  state.status.active_workflow = "solution";
  const rt: GraphRuntime = {
    workflow_status: "plan_review", current_node: null, iteration: 0,
    awaiting: "none", blackboard: {}, runs: {}, node_retries: {}, capabilities_added: [],
  };
  state.status.workflows.solution = rt;
  state.status.flow_type = "graph";
  await saveProjectState(TMP, state);
  await approveGate(TMP, p.id, "plan_review", "ok");
  const after = await getProject(TMP, p.id);
  assert.equal(after.status.workflows.solution?.workflow_status, "executing");
});

test("approve final_review → approved + project solution_approved", async () => {
  await setup();
  const p = await createProject(TMP, "g", "t");
  const state = await getProject(TMP, p.id);
  state.status.active_workflow = "solution";
  const rt: GraphRuntime = {
    workflow_status: "final_review", current_node: null, iteration: 5,
    awaiting: "none", blackboard: {}, runs: {}, node_retries: {}, capabilities_added: [],
  };
  state.status.workflows.solution = rt;
  await saveProjectState(TMP, state);
  await approveGate(TMP, p.id, "final_review", "done");
  const after = await getProject(TMP, p.id);
  assert.equal(after.status.workflows.solution?.workflow_status, "approved");
  assert.equal(after.project.status, "solution_approved");
});
