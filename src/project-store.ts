import { readdir, readFile, mkdir, appendFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import type { ProjectRecord, ProjectState, StatusRecord, WorkflowPhase, GraphRuntime } from "./types.js";

export async function createProject(rootDir: string, rawGoal: string, title?: string): Promise<ProjectRecord> {
  const id = buildProjectId(rawGoal, title);
  const projectDir = projectPath(rootDir, id);
  const createdAt = new Date().toISOString();

  await createProjectSkeleton(rootDir, projectDir);

  const project: ProjectRecord = {
    id,
    name: title,
    goal: rawGoal,
    status: "created",
    created_at: createdAt,
  };

  const status: StatusRecord = {
    project_id: id,
    active_workflow: null,
    active_task: null,
    blocked_reason: null,
    awaiting_input: null,
    workflows: {},
  };

  await Promise.all([
    writeYaml(join(projectDir, "project.yaml"), project),
    writeYaml(join(projectDir, "status.yaml"), status),
    writeFile(join(projectDir, "goal.md"), `# Goal\n\n${rawGoal}\n\n## Clarifications\n\n`, "utf8"),
    writeFile(join(projectDir, "decisions.md"), "# Decisions\n\n", "utf8"),
  ]);

  return project;
}

export async function listProjects(rootDir: string): Promise<ProjectRecord[]> {
  const dir = join(rootDir, "projects");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await parseYaml<ProjectRecord>(join(dir, entry, "project.yaml"));
      } catch {
        return null; // skip broken/incomplete project directories
      }
    }),
  );
  return results.filter((p): p is ProjectRecord => p !== null).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function deleteProject(rootDir: string, projectId: string): Promise<void> {
  const dir = projectPath(rootDir, projectId);
  await rm(dir, { recursive: true, force: true });
}

export async function getProject(rootDir: string, projectId: string): Promise<ProjectState> {
  const dir = projectPath(rootDir, projectId);
  return {
    project: await parseYaml<ProjectRecord>(join(dir, "project.yaml")),
    status: await parseYaml<StatusRecord>(join(dir, "status.yaml")),
  };
}

export async function saveProjectState(rootDir: string, state: ProjectState): Promise<void> {
  const dir = projectPath(rootDir, state.project.id);
  await Promise.all([
    writeYaml(join(dir, "project.yaml"), state.project),
    writeYaml(join(dir, "status.yaml"), state.status),
  ]);
}

/** 审批门:plan_review / final_review 的 approve/reject。图模型下是状态切换 */
export async function approveGate(rootDir: string, projectId: string, gateId: string, note = ""): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const phase = requireActiveWorkflow(state.status);
  const wf = requireWorkflow(state.status, phase);

  if (gateId === "plan_review") {
    wf.workflow_status = "executing";
  } else if (gateId === "final_review") {
    wf.workflow_status = "approved";
    if (phase === "solution") {
      state.project.status = "solution_approved";
    }
  } else {
    // 人审放行(awaiting_human → executing)
    wf.workflow_status = "executing";
    wf.awaiting = "none";
    wf.awaiting_reason = undefined;
    wf.awaiting_scene = undefined;
    // 重置 node_retries:人审放行意味着用户决定继续,给节点重新开始的机会
    if (wf.node_retries) {
      for (const nodeId of Object.keys(wf.node_retries)) {
        wf.node_retries[nodeId] = 0;
      }
    }
  }

  await appendDecision(rootDir, projectId, `approved ${gateId}`, note);
  await saveProjectState(rootDir, state);
}

export async function rejectGate(rootDir: string, projectId: string, gateId: string, feedback: string): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const phase = requireActiveWorkflow(state.status);
  const wf = requireWorkflow(state.status, phase);

  if (gateId === "plan_review") {
    // 打回 plan:回 composing(重新规划)
    wf.workflow_status = "composing";
  } else if (gateId === "final_review") {
    // 打回 final:回 executing 继续跑(调度大脑会基于反馈继续)
    wf.workflow_status = "executing";
    wf.awaiting = "none";
    wf.awaiting_reason = undefined;
    wf.awaiting_scene = undefined;
    wf.blackboard["human_direction"] = feedback;
  } else {
    // 人审拒绝(放弃/叫停)
    wf.workflow_status = "failed";
    wf.awaiting = "none";
  }

  await appendDecision(rootDir, projectId, `rejected ${gateId}`, feedback);
  await saveProjectState(rootDir, state);
}

export function projectPath(rootDir: string, projectId: string): string {
  return join(rootDir, "projects", projectId);
}

export async function writeYaml(path: string, data: unknown): Promise<void> {
  await writeFile(path, stringify(data), "utf8");
}

export async function parseYaml<T>(path: string): Promise<T> {
  return parse(await readFile(path, "utf8")) as T;
}

async function createProjectSkeleton(rootDir: string, projectDir: string): Promise<void> {
  const dirs = [
    join(projectDir, "solution", "research", "evidence"),
    join(projectDir, "solution", "snapshots"),
    join(projectDir, "implementation"),
    join(projectDir, "agents"),
    join(projectDir, "skills"),
    join(projectDir, "scripts"),
    join(projectDir, "runs"),
    join(rootDir, "shared", "agents"),
    join(rootDir, "shared", "skills"),
    join(rootDir, "shared", "scripts"),
  ];

  await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
  await Promise.all([
    touch(join(projectDir, "solution", ".gitkeep")),
    touch(join(projectDir, "implementation", ".gitkeep")),
    touch(join(projectDir, "agents", ".gitkeep")),
    touch(join(projectDir, "skills", ".gitkeep")),
    touch(join(projectDir, "scripts", ".gitkeep")),
    touch(join(projectDir, "runs", ".gitkeep")),
    touch(join(rootDir, "shared", "agents", ".gitkeep")),
    touch(join(rootDir, "shared", "skills", ".gitkeep")),
    touch(join(rootDir, "shared", "scripts", ".gitkeep")),
  ]);
}

async function touch(path: string): Promise<void> {
  await writeFile(path, "", "utf8");
}

async function appendDecision(rootDir: string, projectId: string, title: string, note: string): Promise<void> {
  const line = `## ${new Date().toISOString()} — ${title}\n\n${note || "(no note)"}\n\n`;
  await appendFile(join(projectPath(rootDir, projectId), "decisions.md"), line, "utf8");
}

function requireActiveWorkflow(status: StatusRecord): WorkflowPhase {
  if (!status.active_workflow) throw new Error("Project has no active workflow");
  return status.active_workflow;
}

function requireWorkflow(status: StatusRecord, phase: WorkflowPhase): GraphRuntime {
  const workflow = status.workflows[phase];
  if (!workflow) throw new Error(`Workflow ${phase} does not exist`);
  return workflow;
}

function buildProjectId(rawGoal: string, title?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  if (title) {
    const clean = title.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 10);
    return `${date}-${clean || slugify(rawGoal)}`;
  }
  return `${date}-${slugify(rawGoal)}`;
}

function slugify(input: string): string {
  const clean = input.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 8);
  return clean || "project";
}
