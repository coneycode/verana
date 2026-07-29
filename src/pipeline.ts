import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "./llm.js";
import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type { CapabilityNode, DeliverableContract, GraphWorkflowSpec, GraphRuntime } from "./types.js";
import { validateGraphWorkflow } from "./workflow-validator.js";
import { checkSufficiency } from "./sufficiency-checker.js";
import { projectEvent, type EventBus } from "./events.js";
import { getProjectDeliverableContract } from "./artifacts.js";

// 重导出图执行引擎
export { runGraphProject, readGraphSpec, applyHumanVerdict } from "./graph-engine.js";

const COMPOSER_SYSTEM = `你是一个 workflow 规划者(Composer)。你的职责是把用户目标编译成一套可执行的图工作流规格。

图工作流模型(不是静态 DAG):
- 能力清单(capabilities):这个任务需要哪些功能节点,每个节点做什么、轻还是重、怎么验证
- 护栏(guardrails):什么情况必须停下问人(硬上限 + 软红线)
- blackboard schema:这个任务要记住什么(跨轮记忆,由更新节点压缩维护)
- 调度大脑会在执行中动态决定下一步调哪个节点,你不需要预先画完整图

你必须返回 JSON,结构如下:
{
  "clarified": "澄清后的目标描述",
  "deliverable_type": "research | creative | implementation",
  "iterative": true/false,
  "acceptance": ["验收标准1", ...],
  "capabilities": [
    {
      "id": "节点id(英文短名)",
      "kind": "light | agent",
      "desc": "这个节点做什么的自然语言描述",
      "agent": "角色名(agent节点必填,如writer/researcher)",
      "outputs": [{"path": "solution/xxx.md", "desc": "产出说明", "role": "evidence | deliverable | intermediate", "materializable": true}],
      "checks": [{"method": "llm_rubric | file_exists", "desc": "验收描述", "target": "路径(file_exists时)"}],
      "updates": ["blackboard字段名(如果这个节点负责更新记忆)"],
      "instances": ["实例1", "实例2"]  // 可多次调度的节点列出实例;一次性节点留空数组[]
    }
  ],
  "guardrails": {
    "max_iterations": 数字,
    "soft": [{"id": "红线id", "desc": "红线描述", "action": "stop_human"}],
    "human_checkpoint_every": 数字(每N轮人审,0=不定期)
  },
  "blackboard_schema": {
    "fields": [{"key": "字段名", "desc": "说明", "bounded": true/false(是否要压缩保持有界)}]
  },
  "entry_node": "入口节点id",
  "completion_criteria": ["完成标准1", ...],
  "hard_constraints": ["客观硬约束:如输出格式/数量/预算/合规/平台限定"],
  "soft_guidance": ["主观软引导:如风格基调/内容取舍/表达偏好"],
  "deliverable_contract": {"required_sections": ["章节名(可选,根据任务决定)"], "forbidden_patterns": ["禁止出现的内容模式(可选)"]},
  "agents": ["角色名列表"],
  "required_capabilities": ["web", "browser", "long_running"]
}

规则:
- 能力清单要覆盖目标的完整交付链(创作型:大纲→写→审→更新记忆→判断;调研型:收集证据→沉淀结构化正文→审)
- 轻节点(light):判断/转换/更新记忆,单次调用;重节点(agent):创作/调研/分析,自主完成一件事
- 每个节点必须有 checks(无验收不执行)
- bounded 的 blackboard 字段必须有节点负责 updates
- guardrails.hard.max_iterations 必须有(安全阀)
- creative/iterative 类任务(写多章/反复打磨)→ iterative=true,能力清单含循环潜力(同一节点可被多次调度)
- research 类任务(一次性调研)→ iterative=false,能力清单线性。根据任务复杂度,可考虑拆分证据收集和结构化报告写作(不是强制)
- hard_constraints:从澄清信息中提取客观、可判定的约束(格式/数量/预算/合规/平台),这些将变成 checks 的种子
- soft_guidance:从澄清信息中提取主观方向性偏好(风格/基调/取舍),这些只作引导不强制
- 拿不准是硬还是软的,默认归 soft_guidance(宁可少锁不可锁错)
- deliverable_contract:根据任务性质决定是否输出 required_sections/forbidden_patterns。只有任务明确需要特定章节结构时才写;不确定就不输出(留空)。不要硬套通用章节(如"结论与建议"不一定适用所有调研任务)
- instances:所有节点都声明 instances 字段。可多次调度的节点(如按方案/章节/维度分别处理)列出实例清单;一次性节点留空数组[]。对于有非空 instances 的节点,blackboard_schema 里必须设计"{node_id}_remaining"字段(记录未完成实例,bounded=true)
- entry_node 是调度大脑第一步选的节点(通常是最早的能力)
- 用中文写 desc
- required_capabilities 从 [web, browser, long_running] 里选
- selected_executor 固定 "hermes"
- skills/scripts 留空数组
- clarifications 留空数组`;

