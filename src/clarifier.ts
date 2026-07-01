import type { ProjectState } from "./types.js";

export interface ClarificationEntry {
  q: string;
  a: string;
  risk: string;
}

export function nextClarificationQuestion(state: ProjectState): { question: string; risk: string } | null {
  const goal = state.project.goal;
  const status = state.status.clarifier;
  const answered = new Set((status?.clarifications ?? []).map((entry) => entry.q));

  const candidates = [
    {
      question: "这个自动化流程最终要交付调研方案,还是直接落地实现?",
      risk: "不澄清交付类型,后续 agent roster、验收标准和 executor 选择都可能偏掉。",
    },
    {
      question: "这个流程覆盖哪些范围,明确不覆盖哪些范围?",
      risk: "不澄清范围边界,方案容易膨胀,也容易漏掉你真正关心的部分。",
    },
    {
      question: "你已有的数据源、资料、账号或外部约束是什么?",
      risk: "不澄清输入来源,调研会假设错误的数据条件,实现阶段可能返工。",
    },
    {
      question: "什么样的方案算通过?请给出最重要的验收标准。",
      risk: "不澄清验收标准,verifier 只能按默认 rubric 判断,可能和你的真实判断标准不一致。",
    },
  ];

  if (goal.length > 40 && candidates.length > 0 && !status) return candidates[0] ?? null;
  return candidates.find((candidate) => !answered.has(candidate.question)) ?? null;
}

export function appendClarification(state: ProjectState, answer: string): ProjectState {
  const next = nextClarificationQuestion(state);
  if (!next) return state;

  state.status.clarifier = {
    status: "clarifying",
    clarifications: [...(state.status.clarifier?.clarifications ?? []), { q: next.question, a: answer, risk: next.risk }],
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
