import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "./llm.js";
import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type { CapabilityNode, DeliverableContract, GraphWorkflowSpec, GraphRuntime, Instance, ExecutionFacts, MaxTurnsReview } from "./types.js";
import { validateGraphWorkflow } from "./workflow-validator.js";
import { checkSufficiency } from "./sufficiency-checker.js";
import { projectEvent, type EventBus } from "./events.js";
import { getProjectDeliverableContract } from "./artifacts.js";

// 重导出图执行引擎
export { runGraphProject, readGraphSpec, applyHumanVerdict } from "./graph-engine.js";

const COMPOSER_SYSTEM_BASE = `你是一个 workflow 规划者(Composer)。你的职责是把用户目标编译成一套可执行的图工作流规格。

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
      "id": "节点id(英文短名,如collect_evidence)",
      "name": "中文短名(如:收集证据,前端展示用)",
      "kind": "light | agent",
      "desc": "这个节点做什么的自然语言描述(中文)",
      "agent": "角色名(agent节点必填,如writer/researcher)",
      "outputs": [{"path": "solution/xxx.md", "desc": "产出说明", "role": "evidence | deliverable | intermediate", "materializable": true}],
      "checks": [{"method": "llm_rubric | file_exists", "desc": "验收描述", "target": "路径(file_exists时)"}],
      "updates": ["blackboard字段名(如果这个节点负责更新记忆)"],
      "instances": [{"name": "实例名", "scope": "该维度包含什么", "excludes": "该维度不包含什么(其他维度的内容)"}],  // 可多次调度的节点列出实例;一次性节点留空数组[]
      "context_inputs": ["blackboard字段名"]  // 这个节点执行时需要看哪些blackboard字段;不填或留空=注入全量
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
- 能力清单要覆盖目标的完整交付链,参考下方"本次任务类型"给出的能力链骨架
- 节点拆分原则(任务单一化,节点间解耦):
  - 每个节点只做一件事:搜索 OR 整理 OR 写作 OR 审校,不要绑在一起
  - 开放式搜索(不可预测何时搜够)和确定性整理(有明确输入和产出)分离到不同节点
  - 节点间通过 blackboard 和声明 outputs 解耦:上游产出文件+更新 blackboard,下游读 blackboard 获取上下文
  - 中间产物(search 原始结果/evidence 整理结果)不要求最终交付物质量,最终质量由 synthesize + review 保证
- 报告写作链路(research 型):
  - plan_outline(light,大纲规划):根据目标生成报告大纲(章节+每章要点+每个维度的调研方向),写入 blackboard 的 report_outline。不搜索、不产出文件,只做结构规划
  - search(agent,×N instances):按大纲的调研方向搜该维度信息,边搜边把原始结果追加写入文件。产出 role=evidence,路径 solution/search/{instance}.md。不要求结构化、不要求整理——搜到一条写一条,每条标注来源。文件始终存在(不会 declared_output_missing)。check 只要求"有搜索结果+有来源",不要求"深入"或"完整"
  - write_evidence(agent,×N instances):从 search 文件读取原始搜索结果,整理成结构化证据文件。产出 role=intermediate,路径 solution/evidence/{instance}.md。不需要搜索,只整理——有明确输入和产出。context_inputs 包含 report_outline
  - synthesize(agent):从所有维度 evidence 文件综合写成完整报告初稿。搜到的用真实来源,搜不到的用 LLM 知识标注为趋势推演。产出 role=deliverable。context_inputs 包含 report_outline + evidence 结果索引
  - polish_report(agent):读初稿做语言/逻辑/格式优化,产出最终报告。context_inputs 包含 report_outline
  - review_report(agent):审校最终报告是否满足全部验收标准
  - 缺大纲规划或润色修订,校验不通过打回重生成
- 报告写作链路(creative 型):
  - plan_outline(light) → write_report(agent) → polish_report(agent) → review_report(agent)
  - 不需要 research/ synthesize,直接规划大纲后写
- 轻节点(light):判断/转换/更新记忆,单次调用;重节点(agent):创作/调研/分析,自主完成一件事
- 每个节点必须有 checks(无验收不执行)
- bounded 的 blackboard 字段必须有节点负责 updates
- guardrails.hard.max_iterations 必须有(安全阀)
- hard_constraints:从澄清信息中提取客观、可判定的约束(格式/数量/预算/合规/平台),这些将变成 checks 的种子
- soft_guidance:从澄清信息中提取主观方向性偏好(风格/基调/取舍),这些只作引导不强制
- 拿不准是硬还是软的,默认归 soft_guidance(宁可少锁不可锁错)
- deliverable_contract:根据任务性质决定是否输出 required_sections/forbidden_patterns。只有任务明确需要特定章节结构时才写;不确定就不输出(留空)
- instances:所有节点都声明 instances 字段。可多次调度的节点列出实例清单;一次性节点留空数组[]。对于有非空 instances 的节点,blackboard_schema 里必须设计"{node_id}_remaining"字段(记录未完成实例,bounded=true)
- instances 的目的和判定:instances 的目的是拆分长任务,保证每次 agent 执行的上下文短、聚焦单一子任务,提升成功率。同时支持精准重试(只重跑失败的实例,不重跑已完成的)。判定标准:如果一个节点的工作可以拆成多个独立子任务,每个子任务需要 agent 单独搜索/推理/写入,用 instances。如果一次 agent 执行能完成所有产出,不用 instances
- instances 的 scope/excludes:每个 instance 带 scope(该维度包含什么)和 excludes(该维度不包含什么,来自其他 instance 的维度)。executor 执行时只写 scope 范围内的内容,不写 excludes 里的内容。这避免跨维度内容混入
- instances 和 output 路径:有非空 instances 的节点,每个 output path 必须含 {instance} 占位符(如 solution/evidence/{instance}.md),每个实例写入不同文件。不含 {instance} 的路径校验不通过
- context_inputs:每个节点声明执行时需要参考的 blackboard 字段。只注入这个节点真正需要的字段。不填或留空数组=注入全量(兜底)。_remaining 字段是代码维护的不需要放进 context_inputs。context_inputs 里的字段名必须在 blackboard_schema.fields 里存在
- entry_node 是调度大脑第一步选的节点(通常是最早的能力)
- 用中文写 desc
- required_capabilities 从 [web, browser, long_running] 里选
- selected_executor 固定 "hermes"
- skills/scripts 留空数组
- clarifications 留空数组`;

