import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import type { LlmClient } from "./llm.js";
import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type { GateRecord, TaskSpec, VerdictRecord, WorkflowRecord, WorkflowSpec } from "./types.js";
import { validateWorkflowSpec } from "./workflow-validator.js";

const COMPOSER_SYSTEM = `你是一个 workflow 架构师。根据用户目标,合成一个方案调研阶段的执行 workflow。

你必须返回 JSON,结构如下:
{
  "clarified": "澄清后的目标描述",
  "acceptance": ["验收标准1", "验收标准2", ...],
  "tasks": [
    {
      "id": "t1",
      "desc": "这个 task 做什么事的详细自然语言描述",
      "agent": "researcher|analyst|critic",
      "skills": ["skill-name"],
      "depends_on": [],
      "inputs": [{"path": "solution/research/xxx.md", "desc": "说明"}],
      "outputs": [{"path": "solution/xxx.md", "desc": "说明"}],
      "checks": [{"method": "file_exists|llm_rubric", "target": "路径(file_exists时)", "desc": "验收描述"}]
    }
  ]
}

规则:
- 3-5 个 task,形成 DAG(后续 task 的 depends_on 指向前面的)
- 第一个 task 用 researcher 做调研,产出 findings.md
- 倒数第二个用 analyst 做分析推荐,产出 solution.md
- 最后一个用 critic 做审查,产出 review.md
- 每个 task 必须有 checks(至少一条)
- 中间 task 的 inputs 要引用上游 task 的 outputs path
- 用中文写 desc
- agent 只能是 researcher / analyst / critic 之一
- method 只能是 file_exists / llm_rubric 之一`;

export async function composeSolutionWorkflow(rootDir: string, projectId: string, client: LlmClient): Promise<WorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const clarifications = state.status.clarifier?.clarifications ?? [];
  const userPrompt = buildComposerPrompt(state.project.goal, clarifications);

  const llmResult = await client.completeJson<{
    clarified: string;
    acceptance: string[];
    tasks: Array<{
      id: string;
      desc: string;
      agent: string;
      skills?: string[];
      depends_on?: string[];
      inputs?: Array<{ path?: string; desc: string }>;
      outputs: Array<{ path: string; desc: string }>;
      checks: Array<{ method: "command" | "file_exists" | "llm_rubric" | "manual"; target?: string; desc: string }>;
    }>;
  }>("composer", COMPOSER_SYSTEM, userPrompt);

  const workflow = assembleWorkflow(projectId, state.project.goal, llmResult);
  const validation = validateWorkflowSpec(workflow);
  if (!validation.passed) throw new Error(`Generated workflow failed hard checks: ${validation.errors.join("; ")}`);

  const dir = projectPath(rootDir, projectId);
  await writeGeneratedResources(dir, workflow, llmResult);

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

function buildComposerPrompt(goal: string, clarifications: Array<{ q: string; a: string; risk: string }>): string {
  const lines = [`目标: ${goal}`, ""];
  if (clarifications.length > 0) {
    lines.push("已澄清信息:");
    for (const entry of clarifications) {
      lines.push(`  Q: ${entry.q}`);
      lines.push(`  A: ${entry.a}`);
    }
  }
  lines.push("");
  lines.push("请合成方案调研阶段的 workflow。");
  return lines.join("\n");
}

