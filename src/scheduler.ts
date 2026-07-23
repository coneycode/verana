import type { LlmClient } from "./llm.js";
import type { CapabilityNode, GraphWorkflowSpec } from "./types.js";
import { renderBlackboardForContext } from "./blackboard.js";

const SCHEDULER_SYSTEM = `你是一个调度大脑(scheduler)。你是调度决策的唯一出口。你的职责是基于当前进度真相(含归因结果),决定下一步做什么。

你必须返回 JSON:
{"next_node": "节点id(留空表示不执行节点)", "reason": "为什么这么决策", "capability_gap": "如果需要清单里没有的能力,描述需要什么(否则留空)", "is_complete": true/false, "action": "路由动作"}

路由动作(action)可选值:
- "execute":正常执行 next_node 指定的节点
- "retry_with_feedback":重跑上次失败的节点(指令已带失败反馈,让它针对性修正)
- "switch_node":换一个现有节点(当前节点不对路,清单里有更合适的)
- "request_capability":请求新增能力(capability_gap 描述需要什么,交 Composer 复核)
- "skip_node":跳过该非必要节点继续(该节点反复失败但不影响主交付)
- "materialize":让 materializer 从已有产出(claim/stream/坏artifact)整理出正式产物(仅限F根因且failure_codes属于形态类:looks_like_*/metadata_only/too_small/structure_*;如果failure_codes含missing/empty说明根本没有内容,不该materialize应重跑)
- "human":转人审(低频重大决策:删改节点/回澄清/调完成标准/终止)

决策规则:
- 进度真相里 verdict=passed 的节点不要重复选,除非需要再产出一个新实例(如写下一章)
- 如果进度真相显示已完成标准(completion_criteria)所需的节点都验证通过,设 is_complete=true
- 如果有节点 FAIL 且带 [根因:X],按根因路由:
  - A_instruction_vague(指令不具体):action="retry_with_feedback"(指令已带上次失败反馈,让它修正)
  - B_capability_gap(能力缺口):action="request_capability"(capability_gap 描述需要什么能力)
  - C_context_error(上下文错):action="retry_with_feedback"(blackboard 已修正,重跑)
  - D_standard_unreasonable(标准不合理):action="human"(验收标准要改,属重大决策)
  - E_goal_problem(目标/规划问题):action="human"(回澄清或重规划,属重大决策)
  - F_artifact_contract_failure(产物契约失败):看 failure_codes 判断
    - failure_codes 含 declared_output_missing/declared_output_empty:executor 根本没产出内容,action="retry_with_feedback"(重跑让executor产出)
    - failure_codes 只有形态类(looks_like_*/metadata_only/too_small/structure_*):executor 有产出但形态不对,action="materialize"(让materializer整理)
    - 同一节点已 materialize 过且还是 fail:action="retry_with_feedback"(materializer修不了,让executor重做)
    - 同一节点 retry+materialize 循环超过2次:action="human"
- 同一节点归因-修复循环超过2次还失败:action="human"
- 如果清单里没有合适的能力:action="request_capability",capability_gap 描述需求
- reason 必须具体,说明基于进度真相里的哪些事实(含根因)做的判断
- 用中文`;

export interface SchedulerDecision {
  next_node: string;
  reason: string;
  capability_gap: string;
  is_complete: boolean;
  action?: "execute" | "retry_with_feedback" | "switch_node" | "request_capability" | "skip_node" | "human" | "materialize";
}

export async function runScheduler(
  client: LlmClient,
  spec: GraphWorkflowSpec,
  blackboard: Record<string, unknown>,
  progressTruth: string,
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
    progressTruth,
    "",
    "请基于进度真相选择下一步。如果有节点 FAIL 带根因,按根因路由到对应修复动作(action)。已验证 passed 的节点不要重复选(除非需要产新实例)。",
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