interface TaskTemplate {
  chain: string;
  guidance: string;
}

const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  research: {
    chain: "plan_outline(light) → search(×N instances, 按维度拆分) → write_evidence(×N instances, 按维度拆分) → synthesize(agent) → polish_report(agent) → review_report(agent)",
    guidance: "调研型任务。先规划大纲(含每个维度的调研方向)。search 节点边搜边写原始结果到 solution/search/{instance}.md(搜到一条写一条,每条标注来源,不要求结构化)。write_evidence 从 search 文件整理成 solution/evidence/{instance}.md(只整理不搜索)。synthesize 从所有 evidence 综合成完整报告。有 instances 的 output path 必须含 {instance} 占位符。search 和 write_evidence 的 instances 清单一致。",
  },
  creative: {
    chain: "plan_outline(light) → write_report(agent) → polish_report(agent) → review_report(agent)",
    guidance: "创作型任务(PRD/方案/设计文档)。不需要收集证据,直接规划大纲后写。大纲规划根据目标要求生成章节结构和要点,写入 report_outline。",
  },
  implementation: {
    chain: "plan_tasks(light) → implement(×N instances, 按模块拆分) → test(agent) → review(agent)",
    guidance: "实现型任务。按模块拆分实现步骤,每个模块一个 instance。需要有测试节点验证实现正确性。",
  },
};

const CLASSIFIER_SYSTEM = `根据用户目标和澄清结论，判断任务类型。返回 JSON: {"task_type": "research | creative | implementation", "reason": "判断理由"}

判断原则(看语义不看关键词):
- research: 目标是让读者了解/理解/分析某个事物的现状(如"调研""对比""综述")
- creative: 目标是产出一份文档/方案/设计/PRD，让读者参考或照着做(如"输出""撰写""设计"一个方案)。即使方案里描述了实现流程，产出本身是文档不是代码
- implementation: 目标是实际构建/部署/运行一个系统，产出是真实可运行的代码/项目

关键区分:
- "描述实现流程" vs "要求实现代码"：前者是 creative(方案文档里写流程)，后者是 implementation(真要写代码)
- "设计架构" vs "搭建架构"：前者 creative，后者 implementation
- 看澄清结论里用户对最终产出的期望，不看单个词

拿不准的归 creative。`;