function assembleWorkflow(
  projectId: string,
  rawGoal: string,
  llmResult: { clarified: string; acceptance: string[]; tasks: TaskSpec[] },
): WorkflowSpec {
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
      on_reject: { bounce_to: llmResult.tasks[1]?.id ?? llmResult.tasks[0]?.id ?? "t1", cascade: "downstream", feedback_to_context: true },
      audit: true,
    },
  ];

  return {
    version: "0.1",
    project_id: projectId,
    phase: "solution",
    goal: {
      raw: rawGoal,
      clarified: llmResult.clarified || rawGoal,
      deliverable_type: "research",
      acceptance: llmResult.acceptance,
    },
    clarifications: [],
    required_capabilities: ["web", "browser", "long_running"],
    selected_executor: "hermes",
    agents: [...new Set(llmResult.tasks.map((task) => task.agent))],
    skills: [...new Set(llmResult.tasks.flatMap((task) => task.skills ?? []))],
    scripts: [],
    tasks: llmResult.tasks,
    gates,
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

async function writeGeneratedResources(dir: string, workflow: WorkflowSpec, llmResult: unknown): Promise<void> {
  await writeYaml(join(dir, "solution", "workflow.yaml"), workflow);
  await writeYaml(join(dir, "solution", "self-check.yaml"), {
    hard_checks: { passed: true, checks: ["dag_acyclic", "checks_present", "executor_capabilities"] },
    evaluation: { model_role: "evaluator", note: "LLM-composed workflow, hard-checked by code" },
  });

  for (const agentName of workflow.agents) {
    await writeYaml(join(dir, "agents", `${agentName}.yaml`), { name: agentName, role: agentName });
  }
  for (const skillName of workflow.skills) {
    await writeSkill(dir, skillName, skillName, `Skill ${skillName} for the workflow.`);
  }
}

async function writeSkill(projectDir: string, name: string, title: string, body: string): Promise<void> {
  const dir = join(projectDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n\n# ${title}\n\n${body}\n`, "utf8");
}

export async function runProject(rootDir: string, projectId: string, client: LlmClient): Promise<void> {
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

    await executeLlmTask(rootDir, projectId, runId, taskSpec, spec, client);
    task.status = "verifying";
    const verdict = await verifyLlmTask(rootDir, projectId, runId, taskSpec, client);
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

async function readWorkflowSpec(rootDir: string, projectId: string): Promise<WorkflowSpec> {
  return parse(await readFile(join(projectPath(rootDir, projectId), "solution", "workflow.yaml"), "utf8")) as WorkflowSpec;
}

function dependenciesDelivered(workflow: WorkflowRecord, taskSpec: TaskSpec): boolean {
  return (taskSpec.depends_on ?? []).every((dependency) => workflow.tasks[dependency]?.status === "delivered");
}

const EXECUTOR_SYSTEM = `你是一个方案调研执行者。根据 task 描述,产出该 task 的交付物内容。

规则:
- 用中文写,Markdown 格式
- 内容要具体、有实质,不要空话
- 直接输出内容正文,不要加多余说明
- 如果是调研 task,列出具体候选方案、字段、限制、成本、合规
- 如果是分析 task,给出对比表、推荐方案和理由、实施任务拆解
- 如果是审查 task,列出假设、遗漏、风险`;

async function executeLlmTask(rootDir: string, projectId: string, runId: string, task: TaskSpec, spec: WorkflowSpec, client: LlmClient): Promise<void> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);
  await mkdir(runDir, { recursive: true });

  const inputContents: string[] = [];
  for (const input of task.inputs ?? []) {
    if (input.path) {
      try {
        inputContents.push(`\n--- ${input.path} ---\n${await readFile(join(dir, input.path), "utf8")}`);
      } catch {
        // input not available yet
      }
    }
  }

  const userPrompt = [
    `项目目标: ${spec.goal.clarified}`,
    "",
    `Task: ${task.id}`,
    `描述: ${task.desc}`,
    "",
    inputContents.length > 0 ? `上游输入:${inputContents.join("\n")}` : "无上游输入。",
    "",
    "请产出本 task 的交付物内容。",
  ].join("\n");

  const content = await client.complete("composer", EXECUTOR_SYSTEM, userPrompt);

  for (const output of task.outputs) {
    const outputPath = join(dir, output.path);
    if (output.path.endsWith("/")) {
      await mkdir(outputPath, { recursive: true });
      await writeFile(join(outputPath, "content.md"), content, "utf8");
    } else {
      await mkdir(join(outputPath, ".."), { recursive: true });
      await writeFile(outputPath, content, "utf8");
    }
  }

  await writeFile(join(runDir, "claim.md"), `# Claim\n\nTask ${task.id} executed by LLM.\n\nAgent: ${task.agent}\n\nClaim: ${content.slice(0, 200)}...\n`, "utf8");
  await writeFile(join(runDir, "log.md"), `# Log\n\nExecuted ${task.id} via LLM.\n`, "utf8");
}

const VERIFIER_SYSTEM = `你是一个独立的验收者(verifier)。你的任务是判断 task 的交付物是否满足验收标准。

你必须返回 JSON:
{"passed": true/false, "reasons": ["理由1", ...], "evidence": ["证据文件路径或内容引用"]}

规则:
- 你是独立于执行者的,不要相信执行者的自述,要自己检查内容
- passed=true 仅当内容确实满足验收标准
- reasons 要具体,说明哪些满足了、哪些没满足
- 用中文`;

async function verifyLlmTask(rootDir: string, projectId: string, runId: string, task: TaskSpec, client: LlmClient): Promise<VerdictRecord> {
  const dir = projectPath(rootDir, projectId);

  const outputContents: string[] = [];
  for (const output of task.outputs) {
    const targetPath = output.path.endsWith("/") ? join(output.path, "content.md") : output.path;
    try {
      const content = await readFile(join(dir, targetPath), "utf8");
      outputContents.push(`\n--- ${output.path} ---\n${content.slice(0, 2000)}`);
    } catch {
      outputContents.push(`\n--- ${output.path} ---\n(文件不存在)`);
    }
  }

  const checkDescs = task.checks.map((check) => `- [${check.method}] ${check.desc}${check.target ? ` (target: ${check.target})` : ""}`).join("\n");
  const userPrompt = [
    `Task: ${task.id}`,
    `描述: ${task.desc}`,
    "",
    "验收标准:",
    checkDescs,
    "",
    "交付物内容:",
    outputContents.join("\n"),
    "",
    "请独立判断交付物是否满足验收标准。",
  ].join("\n");

  const llmResult = await client.completeJson<{ passed: boolean; reasons: string[]; evidence: string[] }>("evaluator", VERIFIER_SYSTEM, userPrompt);

  const verdict: VerdictRecord = {
    passed: llmResult.passed,
    method: "combined",
    reasons: llmResult.reasons ?? [],
    evidence: llmResult.evidence ?? [],
  };
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