export async function planGraphWorkflow(
  rootDir: string,
  projectId: string,
  client: LlmClient,
  bus?: EventBus,
): Promise<GraphWorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const goal = state.project.goal;
  const clarifications = state.status.clarifier?.clarifications ?? [];

  // 标记为 composing(前端据此显示进度)
  state.project.status = "composing";
  await saveProjectState(rootDir, state);
  bus?.publish(projectEvent("status_changed", projectId, { status: "composing" }));

  // 机械重生成循环:Composer 生成 → 硬校验 → 充分性检查 → 有问题带问题清单重生成
  const MAX_REGEN = Number(process.env.VERANA_MAX_REGEN ?? 3);
  let lastIssues: string = "";

  for (let attempt = 0; attempt < MAX_REGEN; attempt++) {
    bus?.publish(projectEvent("plan_progress", projectId, { step: "composing", attempt: attempt + 1, max: MAX_REGEN, message: `Composer 生成中(第${attempt + 1}次)...` }));
    const userPrompt = buildComposerPrompt(goal, clarifications) + (lastIssues ? `\n\n【上轮问题清单(请修复)】\n${lastIssues}` : "");
    // 推 LLM 输入给前端
    bus?.publish(projectEvent("plan_progress", projectId, { step: "llm_input", role: "composer", content: userPrompt.slice(0, 2000) }));
    const llmResult = await client.completeJson<ComposerLlmResult>("composer", COMPOSER_SYSTEM, userPrompt);
    // 推 LLM 输出给前端
    bus?.publish(projectEvent("plan_progress", projectId, { step: "llm_output", role: "composer", content: JSON.stringify(llmResult, null, 2).slice(0, 3000) }));

    const spec = assembleSpec(projectId, goal, clarifications, llmResult);
    const validation = validateGraphWorkflow(spec);
    if (!validation.passed) {
      bus?.publish(projectEvent("plan_progress", projectId, { step: "hard_check_failed", attempt: attempt + 1, message: `硬校验未通过: ${validation.errors.join("; ")}` }));
      lastIssues = validation.errors.map(e => `[硬校验] ${e}`).join("\n");
      if (attempt < MAX_REGEN - 1) continue;
      throw new Error(`Generated workflow failed hard checks after ${MAX_REGEN} attempts: ${validation.errors.join("; ")}`);
    }

    // 充分性检查(独立 evaluator,三层审查)
    bus?.publish(projectEvent("plan_progress", projectId, { step: "sufficiency_check", attempt: attempt + 1, message: `充分性检查中(路径/指令/验收)...` }));
    const sufficiency = await checkSufficiency(client, spec);
    // 推充分性检查结果给前端
    bus?.publish(projectEvent("plan_progress", projectId, { step: "sufficiency_result", content: JSON.stringify(sufficiency, null, 2).slice(0, 2000) }));
    const errors = (sufficiency.issues ?? []).filter(i => i.severity === "error");
    if (errors.length === 0) {
      // 通过!落盘
      bus?.publish(projectEvent("plan_progress", projectId, { step: "done", message: "规划完成,进入人审" }));
      return composeGraphWorkflow(rootDir, projectId, client, spec);
    }

    // 有问题,带问题清单重生成
    bus?.publish(projectEvent("plan_progress", projectId, { step: "sufficiency_failed", attempt: attempt + 1, message: `发现${errors.length}个问题,带问题清单重生成...` }));
    lastIssues = errors.map(i => `[${i.layer}] ${i.node_id ? `节点${i.node_id}: ` : ""}${i.description}`).join("\n");
  }

  // 循环用尽,最后兜底:用最后一次的 spec(即使有 warning)落盘
  const userPrompt = buildComposerPrompt(goal, clarifications);
  const llmResult = await client.completeJson<ComposerLlmResult>("composer", COMPOSER_SYSTEM, userPrompt);
  const spec = assembleSpec(projectId, goal, clarifications, llmResult);
  return composeGraphWorkflow(rootDir, projectId, client, spec);
}

