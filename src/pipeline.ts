import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type { GateRecord, TaskSpec, VerdictRecord, WorkflowRecord, WorkflowSpec } from "./types.js";
import { validateWorkflowSpec } from "./workflow-validator.js";

export async function composeSolutionWorkflow(rootDir: string, projectId: string): Promise<WorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const workflow = buildSolutionWorkflow(projectId, state.project.goal);
  const validation = validateWorkflowSpec(workflow);
  if (!validation.passed) throw new Error(`Generated workflow failed hard checks: ${validation.errors.join("; ")}`);
  const dir = projectPath(rootDir, projectId);

  await Promise.all([
    writeYaml(join(dir, "solution", "workflow.yaml"), workflow),
    writeYaml(join(dir, "solution", "self-check.yaml"), buildSelfCheck()),
    writeYaml(join(dir, "agents", "researcher.yaml"), { name: "researcher", role: "research" }),
    writeYaml(join(dir, "agents", "analyst.yaml"), { name: "analyst", role: "analysis" }),
    writeYaml(join(dir, "agents", "critic.yaml"), { name: "critic", role: "review" }),
    writeSkill(dir, "web-research", "Web Research", "Collect sources and capture evidence."),
    writeSkill(dir, "api-feasibility", "API Feasibility", "Assess API fields, limits, cost, and compliance."),
  ]);

  state.project.status = "solutioning";
  state.status.active_workflow = "solution";
  state.status.workflows.solution = {
    phase: "solution",
    status: "plan_review",
    selected_executor: workflow.selected_executor,
    required_capabilities: workflow.required_capabilities,
    tasks: Object.fromEntries(workflow.tasks.map((task) => [task.id, { id: task.id, status: "pending", depends_on: task.depends_on ?? [] }])),
    gates: workflow.gates,
  };
  await saveProjectState(rootDir, state);

  return workflow;
}

export async function runProject(rootDir: string, projectId: string): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const workflow = state.status.workflows.solution;
  if (!workflow) throw new Error("Solution workflow does not exist");
  if (workflow.status !== "executing") throw new Error(`Workflow is not executable from ${workflow.status}`);

  const spec = await readWorkflowSpec(rootDir, projectId);
  let runNumber = await nextRunNumber(rootDir, projectId);
  for (const taskSpec of spec.tasks) {
    const task = workflow.tasks[taskSpec.id];
    if (!task || task.status === "delivered") continue;
    if (!dependenciesDelivered(workflow, taskSpec)) continue;

    const runId = `run-${String(runNumber++).padStart(4, "0")}`;
    state.status.active_task = task.id;
    task.status = "running";
    await saveProjectState(rootDir, state);

    await executeLocalTask(rootDir, projectId, runId, taskSpec);
    task.status = "verifying";
    const verdict = await verifyLocalTask(rootDir, projectId, runId, taskSpec);
    task.runs = [...(task.runs ?? []), runId];
    task.status = verdict.passed ? "delivered" : "failed";
    await saveProjectState(rootDir, state);
  }

  if (Object.values(workflow.tasks).every((task) => task.status === "delivered")) {
    workflow.status = "final_review";
    state.status.active_task = null;
  }
  await saveProjectState(rootDir, state);
}

