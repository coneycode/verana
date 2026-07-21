import type { LlmClient } from "./llm.js";
import type { CapabilityNode, GraphWorkflowSpec, VerdictRecord } from "./types.js";
import { renderBlackboardForContext } from "./blackboard.js";

/**
 * 根因类型(六类,覆盖链路每一环,不重叠)
 * - A 指令不具体:节点对、能力对,但指令模糊致 executor 自由发挥偏了
 * - B 能力缺口:根本没有能干这件事的节点,之前靠现有节点硬顶
 * - C 上下文缺失/错误:节点对、指令对,但输入(blackboard/inputs)不对
 * - D 验收标准不合理:executor 没错,是 verifier 的 checks 定歪了
 * - E 目标/规划有问题:目标本身不清晰/矛盾,或规划方向错
 * - F 产物契约失败:artifact 缺失、为空、像过程日志/claim,或 scaffold 读错对象
 */
export type RootCauseType = "A_instruction_vague" | "B_capability_gap" | "C_context_error" | "D_standard_unreasonable" | "E_goal_problem" | "F_artifact_contract_failure";

export interface DiagnosisResult {
  root_cause: RootCauseType;
  explanation: string;
}

const DIAGNOSTICIAN_SYSTEM = `你是一个归因者(diagnostician)。你的职责是:当一个节点执行失败(verdict fail)后,判断失败的根因属于哪一类。

你只做归因,不做决策、不给修复建议、不决定下一步。你只输出根因分类和说明。

你必须用 JSON 返回:
{"root_cause": "根因类型", "explanation": "为什么判定为这个根因(具体说明)"}

根因类型(六选一,只能选一个主根因):

A_instruction_vague — 指令不具体
节点本身是对的、能力也是对的,但给执行者的指令不够具体,导致它自由发挥偏了。
典型:产出混入了不该有的内容(汇报体/元描述),因为指令没说清输出格式。
判断线索:executor 的产出方向大致对,但细节偏离了预期,而偏离的部分在指令里没明确要求。

B_capability_gap — 能力缺口
根本没有能干这件事的节点,之前是拿现有节点硬顶的。
典型:需要一个"修订"能力,但清单里只有"写新内容",用"写新内容"硬顶导致不对路。
判断线索:executor 产出的东西跟节点目标不匹配,不是细节偏了而是方向就不对;
或者目标需要的动作(如修订/转换/提取)在现有能力清单里找不到对应的。

C_context_error — 上下文缺失/错误
节点对、指令对,但喂给执行者的输入(blackboard/inputs)不对或缺失。
典型:写第三章需要前两章的人物状态,但上下文里没更新到。
判断线索:executor 的产出本身合理(按它拿到的输入看是对的),但输入缺了关键信息,
导致产出虽然"对"但不满足验收(因为验收假设了完整上下文)。

D_standard_unreasonable — 验收标准不合理
执行者没做错,是验收标准(checks)定歪了,拿不合理的标准挑错。
典型:checks 要求"每章必须有反转",但这一章是铺垫章,本不该有反转。
判断线索:executor 的产出在常识上看是合理的,但 verdict 的 fail 理由显得苛刻或不对路;
或者 checks 要求的东西跟节点目标/任务性质不匹配。

E_goal_problem — 目标/规划有问题
目标本身不清晰/矛盾,或规划方向根本错了。
典型:目标太模糊导致怎么做都不对,或规划的能力清单方向跑偏。
判断线索:多个节点反复失败,失败原因各不相同但都指向"目标/规划的根子"。

F_artifact_contract_failure — 产物契约失败
scaffold 收集到的 artifact 缺失、为空、太小、像过程日志/claim,或 verifier/engine 读错对象。
典型:executor 最终回复说“已完成”,但声明 outputs 没有真实正文;正式文件里全是“让我/现在/已完成”等过程自述。
判断线索:verdict.method=artifact_contract 或 failure_class=F_artifact_contract_failure;这是确定性事实层已经判定的失败,不要重新归为普通指令不具体。

规则:
- 只选一个主根因(最关键的那个),多个根因时选最重要的
- explanation 必须具体,引用 verdict 理由和产出的实际内容做依据
- 不要给修复建议(那是 scheduler 的事)
- 用中文`;

export interface DiagnosisInput {
  node: CapabilityNode;
  verdict: VerdictRecord;
  claim: string;
  artifact: string;
  instruction: string;
  blackboard: Record<string, unknown>;
  spec: GraphWorkflowSpec;
  failCount: number;
  previousDiagnoses: DiagnosisResult[];
}

export async function diagnoseFailure(
  client: LlmClient,
  input: DiagnosisInput,
): Promise<DiagnosisResult> {
  if (input.verdict.failure_class === "F_artifact_contract_failure" || input.verdict.method === "artifact_contract") {
    return {
      root_cause: "F_artifact_contract_failure",
      explanation: `artifact contract failed: ${input.verdict.reasons.join("; ")}`,
    };
  }

  const { node, verdict, claim, artifact, instruction, blackboard, spec, failCount, previousDiagnoses } = input;

  const capList = spec.capabilities.map(c => `- ${c.id} [${c.kind}]: ${c.desc}`).join("\n");
  const checksList = (node.checks ?? []).map(c => `- [${c.method}] ${c.desc}`).join("\n");
  const bbCtx = renderBlackboardForContext(blackboard, spec.blackboard_schema);
  const verdictReasons = verdict.reasons.join("; ");
  const prevDiag = previousDiagnoses.length > 0
    ? previousDiagnoses.map((d, i) => `  第${i+1}次归因: ${d.root_cause} — ${d.explanation}`).join("\n")
    : "(无,这是首次归因)";

  const userPrompt = [
    `## 任务信息`,
    `目标: ${spec.goal.clarified}`,
    `能力清单:`,
    capList,
    "",
    `## 失败的节点`,
    `节点: ${node.id} [${node.kind}]`,
    `节点描述: ${node.desc}`,
    `验收标准:`,
    checksList || "(无)",
    "",
    `## 给执行者的指令`,
    instruction.slice(0, 2000),
    "",
    `## 执行者原始产出(claim,带对话外壳)`,
    claim.slice(0, 1500) || "(空)",
    "",
    `## Artifact Snapshot / 机械事实层`,
    artifact.slice(0, 1500) || "(空)",
    "",
    `## 验证者判定(verdict)`,
    `判定: FAIL`,
    `理由: ${verdictReasons}`,
    "",
    `## 上下文(blackboard)`,
    bbCtx,
    "",
    `## 历史归因(本节点已失败 ${failCount} 次)`,
    prevDiag,
    "",
    `请判定本次失败的主根因。`,
  ].join("\n");

  const result = await client.completeJson<DiagnosisResult>("evaluator", DIAGNOSTICIAN_SYSTEM, userPrompt);
  return result;
}
