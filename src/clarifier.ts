import type { LlmClient } from "./llm.js";
import type { ProjectState, ClarifierRecord } from "./types.js";

const CLARIFY_CHAT_SYSTEM = `你是一个方案澄清助手。根据用户目标和已有对话，生成下一个澄清问题或判定信息足够。

返回 JSON:
{ "action": "ask", "topic": "话题标签(2-6字)", "question": "问题", "reason": "为什么问这个" }
或
{ "action": "done", "conclusions": [{ "topic": "话题", "conclusion": "该话题的最终澄清结论(一句话)" }] }

规则:
- 一次只问一个问题
- 问题要基于已有对话上下文，不重复已问过的
- 如果用户回答模糊，追问具体细节
- 覆够关键维度后判定 done: 任务性质/产出形式/范围边界/验收标准/约束条件
- done 时必须返回 conclusions: 每个已澄清话题提炼一个结论(一句话)
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

/** 对话式澄清：生成下一个问题或判定 done */
export async function clarifyChat(state: ProjectState, client: LlmClient): Promise<
  | { type: "question"; topic: string; content: string }
  | { type: "done"; conclusions: Array<{ topic: string; conclusion: string }> }
> {
  const goal = state.project.goal;
  const clarifier = migrateClarifier(state.status.clarifier);
  const messages = clarifier.messages;

  const dialogueText = messages.length > 0
    ? messages.map(m => `${m.role === "assistant" ? "系统" : "用户"}: ${m.content}`).join("\n")
    : "(无)";
  const userPrompt = `目标: ${goal}\n\n对话历史:\n${dialogueText}\n\n请生成下一个问题或判定信息足够。`;

  const result = await client.completeJson<{
    action?: string;
    topic?: string;
    question?: string;
    reason?: string;
    conclusions?: Array<{ topic?: string; conclusion?: string }>;
  }>("composer", CLARIFY_CHAT_SYSTEM, userPrompt);

  if (result.action === "done" && result.conclusions?.length) {
    const conclusions = result.conclusions
      .filter(c => c.topic && c.conclusion)
      .map(c => ({ topic: c.topic!, conclusion: c.conclusion! }));
    if (conclusions.length > 0) {
      return { type: "done", conclusions };
    }
  }

  return {
    type: "question",
    topic: result.topic ?? "通用",
    content: result.question ?? "请补充更多信息。",
  };
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
