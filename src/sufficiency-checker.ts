import type { LlmClient } from "./llm.js";
import type { GraphWorkflowSpec } from "./types.js";
import { getEffectiveDeliverableContract, renderDeliverableContract } from "./artifacts.js";

/**
 * 充分性检查器(独立 evaluator 角色,生成/审查不同源)。
 * Composer 生成 spec 后,三层审查:路径完备性/指令具体性/验收对齐。
 * 只检查、只报告问题,不自己修(修是 Composer 的事)。
 */

export interface SufficiencyIssue {
  layer: "path_completeness" | "instruction_specificity" | "check_alignment" | "deliverable_contract";
  severity: "error" | "warning";
  node_id?: string;
  description: string;
}

export interface SufficiencyResult {
  passed: boolean;
  issues: SufficiencyIssue[];
}

const CHECKER_SYSTEM = `你是一个规划充分性检查器。你审查 Composer 生成的工作流 spec,找出问题。

你只检查、只报告问题,不自己修。

三层审查:

1. 路径完备性(path_completeness):这组节点能从起点推进到完成标准吗?有没有断路?
   - 检查 entry_node 到 completion_criteria 之间,能力是否覆盖完整交付链
   - 检查有没有明显的缺失环节(如目标要"发布"但没有发布相关节点)

2. 指令具体性(instruction_specificity):每个节点的 desc 足够具体到 executor 不会跑偏吗?
   - "写一章"太模糊;"写一章,承接上章,3000字,纯正文"才具体
   - 检查有没有 desc 模糊到会让 executor 自由发挥的

3. 验收对齐(check_alignment):hard_constraints 是否落到了对应节点的 checks 里?
   - 如果硬约束说"输出纯正文",对应的产出节点 checks 里要有这条
   - 检查有没有硬约束没落到任何节点的 checks

4. 交付物契约(deliverable_contract):产出节点是否能生成符合类型的正式交付物?
   - research 必须能产出结构化调研正文,覆盖产品概览、评测3维、可观测5维、结论与建议
   - creative 必须能产出正文,不能把过程笔记冒充正文
   - implementation 必须能产出问题、方案、实现细节、验证
   - agent 节点的 desc/checks/outputs 至少一个位置必须体现这些结构要求

返回 JSON:
{"passed": true/false, "issues": [
  {"layer": "path_completeness|instruction_specificity|check_alignment|deliverable_contract", "severity": "error|warning", "node_id": "相关节点id(可选)", "description": "问题描述"}
]}

passed=true 仅当没有 error 级问题。warning 不阻塞但需报告。
用中文。`;

export async function checkSufficiency(
  client: LlmClient,
  spec: GraphWorkflowSpec,
): Promise<SufficiencyResult> {
  const capList = spec.capabilities.map(c => {
    const checks = (c.checks ?? []).map(ch => `[${ch.method}] ${ch.desc}`).join("; ");
    return `- ${c.id} [${c.kind}]: ${c.desc} | checks: ${checks || "(无)"} | outputs: ${(c.outputs ?? []).map(o => o.path).join(",")}`;
  }).join("\n");

  const deliverableContract = getEffectiveDeliverableContract(spec.goal.deliverable_type, spec.deliverable_contract);
  const userPrompt = [
    `目标: ${spec.goal.clarified}`,
    `交付物类型: ${spec.goal.deliverable_type}`,
    renderDeliverableContract(deliverableContract),
    "",
    `完成标准:`,
    ...spec.completion_criteria.map(c => `  - ${c}`),
    "",
    `硬约束:`,
    ...spec.hard_constraints.map(c => `  - ${c}`),
    "",
    `软引导:`,
    ...spec.soft_guidance.map(c => `  - ${c}`),
    "",
    `能力清单:`,
    capList,
    "",
    `入口节点: ${spec.entry_node}`,
    "",
    "请四层审查:路径完备性、指令具体性、验收对齐、交付物契约。",
  ].join("\n");

  const result = await client.completeJson<SufficiencyResult>("evaluator", CHECKER_SYSTEM, userPrompt);
  return result;
}
