import type { LlmClient } from "./llm.js";
import type { CapabilityNode, GraphWorkflowSpec } from "./types.js";
import { renderBlackboardForContext } from "./blackboard.js";

const SCHEDULER_SYSTEM = `你是一个调度大脑(scheduler)。你的职责是基于当前运行时状态,从预定义的能力清单里选一个下一步执行的节点。

你必须返回 JSON:
{"next_node": "节点id", "reason": "为什么选这个节点", "capability_gap": "如果当前能力清单里没有合适的能力,在这里描述需要什么能力(否则留空)", "is_complete": true/false}

规则:
- 只能从给定的能力清单(capabilities)里选 next_node,不能编造清单外的节点
- 如果清单里没有合适的能力,设 next_node 为空,capability_gap 里描述需要什么能力
- 如果当前状态已经满足完成标准(completion_criteria),设 is_complete 为 true,next_node 为空
- reason 必须具体,说明基于当前 blackboard 哪些信息做的判断
- 用中文`;

export interface SchedulerDecision {
  next_node: string;
  reason: string;
  capability_gap: string;
  is_complete: boolean;
}

export async function runScheduler(
  client: LlmClient,
  spec: GraphWorkflowSpec,
  blackboard: Record<string, unknown>,
  lastNodeOutput: string,
  iteration: number,
): Promise<SchedulerDecision> {
  const capList = spec.capabilities.map((c) => `- ${c.id} [${c.kind}]: ${c.desc}`).join("\n");
  const completion = spec.completion_criteria.map((c) => `- ${c}`).join("\n");
  const bbCtx = renderBlackboardForContext(blackboard, spec.blackboard_schema);

  const userPrompt = [
    `迭代轮次: ${iteration}`,
    "",
    "能力清单:",
    capList,
    "",
    "完成标准:",
    completion,
    "",
    bbCtx,
    "",
    "上一个完成的节点产出:",
    lastNodeOutput.slice(0, 2000) || "(无,这是第一步)",
    "",
    "请选择下一步执行的节点。",
  ].join("\n");

  return client.completeJson<SchedulerDecision>("composer", SCHEDULER_SYSTEM, userPrompt);
}

/** Composer 复核能力缺口是否合理(执行中触发) */
export async function reviewCapabilityGap(
  client: LlmClient,
  spec: GraphWorkflowSpec,
  gapDescription: string,
  blackboard: Record<string, unknown>,
  lastReason: string,
): Promise<{ reasonable: boolean; newNode?: CapabilityNode; reason: string }> {
  const REVIEW_SYSTEM = `你是一个 workflow 规划者(Composer)。调度大脑报告了一个能力缺口。判断这个缺口是否合理,合理的话给出新增能力节点的定义。

返回 JSON:
{"reasonable": true/false, "reason": "判定理由", "new_node": {"id":"节点id","kind":"light|agent","desc":"做什么","checks":[{"method":"llm_rubric","desc":"验收"}]}}

规则:
- reasonable=true 仅当这个能力确实是完成当前目标所必需的,不是跑偏
- new_node 必须符合能力节点结构,有 checks
- 用中文`;

  const bbCtx = renderBlackboardForContext(blackboard, spec.blackboard_schema);
  const userPrompt = [
    "目标:", spec.goal.clarified, "",
    "完成标准:", spec.completion_criteria.join("; "), "",
    "当前能力清单:", spec.capabilities.map(c=>c.id).join(", "), "",
    "调度大脑报告的缺口:", gapDescription, "",
    "调度大脑的理由:", lastReason, "",
    bbCtx, "",
    "判断这个缺口是否合理,合理的话给出新节点定义。",
  ].join("\n");

  const result = await client.completeJson<{ reasonable: boolean; reason: string; new_node: Partial<CapabilityNode> & { id: string } }>("composer", REVIEW_SYSTEM, userPrompt);
  if (!result.reasonable) {
    return { reasonable: false, reason: result.reason };
  }
  const nn = result.new_node;
  const newNode: CapabilityNode = {
    id: nn.id,
    kind: nn.kind ?? "light",
    desc: nn.desc ?? "",
    agent: nn.agent,
    skills: nn.skills,
    inputs: nn.inputs,
    outputs: nn.outputs,
    checks: nn.checks ?? [{ method: "llm_rubric", desc: "产出满足要求" }],
    updates: nn.updates,
  };
  return { reasonable: true, newNode, reason: result.reason };
}