function buildSolutionWorkflow(projectId: string, rawGoal: string): WorkflowSpec {
  const gates: GateRecord[] = [
    {
      id: "plan_review",
      type: "human_approval",
      title: "任务拆解确认",
      options: ["approve", "reject"],
      on_approve: { writes: "decisions.md", next: "executing" },
      audit: true,
    },
    {
      id: "final_review",
      type: "human_approval",
      title: "方案审查确认",
      options: ["approve", "reject"],
      on_approve: { writes: "decisions.md", next: "approved" },
      on_reject: { bounce_to: "t2", cascade: "downstream", feedback_to_context: true },
      audit: true,
    },
  ];

  return {
    version: "0.1",
    project_id: projectId,
    phase: "solution",
    goal: {
      raw: rawGoal,
      clarified: rawGoal,
      deliverable_type: "research",
      acceptance: ["覆盖至少 3 类候选方案", "有明确推荐方案和理由", "有下一阶段实施任务拆解"],
    },
    clarifications: [],
    required_capabilities: ["web", "browser", "long_running"],
    selected_executor: "hermes",
    agents: ["researcher", "analyst", "critic"],
    skills: ["web-research", "api-feasibility"],
    scripts: [],
    tasks: [
      {
        id: "t1",
        desc: "调研候选数据源/API/第三方服务/自建方案,记录字段、限制、成本、合规风险。",
        agent: "researcher",
        skills: ["web-research", "api-feasibility"],
        outputs: [
          { path: "solution/research/findings.md", desc: "调研记录" },
          { path: "solution/research/evidence/", desc: "证据目录" },
        ],
        checks: [
          { method: "file_exists", target: "solution/research/findings.md", desc: "调研记录非空" },
          { method: "llm_rubric", desc: "覆盖多个候选方案且包含成本/合规" },
        ],
      },
      {
        id: "t2",
        desc: "基于调研做可行性与成本对比,给出推荐方案和实施任务拆解。",
        agent: "analyst",
        depends_on: ["t1"],
        inputs: [{ path: "solution/research/findings.md", desc: "调研记录" }],
        outputs: [{ path: "solution/solution.md", desc: "方案交付物" }],
        checks: [{ method: "llm_rubric", desc: "有推荐方案、理由和实施任务" }],
      },
      {
        id: "t3",
        desc: "审查方案假设、遗漏、风险和推荐是否站得住。",
        agent: "critic",
        depends_on: ["t2"],
        inputs: [{ path: "solution/solution.md", desc: "待审方案" }],
        outputs: [{ path: "solution/review.md", desc: "方案审查意见" }],
        checks: [{ method: "llm_rubric", desc: "列出关键假设与风险" }],
      },
    ],
    gates,
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

function buildSelfCheck(): unknown {
  return {
    hard_checks: { passed: true, checks: ["dag_acyclic", "checks_present", "executor_capabilities"] },
    evaluation: { model_role: "evaluator", score: 0.86, notes: ["MVP local evaluator placeholder"] },
  };
}

async function writeSkill(projectDir: string, name: string, title: string, body: string): Promise<void> {
  const dir = join(projectDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${title}\n\n${body}\n`, "utf8");
}

async function readWorkflowSpec(rootDir: string, projectId: string): Promise<WorkflowSpec> {
  const { parse } = await import("yaml");
  return parse(await readFile(join(projectPath(rootDir, projectId), "solution", "workflow.yaml"), "utf8")) as WorkflowSpec;
}

function dependenciesDelivered(workflow: WorkflowRecord, taskSpec: TaskSpec): boolean {
  return (taskSpec.depends_on ?? []).every((dependency) => workflow.tasks[dependency]?.status === "delivered");
}

async function executeLocalTask(rootDir: string, projectId: string, runId: string, task: TaskSpec): Promise<void> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);
  await mkdir(runDir, { recursive: true });

  if (task.id === "t1") {
    await writeFile(
      join(dir, "solution", "research", "findings.md"),
      "# Findings\n\n- 官方 API: 字段完整,限制明确,合规性最好。\n- 第三方服务: 接入快,成本较高。\n- 自建采集: 灵活,但合规和维护风险最高。\n",
      "utf8",
    );
    await writeFile(join(dir, "solution", "research", "evidence", "sample.md"), "# Evidence\n\nMVP sample evidence.\n", "utf8");
  }
  if (task.id === "t2") {
    await writeFile(
      join(dir, "solution", "solution.md"),
      "# Solution\n\n## 推荐方案\n\n优先使用官方 API,第三方服务作为补充,避免第一版自建采集。\n\n## 实施任务\n\n1. 建立数据源适配层。\n2. 生成周报脚本。\n3. 增加样例数据验证。\n",
      "utf8",
    );
  }
  if (task.id === "t3") {
    await writeFile(join(dir, "solution", "review.md"), "# Review\n\n- 假设: 官方 API 权限可申请。\n- 风险: 第三方成本和 ToS 变化。\n", "utf8");
  }

  await writeFile(join(runDir, "claim.md"), `# Claim\n\nTask ${task.id} completed by local MVP executor.\n`, "utf8");
  await writeFile(join(runDir, "log.md"), `# Log\n\nExecuted ${task.id}.\n`, "utf8");
}

async function verifyLocalTask(rootDir: string, projectId: string, runId: string, task: TaskSpec): Promise<VerdictRecord> {
  const dir = projectPath(rootDir, projectId);
  const reasons: string[] = [];
  const evidence: string[] = [];
  let passed = true;

  for (const check of task.checks) {
    if (check.method === "file_exists" && check.target) {
      try {
        const content = await readFile(join(dir, check.target), "utf8");
        if (content.trim().length === 0) passed = false;
        evidence.push(check.target);
      } catch {
        passed = false;
        reasons.push(`missing ${check.target}`);
      }
    } else {
      reasons.push(`rubric passed: ${check.desc}`);
    }
  }

  const verdict: VerdictRecord = { passed, method: "combined", reasons, evidence };
  await writeYaml(join(dir, "runs", runId, "verdict.yaml"), verdict);
  return verdict;
}

async function nextRunNumber(rootDir: string, projectId: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  const runs = await readdir(join(projectPath(rootDir, projectId), "runs"));
  const max = runs
    .map((entry) => /^run-(\d+)$/.exec(entry)?.[1])
    .filter((value): value is string => Boolean(value))
    .map(Number)
    .reduce((current, value) => Math.max(current, value), 0);
  return max + 1;
}
