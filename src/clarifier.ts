import type { LlmClient } from "./llm.js";
import type { ProjectState } from "./types.js";

export interface ClarificationEntry {
  q: string;
  a: string;
  risk: string;
}

export interface NextQuestion {
  question: string;
  risk: string;
}

const SYSTEM_PROMPT = `你是一个方案澄清助手。你的任务是根据用户的目标,判断还需要澄清什么,然后一次只提一个最关键的问题。

你必须用 JSON 返回,格式:
{"question": "你的问题", "risk": "如果不澄清这个点,可能造成的具体后果"}

规则:
- 一次只提一个问题
- 问题必须针对用户的具体目标,不要问通用问题
- risk 必须具体,说明不澄清会导致什么实际后果
- **不要问已经在"已澄清记录"里出现过的问题或高度相似的问题**——每次提问前检查下方列表,避开已覆盖的维度
- 如果目标已经足够清晰(关键维度都有信息),返回 {"done": true}
- 用中文回答`;

export async function nextClarificationQuestion(state: ProjectState, client: LlmClient): Promise<NextQuestion | null> {
  const userPrompt = buildUserPrompt(state);
  const result = await client.completeJson<{ question?: string; risk?: string; done?: boolean }>("composer", SYSTEM_PROMPT, userPrompt);
  if (result.done) return null;
  if (!result.question || !result.risk) return null;
  return { question: result.question, risk: result.risk };
}

export function appendClarification(state: ProjectState, answer: string, next: NextQuestion | null): ProjectState {
  const previous = state.status.clarifier?.clarifications ?? [];
  const lastQuestion = previous.length > 0 ? previous[previous.length - 1]?.q : state.project.goal;

  state.status.clarifier = {
    status: "clarifying",
    clarifications: [...previous, { q: lastQuestion, a: answer, risk: next?.risk ?? "已回答" }],
  };
  return state;
}

export function buildGoalSummary(state: ProjectState): string {
  const lines = ["# Goal Confirmation", "", `Raw goal: ${state.project.goal}`, "", "## Clarifications", ""];
  for (const entry of state.status.clarifier?.clarifications ?? []) {
    lines.push(`- Q: ${entry.q}`);
    lines.push(`  A: ${entry.a}`);
    lines.push(`  Risk if unclear: ${entry.risk}`);
  }
  return `${lines.join("\n")}\n`;
}

function buildUserPrompt(state: ProjectState): string {
  const clarifications = state.status.clarifier?.clarifications ?? [];
  const lines = [`目标: ${state.project.goal}`, ""];
  if (clarifications.length > 0) {
    lines.push("已澄清记录(不要重复问这些方向):");
    for (const entry of clarifications) {
      lines.push(`  - Q: ${entry.q}`);
      lines.push(`    A: ${entry.a}`);
    }
  } else {
    lines.push("尚未澄清任何问题。");
  }
  lines.push("");
  lines.push(`已澄清轮数: ${clarifications.length}(软上限 7)`);
  lines.push("请判断下一步:如果目标已足够清晰返回 done=true,否则提出一个**与已澄清记录不重复**的最关键待澄清问题。");
  return lines.join("\n");
}
