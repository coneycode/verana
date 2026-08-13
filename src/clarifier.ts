import type { LlmClient } from "./llm.js";
import type { ProjectState, ClarifierRecord } from "./types.js";

const CLARIFY_CHAT_SYSTEM = `你是一个方案澄清助手。根据用户目标和已有对话，生成下一个澄清问题或判定信息足够。

用标记格式返回(不要用JSON):

[QUESTION]
问题内容
[/QUESTION]

或

[DONE]
[话题1] 结论1
[话题2] 结论2
[/DONE]

规则:
- 一次只问一个问题
- 问题要基于已有对话上下文，不重复已问过的
- 如果用户回答模糊，追问具体细节
- 必须覆盖关键维度: 任务性质(做什么)/最终产出(文档/代码/数据)/范围边界/验收标准/约束条件
- 特别注意:如果目标含"实现""流程""代码"等词但没明确最终产出是文档还是代码，必须问清楚
- 覆够关键维度后判定 done: 任务性质/产出形式/范围边界/验收标准/约束条件
- done 时必须返回 conclusions: 每个话题一行,格式 [话题] 结论(一句话)
- 用中文，口语化，像人对话一样自然`;

/** 兼容：旧 clarifications 格式转 messages */
export function migrateClarifier(clarifier: Partial<ClarifierRecord> | undefined): ClarifierRecord {
  if (!clarifier) {
    return { status: "clarifying", messages: [] };
  }
  if (clarifier.messages && clarifier.messages.length > 0) {
    return clarifier as ClarifierRecord;
  }
  // 旧格式转换
  const messages: Array<{ role: "assistant" | "user"; content: string }> = [];
  for (const e of clarifier.clarifications ?? []) {
    messages.push({ role: "assistant", content: e.q });
    messages.push({ role: "user", content: e.a });
  }
  return { status: clarifier.status ?? "clarifying", messages, conclusions: clarifier.conclusions };
}

/** 对话式澄清：生成下一个问题或判定 done（流式，逐 token 回调） */
export async function clarifyChatStream(
  state: ProjectState,
  client: LlmClient,
  onDelta?: (delta: string) => void,
): Promise<
  | { type: "question"; content: string }
  | { type: "done"; conclusions: Array<{ topic: string; conclusion: string }> }
> {
  const goal = state.project.goal;
  const clarifier = migrateClarifier(state.status.clarifier);
  const messages = clarifier.messages;

  const dialogueText = messages.length > 0
    ? messages.map(m => `${m.role === "assistant" ? "系统" : "用户"}: ${m.content}`).join("\n")
    : "(无)";
  const userPrompt = `目标: ${goal}\n\n对话历史:\n${dialogueText}\n\n请生成下一个问题或判定信息足够。`;

  const raw = await client.complete("composer", CLARIFY_CHAT_SYSTEM, userPrompt, onDelta);

  return parseClarifyResponse(raw);
}

/** 解析标记格式响应 */
export function parseClarifyResponse(raw: string):
  | { type: "question"; content: string }
  | { type: "done"; conclusions: Array<{ topic: string; conclusion: string }> } {
  // [QUESTION]...[/QUESTION]
  const qMatch = raw.match(/\[QUESTION\]([\s\S]*?)\[\/QUESTION\]/);
  if (qMatch) {
    return { type: "question", content: qMatch[1].trim() };
  }
  // [DONE]...[/DONE]
  const dMatch = raw.match(/\[DONE\]([\s\S]*?)\[\/DONE\]/);
  if (dMatch) {
    const lines = dMatch[1].trim().split("\n").map(l => l.trim()).filter(Boolean);
    const conclusions: Array<{ topic: string; conclusion: string }> = [];
    for (const line of lines) {
      const m = line.match(/^\[([^\]]+)\]\s*(.+)/);
      if (m) conclusions.push({ topic: m[1].trim(), conclusion: m[2].trim() });
    }
    if (conclusions.length > 0) return { type: "done", conclusions };
  }
  // 兜底：没有标记，当 question 处理
  return { type: "question", content: raw.trim() };
}

/** 对话式澄清：生成下一个问题或判定 done（非流式，兼容旧调用） */
export async function clarifyChat(state: ProjectState, client: LlmClient): Promise<
  | { type: "question"; topic: string; content: string }
  | { type: "done"; conclusions: Array<{ topic: string; conclusion: string }> }
> {
  const result = await clarifyChatStream(state, client);
  if (result.type === "question") {
    return { type: "question", topic: "通用", content: result.content };
  }
  return result;
}

/** 从 conclusions 生成目标总结（给 Composer 用） */
export function buildGoalSummary(state: ProjectState): string {
  const clarifier = migrateClarifier(state.status.clarifier);
  const conclusions = clarifier.conclusions ?? [];
  const lines = ["# Goal Confirmation", "", `Raw goal: ${state.project.goal}`, "", "## Clarified Conclusions", ""];
  if (conclusions.length > 0) {
    for (const c of conclusions) {
      lines.push(`- [${c.topic}] ${c.conclusion}`);
    }
  } else {
    // 兜底：从 messages 提取问答
    for (let i = 0; i < clarifier.messages.length; i += 2) {
      const q = clarifier.messages[i]?.content ?? "";
      const a = clarifier.messages[i + 1]?.content ?? "";
      lines.push(`- Q: ${q}`);
      lines.push(`  A: ${a}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
