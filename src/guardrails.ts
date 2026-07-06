import type { LlmClient } from "./llm.js";
import type { Guardrails, GraphWorkflowSpec } from "./types.js";

export interface GuardrailCheckResult {
  hit: boolean;
  which?: string;
  reason?: string;
}

/** 硬护栏:纯代码判断,不调模型 */
export function checkHardGuardrails(guardrails: Guardrails, iteration: number, totalTokens: number, startTime: number): GuardrailCheckResult {
  if (iteration >= guardrails.hard.max_iterations) {
    return { hit: true, which: "max_iterations", reason: `已达轮次上限 ${guardrails.hard.max_iterations}` };
  }
  if (guardrails.hard.max_cost_tokens && totalTokens >= guardrails.hard.max_cost_tokens) {
    return { hit: true, which: "max_cost_tokens", reason: `已达 token 上限 ${guardrails.hard.max_cost_tokens}` };
  }
  if (guardrails.hard.max_wall_time) {
    const limitMs = parseDuration(guardrails.hard.max_wall_time);
    if (Date.now() - startTime > limitMs) {
      return { hit: true, which: "max_wall_time", reason: `已达时间上限 ${guardrails.hard.max_wall_time}` };
    }
  }
  return { hit: false };
}

/** 软护栏:独立模型判断当前要做的事是否碰红线 */
export async function checkSoftGuardrails(
  client: LlmClient,
  spec: GraphWorkflowSpec,
  blackboard: Record<string, unknown>,
  nextNodeDesc: string,
): Promise<GuardrailCheckResult> {
  if (spec.guardrails.soft.length === 0) return { hit: false };

  const SOFT_SYSTEM = `你是一个安全护栏检查者。判断即将执行的操作是否触碰预设的红线。

返回 JSON:
{"hit": true/false, "which": "红线id(命中时)", "reason": "为什么碰线"}

规则:
- 只检查给定的红线清单,不要编造
- hit=true 仅当即将执行的操作明确触碰某条红线
- 用中文`;

  const rules = spec.guardrails.soft.map(s => `- ${s.id}: ${s.desc}`).join("\n");
  const bbStr = JSON.stringify(blackboard).slice(0, 1000);
  const userPrompt = [
    "红线清单:", rules, "",
    "即将执行的操作:", nextNodeDesc, "",
    "当前状态:", bbStr, "",
    "判断是否碰红线。",
  ].join("\n");

  const result = await client.completeJson<{ hit: boolean; which?: string; reason?: string }>("evaluator", SOFT_SYSTEM, userPrompt);
  return { hit: result.hit ?? false, which: result.which, reason: result.reason };
}

/** 检查是否到了阶段性人审点 */
export function shouldHumanCheckpoint(spec: GraphWorkflowSpec, iteration: number): boolean {
  const every = spec.guardrails.human_checkpoint_every;
  if (!every || every <= 0) return false;
  return iteration > 0 && iteration % every === 0;
}

function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60000 : unit === "h" ? 3600000 : 86400000;
  return n * mult;
}
