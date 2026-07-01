import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { approveGate, createProject, getProject, listProjects, rejectGate } from "../src/project-store.js";
import type { TaskRuntime, WorkflowRecord } from "../src/types.js";

test("createProject creates the project directory skeleton and initial disk state", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-project-store-"));

  const project = await createProject(root, "调研海外红人监控系统");

  assert.match(project.id, /^\d{4}-\d{2}-\d{2}-diao-yan-hai-wai-hong-ren-jian-kong-xi-tong$/);
  assert.equal(project.status, "created");
  assert.equal(project.goal, "调研海外红人监控系统");

  const projectYaml = parse(await readFile(join(root, "projects", project.id, "project.yaml"), "utf8"));
  assert.equal(projectYaml.id, project.id);
  assert.equal(projectYaml.status, "created");
  assert.equal(projectYaml.goal, "调研海外红人监控系统");

  const statusYaml = parse(await readFile(join(root, "projects", project.id, "status.yaml"), "utf8"));
  assert.equal(statusYaml.project_id, project.id);
  assert.equal(statusYaml.active_workflow, null);
  assert.deepEqual(statusYaml.workflows, {});

  const goalMd = await readFile(join(root, "projects", project.id, "goal.md"), "utf8");
  assert.match(goalMd, /# Goal/);
  assert.match(goalMd, /调研海外红人监控系统/);

  await readFile(join(root, "projects", project.id, "decisions.md"), "utf8");
  await readFile(join(root, "projects", project.id, "solution", ".gitkeep"), "utf8");
  await readFile(join(root, "shared", "skills", ".gitkeep"), "utf8");
});

test("listProjects and getProject read disk state", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-project-read-"));
  const created = await createProject(root, "调研海外红人监控系统");

  const projects = await listProjects(root);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.id, created.id);

  const loaded = await getProject(root, created.id);
  assert.equal(loaded.project.id, created.id);
  assert.equal(loaded.status.project_id, created.id);
});

test("approveGate records decisions and advances workflow/project status", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-gate-approve-"));
  const project = await createProject(root, "调研海外红人监控系统");
  await seedWorkflow(root, project.id, {
    phase: "solution",
    status: "final_review",
    gates: [
      {
        id: "g-final",
        type: "human_approval",
        title: "方案确认",
        options: ["approve", "reject"],
        on_approve: { writes: "decisions.md", next: "approved" },
        audit: true,
      },
    ],
  });

  await approveGate(root, project.id, "g-final", "方案通过");

  const loaded = await getProject(root, project.id);
  assert.equal(loaded.project.status, "solution_approved");
  assert.equal(requireSolution(loaded.status.workflows).status, "approved");

  const decisions = await readFile(join(root, "projects", project.id, "decisions.md"), "utf8");
  assert.match(decisions, /g-final/);
  assert.match(decisions, /方案通过/);
});

test("rejectGate bounces the selected task and downstream tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-gate-reject-"));
  const project = await createProject(root, "调研海外红人监控系统");
  await seedWorkflow(root, project.id, {
    phase: "solution",
    status: "final_review",
    tasks: {
      t1: { id: "t1", status: "delivered", depends_on: [] },
      t2: { id: "t2", status: "delivered", depends_on: ["t1"] },
      t3: { id: "t3", status: "delivered", depends_on: ["t2"] },
    },
    gates: [
      {
        id: "g-final",
        type: "human_approval",
        title: "方案确认",
        options: ["approve", "reject"],
        on_reject: { bounce_to: "t2", cascade: "downstream", feedback_to_context: true },
        audit: true,
      },
    ],
  });

  await rejectGate(root, project.id, "g-final", "补充成本分析");

  const loaded = await getProject(root, project.id);
  const tasks = requireSolution(loaded.status.workflows).tasks;
  assert.equal(tasks.t1?.status, "delivered");
  assert.equal(tasks.t2?.status, "pending");
  assert.equal(tasks.t3?.status, "pending");
  assert.equal(requireSolution(loaded.status.workflows).status, "executing");
});

async function seedWorkflow(root: string, projectId: string, partial: Partial<WorkflowRecord>): Promise<void> {
  const { saveProjectState, getProject } = await import("../src/project-store.js");
  const state = await getProject(root, projectId);
  state.project.status = "solutioning";
  state.status.active_workflow = "solution";
  state.status.workflows.solution = {
    phase: "solution",
    status: "executing",
    tasks: {} satisfies Record<string, TaskRuntime>,
    gates: [],
    ...partial,
  };
  await saveProjectState(root, state);
}

function requireSolution(workflows: { solution?: WorkflowRecord }): WorkflowRecord {
  assert.ok(workflows.solution);
  return workflows.solution;
}
