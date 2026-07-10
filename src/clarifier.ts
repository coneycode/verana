import type { LlmClient } from "./llm.js";
import type { ProjectState } from "./types.js";

export interface ClarificationEntry {
  q: string;
  a: string;
  risk: string;
}

export interface ClarifyBatch {
  questions: Array<{ question: string; risk: string; dimension: string }>;
}

const BATCH_SYSTEM = `你是一个方案澄清助手。根据用户的目标,一次性生成所有需要澄清的关键问题(3-7个)。

你必须用 JSON 返回:
{"questions": [{"dimension": "维度标签(2-6字)", "question": "问题", "risk": "不澄清的后果"}]}

规则:
- 一次性生成 3-7 个问题,覆盖不同维度(不要重复维度)
- 每个问题针对用户的具体目标,不要通用问题
- 维度参考:任务性质/目标产出/范围边界/验收标准/约束条件/风格基调/交付形式
- risk 必须具体
- 用中文

**严禁重复**:
- 生成后自检:所有问题的核心意图是否两两不同
- "自研还是采购"和"是为了自研搭建还是选型"是同一意图,不能都出现
- dimension 标签不同但意图相同,也算重复,只保留一个`;

const REVIEW_SYSTEM = `你是一个澄清审核者。用户已经回答了一批澄清问题。判断是否还需要追问。

你必须用 JSON 返回:
{"need_followup": true/false, "followup_questions": [{"dimension":"维度","question":"追问","risk":"不追问的后果"}]}

规则:
- need_followup=false:问答已覆盖关键维度,信息够开始规划
- need_followup=true:有重要遗漏或矛盾,需要追问
- followup_questions 最多 3 个,只问真正缺失的关键信息
- 不要重复已有问答的维度
- 用中文`;

/** 一次性生成全部澄清问题 */
export async function generateClarifyBatch(state: ProjectState, client: LlmClient): Promise<ClarifyBatch> {
  const goal = state.project.goal;
  const existingQs = (state.status.clarifier?.clarifications ?? []).map(e => e.q);

  const userPrompt = `目标: ${goal}\n\n${existingQs.length > 0 ? '已澄清的问题(不要重复这些维度):\n' + existingQs.map((q, i) => `  ${i+1}. ${q}`).join('\n') : '尚未澄清任何问题。'}\n\n请一次性生成所有需要澄清的关键问题。`;
  const result = await client.completeJson<{ questions?: Array<{ dimension?: string; question?: string; risk?: string }> }>("composer", BATCH_SYSTEM, userPrompt);

  const raw = result.questions ?? [];
  // 代码级去重:dimension + 选项词双重检测
  const deduped: Array<{ question: string; risk: string; dimension: string }> = [];
  const seenDims: string[] = [];
  for (const q of raw) {
    const questionStr = q.question;
    const riskStr = q.risk;
    const dimStr = q.dimension;
    if (!questionStr || !riskStr || !dimStr) continue;
    const dim = dimStr.trim();
    if (seenDims.some(d => d === dim || similarDim(d, dim))) continue;
    if (deduped.some(existing => isOptionOverlap(existing.question, questionStr))) continue;
    deduped.push({ question: questionStr, risk: riskStr, dimension: dim });
    seenDims.push(dim);
  }
  return { questions: deduped };
}

/** 二次校验:看问答是否需要追问 */
export async function reviewClarifications(state: ProjectState, client: LlmClient): Promise<{ needFollowup: boolean; questions: Array<{ question: string; risk: string; dimension: string }> }> {
  const goal = state.project.goal;
  const entries = state.status.clarifier?.clarifications ?? [];

  const qaText = entries.map((e, i) => `Q${i+1}: ${e.q}\nA${i+1}: ${e.a}`).join('\n\n');
  const userPrompt = `目标: ${goal}\n\n已澄清问答:\n${qaText}\n\n判断是否还需要追问(补充缺失的关键维度)。`;

  const result = await client.completeJson<{ need_followup?: boolean; followup_questions?: Array<{ dimension?: string; question?: string; risk?: string }> }>("evaluator", REVIEW_SYSTEM, userPrompt);

  if (!result.need_followup) return { needFollowup: false, questions: [] };

  const questions: Array<{ question: string; risk: string; dimension: string }> = [];
  for (const q of (result.followup_questions ?? [])) {
    const qStr = q.question; const rStr = q.risk; const dStr = q.dimension;
    if (!qStr || !rStr || !dStr) continue;
    if (entries.some(e => isOptionOverlap(e.q, qStr))) continue;
    questions.push({ question: qStr, risk: rStr, dimension: dStr.trim() });
  }
  return { needFollowup: questions.length > 0, questions };
}

/** 维度相似度:完全相同或包含 */
function similarDim(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true;
  return false;
}

/** 选项词重合检测(两个问题共享>=2个核心选项词=重复) */
function isOptionOverlap(q1: string, q2: string): boolean {
  const o1 = extractOptionWords(q1);
  const o2 = extractOptionWords(q2);
  if (o1.length < 2 || o2.length < 2) return false;
  const overlap = o1.filter(o => o2.includes(o));
  return overlap.length >= 2;
}

function extractOptionWords(q: string): string[] {
  const KNOWN = ["自研","自建","搭建","采购","选购","选型","现成","第三方","了解","市场","竞品","方案",
    "粉丝","互动","内容","带货","转化","舆情","报警","实时","批量","规模","量级","几十","上百","上千",
    "对比","报告","清单","推荐","评估","文档",
    "中文","英文","界面","语言",
    "月费","预算","价格","免费","付费",
    "小说","调研","代码","报告","方案",
    "凶杀","失踪","密室","悬疑","心理","超自然",
    "一次性","迭代","循环","多轮",
  ];
  const options: string[] = [];
  for (const w of KNOWN) { if (q.includes(w)) options.push(w); }
  return [...new Set(options)];
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
