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
{"dimension": "维度标签(2-6字)", "question": "你的问题", "risk": "如果不澄清这个点,可能造成的具体后果"}

维度标签规则(关键!):
- dimension 是这个问题所属维度的短标签,如"案件类型""篇幅""结局""主角身份""风格基调""约束"
- 已澄清记录里出现过的 dimension **绝对不能再出现**——即使你的问题换了说法,只要维度相同就不行
- 例如:#1 的 dimension 是"案件类型",你就不能再问任何关于案件/谜题是什么类型的问题,即使换角度(密室还是连环/具体是什么案子)都属于"案件类型"维度

问题规则:
- 一次只提一个问题,针对用户的具体目标,不要通用
- 必须是已澄清维度之外的新维度
- risk 必须具体
- 如果所有关键维度都有答案(哪怕粗略),返回 {"done": true}
- 已澄清轮数达到 7,强制 done
- 用中文`;

export async function nextClarificationQuestion(state: ProjectState, client: LlmClient): Promise<NextQuestion | null> {
  const userPrompt = buildUserPrompt(state);
  const existingDims = (state.status.clarifier?.clarifications ?? []).map(e => e.risk?.match(/\[(.+?)\]/)?.[1] ?? "").filter(Boolean);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.completeJson<{ dimension?: string; question?: string; risk?: string; done?: boolean }>("composer", SYSTEM_PROMPT, userPrompt);
    if (result.done) return null;
    if (!result.question || !result.risk || !result.dimension) return null;
    const dim = result.dimension.trim();
    const existing = state.status.clarifier?.clarifications ?? [];
    // 两道硬约束:dimension 重复 OR 问题文字相似,都算重复
    const dimDup = existingDims.some(d => d === dim || similarDim(d, dim));
    const textDup = isSimilarQuestion(result.question, existing.map(e => e.q));
    if (dimDup || textDup) {
      if (attempt < 2) continue;
      return null;
    }
    // 把 dimension 标进 risk 字段前面(存下来供后续去重)
    return { question: result.question, risk: `[${dim}] ${result.risk}` };
  }
  return null;
}

/** 维度相似度:完全相同 或 包含关系 */
function similarDim(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

/** 简单相似度检测:关键词重合(备用,dimension 去重的补充) */
function isSimilarQuestion(newQ: string, existingQs: string[]): boolean {
  const newKeys = extractKeywords(newQ);
  if (newKeys.length === 0) return false;
  for (const oldQ of existingQs) {
    const oldKeys = extractKeywords(oldQ);
    const overlap = newKeys.filter(k => oldKeys.includes(k));
    const ratio = overlap.length / Math.min(newKeys.length, oldKeys.length);
    if (ratio >= 0.4) return true;
  }
  return false;
}

function extractKeywords(q: string): string[] {
  const STOP = ["什么","怎么","如何","还是","比如","以下","以上","请","的","是","什么类型","具体","大概","多少","哪种","哪些","一个","这部","这部小说","这部悬疑"];
  const chunks = q.match(/[\u4e00-\u9fa5]{2,}/g) ?? [];
  const keys: string[] = [];
  for (const c of chunks) {
    if (STOP.some(s => c === s || (c.length >= 3 && c.includes(s)))) continue;
    if (c.length >= 2) keys.push(c);
  }
  return [...new Set(keys)];
}

export function appendClarification(state: ProjectState, answer: string, next: NextQuestion | null): ProjectState {
  const previous = state.status.clarifier?.clarifications ?? [];
  // q 应该是"当前问的问题",不是项目目标;第一次回答时从 current_question 取
  const lastQuestion = state.status.clarifier?.current_question?.question
    ?? (previous.length > 0 ? previous[previous.length - 1]?.q : "");

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
    lines.push("【已澄清维度(dimension 标签已占用,绝对不能再出现这些维度)】:");
    for (let i = 0; i < clarifications.length; i++) {
      const e = clarifications[i];
      const dim = e.risk?.match(/\[(.+?)\]/)?.[1] ?? "未知";
      lines.push(`  #${i+1} [${dim}] ${e.q.slice(0, 30)} → 已答: ${e.a}`);
    }
    lines.push("");
    lines.push(`已占用的 dimension: ${clarifications.map(e => e.risk?.match(/\[(.+?)\]/)?.[1] ?? "").filter(Boolean).join(", ")}`);
    lines.push("下一个问题的 dimension 必须不在上面列表里。");
  } else {
    lines.push("尚未澄清任何问题。");
  }
  lines.push("");
  lines.push(`已澄清轮数: ${clarifications.length}(软上限 7,到顶强制 done)`);
  lines.push("");
  lines.push("常见维度参考(选一个还没用过的):目标产出/范围边界/验收标准/约束/任务性质/风格基调");
  lines.push("");
  lines.push("请判断:维度都有答案则 done,否则提一个新维度的问题(带新 dimension)。");
  return lines.join("\n");
}