async function classifyTask(client: LlmClient, goal: string, conclusions: Array<{ topic: string; conclusion: string }>): Promise<string> {
  const conclusionText = conclusions.length > 0
    ? conclusions.map(c => `[${c.topic}] ${c.conclusion}`).join("\n")
    : "(无)";
  const userPrompt = `目标: ${goal}\n\n澄清结论:\n${conclusionText}\n\n请判断任务类型。`;
  const result = await client.completeJson<{ task_type?: string }>("composer", CLASSIFIER_SYSTEM, userPrompt);
  const taskType = result.task_type ?? "creative";
  return TASK_TEMPLATES[taskType] ? taskType : "creative";
}

export async function planGraphWorkflow(
  rootDir: string,
  projectId: string,
  client: LlmClient,
  bus?: EventBus,
): Promise<GraphWorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const goal = state.project.goal;
  const conclusions = state.status.clarifier?.conclusions ?? [];

  // 标记为 composing(前端据此显示进度)
  state.project.status = "composing";
  await saveProjectState(rootDir, state);
  bus?.publish(projectEvent("status_changed", projectId, { status: "composing" }));

  // 第一步:分类任务类型
  bus?.publish(projectEvent("plan_progress", projectId, { step: "classifying", message: "判断任务类型..." }));
  const taskType = await classifyTask(client, goal, conclusions);
  const template = TASK_TEMPLATES[taskType];
  bus?.publish(projectEvent("plan_progress", projectId, { step: "classified", task_type: taskType, chain: template.chain }));

  // 机械重生成循环:Composer 生成 → 硬校验 → 充分性检查 → 有问题带问题清单重生成
  const MAX_REGEN = Number(process.env.VERANA_MAX_REGEN ?? 3);
  let lastIssues: string = "";
  let lastValidSpec: GraphWorkflowSpec | null = null;

  for (let attempt = 0; attempt < MAX_REGEN; attempt++) {
    bus?.publish(projectEvent("plan_progress", projectId, { step: "composing", attempt: attempt + 1, max: MAX_REGEN, message: `Composer 生成中(第${attempt + 1}次)...` }));
    const userPrompt = buildComposerPrompt(goal, conclusions, taskType, template) + (lastIssues ? `\n\n【上轮问题清单(请修复)】\n${lastIssues}` : "");
    // 推 LLM 输入给前端
    bus?.publish(projectEvent("plan_progress", projectId, { step: "llm_input", role: "composer", content: userPrompt.slice(0, 2000) }));
    const llmResult = await client.completeJson<ComposerLlmResult>("composer", COMPOSER_SYSTEM_BASE, userPrompt);
    // 推 LLM 输出给前端
    bus?.publish(projectEvent("plan_progress", projectId, { step: "llm_output", role: "composer", content: JSON.stringify(llmResult, null, 2).slice(0, 3000) }));

    const spec = assembleSpec(projectId, goal, conclusions, llmResult);
    const validation = validateGraphWorkflow(spec);
    if (!validation.passed) {
      bus?.publish(projectEvent("plan_progress", projectId, { step: "hard_check_failed", attempt: attempt + 1, message: `硬校验未通过: ${validation.errors.join("; ")}` }));
      lastIssues = validation.errors.map(e => `[硬校验] ${e}`).join("\n");
      if (attempt < MAX_REGEN - 1) continue;
      throw new Error(`Generated workflow failed hard checks after ${MAX_REGEN} attempts: ${validation.errors.join("; ")}`);
    }

    // 硬校验过了,记住这个 spec(兜底时用)
    lastValidSpec = spec;

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

  // 循环用尽:所有尝试都过了硬校验但都没过充分性检查。
  // 兜底:用最后一次过了硬校验的 spec 落盘,交人审(充分性问题是 LLM 质量判断,
  // 不是结构错误,人审可以过)。不重新调 LLM(无反馈的重新生成没有意义)。
  if (lastValidSpec) {
    bus?.publish(projectEvent("plan_progress", projectId, { step: "done", message: "规划完成(充分性检查未全过,交人审)" }));
    return composeGraphWorkflow(rootDir, projectId, client, lastValidSpec);
  }
  // 不会到这里(循环里硬校验 fail 到最后一次会 throw,否则 lastValidSpec 非 null)
  throw new Error("Planning failed: no valid spec generated");
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

/** 兼容旧格式:string[] → Instance[] */
function normalizeInstances(raw: unknown): Instance[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  if (raw.length === 0) return [];
  return raw.map((item) => {
    if (typeof item === "string") return { name: item };
    if (typeof item === "object" && item !== null) {
      const obj = item as { name?: string; scope?: string; excludes?: string };
      return { name: obj.name ?? "", scope: obj.scope, excludes: obj.excludes };
    }
    return { name: String(item) };
  });
}

function buildComposerPrompt(goal: string, conclusions: Array<{ topic: string; conclusion: string }>, taskType: string, template: TaskTemplate): string {
  const lines = [`目标: ${goal}`, ""];
  if (conclusions.length > 0) {
    lines.push("澄清结论:");
    for (const c of conclusions) {
      lines.push(`  [${c.topic}] ${c.conclusion}`);
    }
  }
  lines.push("");
  lines.push(`## 本次任务类型: ${taskType}`);
  lines.push("");
  lines.push(`### 能力链骨架(参考,在此基础上细化):`);
  lines.push(`  ${template.chain}`);
  lines.push("");
  lines.push(`### 关键注意事项:`);
  lines.push(`  ${template.guidance}`);
  lines.push("");
  lines.push("请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
  return lines.join("\n");
}

function assembleSpec(projectId: string, rawGoal: string, conclusions: Array<{ topic: string; conclusion: string }>, r: ComposerLlmResult): GraphWorkflowSpec {
  const deliverableType = r.deliverable_type ?? "research";
  const clarifications = conclusions.map(c => ({ q: c.topic, a: c.conclusion, risk: "" }));
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
    name: (c as { name?: string }).name,
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
    instances: normalizeInstances(c.instances),
    context_inputs: (c as { context_inputs?: string[] }).context_inputs,
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

// ===== max-turns 动态调整:Composer 复核 =====

const MAX_TURNS_REVIEW_SYSTEM = `你是一个 workflow 规划者(Composer)。执行器(executor)在执行一个节点时达到了最大轮次上限(max-turns),没有正常完成。

你需要判断:继续给更多轮次是否有帮助?还是节点设计有问题?

返回 JSON:
{"verdict": "resume" | "reframe" | "abandon", "reason": "判断理由", "reframe_action": "split_node" | "adjust_check" | null, "new_max_turns": 数字}

判断依据:
- resume(继续):executor 在产出文件上有进展(文件在增长/在写文件),只是轮次不够。给它更多轮次继续。
- reframe(重新规划):节点任务太重(搜索+整理+写入绑在一起)或产出标准不合理。需要拆分节点或调整 check。
- abandon(放弃):executor 陷入循环(重复搜索同样的词),或产出文件完全不存在且没有写作迹象。继续也没用。

new_max_turns:resume 时给出新的轮次上限(通常在原值基础上增加 50%~100%)。

规则:
- 用中文写理由,基于提供的事实判断,不要臆测
- 优先考虑:executor 做了什么(产出文件状态),而非它说了什么(claim)
- 如果产出文件在增长,倾向 resume
- 如果产出文件不存在且 stream 显示在重复搜索,倾向 abandon
- 如果产出文件存在但内容很少,且 stream 显示在搜索(不是在写),倾向 reframe(任务可能太重)`;

export async function reviewMaxTurnsHit(
  client: LlmClient,
  node: CapabilityNode,
  spec: GraphWorkflowSpec,
  facts: ExecutionFacts,
): Promise<MaxTurnsReview> {
  const outputFactsStr = facts.outputFiles.map(f =>
    `- ${f.path}: ${f.exists ? `存在,${f.bytes}字节,${f.lines}行,修改时间${f.modifiedAt}` : "不存在"}`
  ).join("\n");

  const behaviorStr = facts.streamLastNBehaviors.length > 0
    ? facts.streamLastNBehaviors.map((b, i) => `  ${i + 1}. ${b}`).join("\n")
    : "  (无行为记录)";

  const userPrompt = [
    `节点: ${node.id} (${node.kind})`,
    `描述: ${node.desc}`,
    "",
    "节点产出要求:",
    ...(node.outputs ?? []).map(o => `- ${o.path}: ${o.desc}`),
    "",
    "验收标准:",
    ...(node.checks ?? []).map(c => `- [${c.method}] ${c.desc}`),
    "",
    "执行轨迹事实(机械收集):",
    `已用轮次: ${facts.usedTurns}`,
    `是否已 resume 过: ${facts.hasResumedBefore ? "是" : "否"}`,
    "",
    "产出文件状态:",
    outputFactsStr,
    "",
    "stream 最后 N 轮行为:",
    behaviorStr,
    "",
    `搜索关键词去重率: ${facts.searchKeywordsDedupRatio.toFixed(2)} (0=全重复,1=全不同)`,
    "",
    "请基于以上事实判断:继续给更多轮次是否有帮助?",
  ].join("\n");

  return client.completeJson<MaxTurnsReview>("composer", MAX_TURNS_REVIEW_SYSTEM, userPrompt);
}
