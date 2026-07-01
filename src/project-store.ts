import { readdir, readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import type { GateRecord, ProjectRecord, ProjectState, StatusRecord, WorkflowPhase, WorkflowRecord } from "./types.js";

export async function createProject(rootDir: string, rawGoal: string): Promise<ProjectRecord> {
  const id = buildProjectId(rawGoal);
  const projectDir = projectPath(rootDir, id);
  const createdAt = new Date().toISOString();

  await createProjectSkeleton(rootDir, projectDir);

  const project: ProjectRecord = {
    id,
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

  const projects = await Promise.all(
    entries.map(async (entry) => parseYaml<ProjectRecord>(join(dir, entry, "project.yaml"))),
  );
  return projects.sort((a, b) => a.created_at.localeCompare(b.created_at));
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

export async function approveGate(rootDir: string, projectId: string, gateId: string, note = ""): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const phase = requireActiveWorkflow(state.status);
  const workflow = requireWorkflow(state.status, phase);
  const gate = findGate(workflow, gateId);

  workflow.status = gate.on_approve?.next ?? "approved";
  if (workflow.status === "approved" && phase === "solution") {
    state.project.status = "solution_approved";
  }

  await appendDecision(rootDir, projectId, `approved ${gateId}`, note);
  await saveProjectState(rootDir, state);
}

export async function rejectGate(rootDir: string, projectId: string, gateId: string, feedback: string): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const phase = requireActiveWorkflow(state.status);
  const workflow = requireWorkflow(state.status, phase);
  const gate = findGate(workflow, gateId);
  const bounce = gate.on_reject;
  if (!bounce) throw new Error(`Gate ${gateId} does not define a reject path`);

  const affected = downstreamTasks(workflow, bounce.bounce_to);
  for (const taskId of affected) {
    const task = workflow.tasks[taskId];
    if (!task) continue;
    task.status = "pending";
    task.feedback = [...(task.feedback ?? []), feedback];
  }
  workflow.status = "executing";
  state.status.active_task = bounce.bounce_to;

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

function requireWorkflow(status: StatusRecord, phase: WorkflowPhase): WorkflowRecord {
  const workflow = status.workflows[phase];
  if (!workflow) throw new Error(`Workflow ${phase} does not exist`);
  return workflow;
}

function findGate(workflow: WorkflowRecord, gateId: string): GateRecord {
  const gate = workflow.gates.find((candidate) => candidate.id === gateId);
  if (!gate) throw new Error(`Gate ${gateId} does not exist`);
  return gate;
}

function downstreamTasks(workflow: WorkflowRecord, startTaskId: string): string[] {
  const result = new Set<string>([startTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of Object.values(workflow.tasks)) {
      if (!result.has(task.id) && (task.depends_on ?? []).some((dependency) => result.has(dependency))) {
        result.add(task.id);
        changed = true;
      }
    }
  }
  return [...result];
}

function buildProjectId(rawGoal: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${date}-${slugify(rawGoal)}`;
}

function slugify(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const pinyin = transliterateKnownChinese(normalized);
  const slug = pinyin
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "project";
}

function transliterateKnownChinese(input: string): string {
  const map: Record<string, string> = {
    调: "diao",
    研: "yan",
    海: "hai",
    外: "wai",
    红: "hong",
    人: "ren",
    监: "jian",
    控: "kong",
    系: "xi",
    统: "tong",
  };

  return Array.from(input)
    .map((char) => map[char] ?? char)
    .join("-");
}
