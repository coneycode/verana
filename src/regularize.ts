import type { LlmClient } from "./llm.js";

/**
 * 规整层:把 executor 的原始产出(claim,带对话外壳)清洗成纯净交付物(deliverable)。
 * 只清形式(去对话外壳/提取正文),不改实质内容。
 * 用轻 LLM(evaluator 角色),比重跑 hermes 便宜得多。
 */

const REGULARIZE_SYSTEM = `你是一个产出规整器。你的任务是把 agent 的原始输出清洗成纯净的交付物。

规则:
- 去掉对话外壳:如"好的""以下是""完成了""以上是内容""来源说明"等开头/结尾的套话
- 去掉元描述:如"我做了X""字数约N""文风对照""伏笔编号"等自述性/汇报性文字
- 保留实质内容:正文、代码、调研结果等真正的交付物
- 不改实质内容:不重写、不补充、不删减正文本身,只去外壳
- 如果产出本身就是纯净的(没有外壳),原样返回
- 用中文(除非产出本身是其他语言)

返回 JSON: {"deliverable": "清洗后的纯净产出", "cleaned": true/false}
cleaned=true 表示做了清洗,false 表示本来就干净原样返回。`;

export async function regularizeClaim(
  client: LlmClient,
  claim: string,
  nodeDesc: string,
): Promise<string> {
  if (!claim || claim.trim().length === 0) return claim;

  const userPrompt = [
    `节点描述: ${nodeDesc}`,
    "",
    `Agent 原始输出:`,
    claim.slice(0, 4000),
  ].join("\n");

  try {
    const result = await client.completeJson<{ deliverable: string; cleaned: boolean }>(
      "evaluator", REGULARIZE_SYSTEM, userPrompt,
    );
    return result.deliverable || claim;
  } catch {
    // 规整失败时,降级用原始 claim(不阻塞流程)
    return claim;
  }
}