interface ComposerLlmResult {
  clarified: string;
  deliverable_type: "research" | "creative" | "implementation";
  iterative: boolean;
  acceptance: string[];
  capabilities: Array<Partial<CapabilityNode> & { id: string }>;
  guardrails: {
    max_iterations: number;
    max_retries_per_node?: number;
    soft: Array<{ id: string; desc: string; action: string }>;
    human_checkpoint_every: number;
  };
  blackboard_schema: { fields: Array<{ key: string; desc: string; bounded: boolean }> };
  entry_node: string;
  completion_criteria: string[];
  hard_constraints?: string[];
  soft_guidance?: string[];
  deliverable_contract?: { required_sections?: string[]; forbidden_patterns?: string[]; notes?: string[] };
  agents: string[];
  required_capabilities: string[];
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
  lines.push("请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
  return lines.join("\n");
}

function assembleSpec(projectId: string, rawGoal: string, clarifications: Array<{ q: string; a: string; risk: string }>, r: ComposerLlmResult): GraphWorkflowSpec {
  const deliverableType = r.deliverable_type ?? "research";
  const deliverableContract = getProjectDeliverableContract({
    goal: {
      raw: rawGoal,
      clarified: r.clarified || rawGoal,
      deliverable_type: deliverableType,
      iterative: r.iterative ?? false,
      acceptance: r.acceptance ?? [],
    },
    clarifications,
    hard_constraints: r.hard_constraints ?? [],
    deliverable_contract: r.deliverable_contract as Partial<DeliverableContract> | undefined,
  });
  const capabilities: CapabilityNode[] = (r.capabilities ?? []).map((c) => ({
    id: c.id,
    kind: c.kind === "agent" ? "agent" : "light",
    desc: c.desc ?? "",
    agent: c.agent,
    skills: c.skills,
    inputs: c.inputs,
    outputs: c.outputs?.map((output) => ({
      ...output,
      role: output.role ?? "deliverable",
      materializable: output.materializable ?? output.role !== "evidence",
    })),
    checks: c.checks?.length ? c.checks : [{ method: "llm_rubric", desc: "产出满足要求" }],
    updates: c.updates,
    instances: c.instances,
  }));

  return {
    version: "0.2",
    project_id: projectId,
    phase: "solution",
    flow_type: "graph",
    goal: {
      raw: rawGoal,
      clarified: r.clarified || rawGoal,
      deliverable_type: deliverableType,
      iterative: r.iterative ?? false,
      acceptance: r.acceptance ?? [],
    },
    clarifications: clarifications.map(c => ({ q: c.q, a: c.a })),
    required_capabilities: r.required_capabilities ?? ["web", "long_running"],
    selected_executor: "hermes",
    agents: r.agents ?? [...new Set(capabilities.filter(c => c.agent).map(c => c.agent!))],
    skills: [],
    scripts: [],
    capabilities,
    guardrails: {
      hard: { max_iterations: r.guardrails?.max_iterations ?? 20, max_retries_per_node: r.guardrails?.max_retries_per_node ?? 3 },
      soft: (r.guardrails?.soft ?? []).map(s => ({
        id: s.id,
        desc: s.desc,
        action: s.action === "require_confirm" ? "require_confirm" : "stop_human",
      })),
      human_checkpoint_every: r.guardrails?.human_checkpoint_every ?? 0,
    },
    blackboard_schema: {
      fields: r.blackboard_schema?.fields ?? [],
    },
    entry_node: r.entry_node && capabilities.some((c) => c.id === r.entry_node) ? r.entry_node : (capabilities[0]?.id ?? ""),
    completion_criteria: r.completion_criteria ?? [],
    hard_constraints: [
      ...((r as { hard_constraints?: string[] }).hard_constraints ?? []),
      `交付物必须满足结构契约: ${deliverableContract.required_sections.join(" / ")}`,
      `交付物禁止出现过程自述模式: ${deliverableContract.forbidden_patterns.join(" / ")}`,
    ],
    soft_guidance: (r as { soft_guidance?: string[] }).soft_guidance ?? [],
    deliverable_contract: deliverableContract,
    policies: { long_running: { idle_watchdog: "30m", max_wall: "4h" }, on_failure: "stop_and_report" },
  };
}

function withDeliverableContract(spec: GraphWorkflowSpec): GraphWorkflowSpec {
  const deliverableContract = getProjectDeliverableContract(spec);
  const hardConstraints = spec.deliverable_contract
    ? spec.hard_constraints
    : [
      ...(spec.hard_constraints ?? []),
      `交付物必须满足结构契约: ${deliverableContract.required_sections.join(" / ")}`,
      `交付物禁止出现过程自述模式: ${deliverableContract.forbidden_patterns.join(" / ")}`,
    ];
  return {
    ...spec,
    agents: spec.agents.length > 0 ? spec.agents : [...new Set(spec.capabilities.filter(c => c.agent).map(c => c.agent!))],
    entry_node: spec.entry_node && spec.capabilities.some((c) => c.id === spec.entry_node) ? spec.entry_node : (spec.capabilities[0]?.id ?? ""),
    hard_constraints: hardConstraints,
    deliverable_contract: deliverableContract,
  };
}

/** 把已组装的 spec 落盘 + 初始化 GraphRuntime(plan_review)。plan 端点可传 spec 或由 planGraphWorkflow 生成 */
export async function composeGraphWorkflow(
  rootDir: string,
  projectId: string,
  _client: LlmClient,
  spec: GraphWorkflowSpec,
): Promise<GraphWorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const dir = projectPath(rootDir, projectId);

  const normalizedSpec = withDeliverableContract(spec);
  const validation = validateGraphWorkflow(normalizedSpec);
  if (!validation.passed) throw new Error(`Workflow failed hard checks: ${validation.errors.join("; ")}`);

  await writeYaml(join(dir, "solution", "workflow.yaml"), normalizedSpec);
  await mkdir(join(dir, "agents"), { recursive: true });
  for (const agentName of spec.agents) {
    await writeYaml(join(dir, "agents", `${agentName}.yaml`), { name: agentName, role: agentName });
  }

  state.project.status = "solutioning";
  state.status.active_workflow = "solution";
  state.status.flow_type = "graph";
  const runtime: GraphRuntime = {
    workflow_status: "plan_review",
    selected_executor: spec.selected_executor,
    required_capabilities: spec.required_capabilities,
    current_node: null,
    iteration: 0,
    awaiting: "none",
    blackboard: {},
    runs: {},
    node_retries: {},
    capabilities_added: [],
  };
  state.status.workflows.solution = runtime;
  await saveProjectState(rootDir, state);
  return normalizedSpec;
}
