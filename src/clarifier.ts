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

规则:
- 一次只提一个问题,针对用户的具体目标,不要通用
- risk 必须具体
- 如果所有关键维度都有答案(哪怕粗略),返回 {"done": true}
- 已澄清轮数达到 7,强制 done
- 用中文

**最重要规则 — 严禁重复**:
在生成新问题前,你必须先检查:新问题的"核心意图"是否跟下方"已澄清记录"里任何一个问题相同。
- "核心意图相同"= 两个问题虽然措辞不同,但在问同一件事。例如"自研还是采购"和"是为了自研搭建、选型采购还是了解市场"是同一意图(都是问调研目的)
- 如果核心意图跟任何已有问题相同,你不能提这个问题——要么返回 done,要么换一个完全不同的维度问
- dimension 标签不同但意图相同,也算重复`;

export async function nextClarificationQuestion(state: ProjectState, client: LlmClient): Promise<NextQuestion | null> {
  const existingQs = (state.status.clarifier?.clarifications ?? []).map(e => e.q);
  // 当前正在问的问题也要加入对比(它还没被 append,但已经问过了)
  const currentQ = state.status.clarifier?.current_question?.question;
  if (currentQ) existingQs.push(currentQ);
  let lastRejectedQ = "";
  let lastRejectReason = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const userPrompt = buildUserPrompt(state) + (lastRejectedQ ? `\n\n【反馈】你上次返回的问题被判定为重复(${lastRejectReason}),请换一个完全不同的维度。` : "");
    const result = await client.completeJson<{ dimension?: string; question?: string; risk?: string; done?: boolean }>("composer", SYSTEM_PROMPT, userPrompt);
    if (result.done) return null;
    if (!result.question || !result.risk || !result.dimension) return null;

    // 代码级硬约束:检测跟已有问题的核心选项词重合
    if (existingQs.length > 0) {
      const newOptions = extractOptionWords(result.question);
      if (newOptions.length >= 2) {
        for (const oldQ of existingQs) {
          const oldOptions = extractOptionWords(oldQ);
          if (oldOptions.length >= 2) {
            const overlap = newOptions.filter(o => oldOptions.includes(o));
            if (overlap.length >= 2) {
              lastRejectedQ = result.question;
              lastRejectReason = `跟已有问题共享选项词: ${overlap.join(",")}`;
              if (attempt < 2) { continue; }
              return null;
            }
          }
        }
      }
    }

    const dim = result.dimension.trim();
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

/** 从问题里提取核心选项词(用于检测重复意图)
 * 中文澄清问题通常是"是A、B还是C"的形式,A/B/C 就是选项词
 * 提取策略:找"是""还是"分隔的短词,以及常见选项关键词
 */
function extractOptionWords(q: string): string[] {
  const options: string[] = [];
  // 常见选项关键词词典(调研/创作类常见)
  const KNOWN = ["自研","自建","搭建","采购","选购","选型","现成","第三方","了解","市场","竞品","方案",
    "粉丝","互动","内容","带货","转化","舆情","报警","实时","批量","规模","量级","几十","上百","上千",
    "对比","报告","清单","推荐","评估","文档",
    "中文","英文","界面","语言",
    "月费","预算","价格","免费","付费",
    "小说","调研","代码","报告","方案",
    "凶杀","失踪","密室","悬疑","心理","超自然",
    "一次性","迭代","循环","多轮",
  ];
  for (const w of KNOWN) {
    if (q.includes(w)) options.push(w);
  }
  return [...new Set(options)];
}

/** 简单相似度检测:关键词重合(备用,dimension 去重的补充) */
function isSimilarQuestion(newQ: string, existingQs: string[], goalWords?: string[]): boolean {
  const newKeys = extractKeywords(newQ).filter(k => !goalWords?.includes(k));
  if (newKeys.length === 0) return false;
  for (const oldQ of existingQs) {
    const oldKeys = extractKeywords(oldQ).filter(k => !goalWords?.includes(k));
    if (oldKeys.length === 0) continue;
    const overlap = newKeys.filter(k => oldKeys.includes(k));
    const ratio = overlap.length / Math.min(newKeys.length, oldKeys.length);
    if (ratio >= 0.35) return true;
  }
  return false;
}

function extractKeywords(q: string): string[] {
  // 只过滤纯功能词,保留实义词
  const STOP = new Set(["什么","怎么","如何","还是","比如","以下","以上","请","的","是","具体","大概","多少","哪种","哪些","一个","这次","这套","那","你","希望","需要","核心","目的","最终","为了","只是","了解","什么类型","或者","又或","以及","和","或","到","在","有","无","不","就","都","也","很","最","更","一个","这个","那个","可以","应该","可能","如","等","了","吗","呢","吧","啊","呀"]);
  // 用 2-4 字滑动窗口切词,而非整段连续中文
  const chunks = q.match(/[\u4e00-\u9fa5]+/g) ?? [];
  const keys = [];
  for (const chunk of chunks) {
    // 滑动窗口:提取所有 2-4 字子串
    for (let len = 2; len <= 4 && len <= chunk.length; len++) {
      for (let i = 0; i <= chunk.length - len; i++) {
        const w = chunk.slice(i, i + len);
        if (!STOP.has(w) && w.length >= 2) keys.push(w);
      }
    }
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
    lines.push("【已澄清记录 — 检查你的新问题是否跟下面任何一个的核心意图重复】:");
    for (let i = 0; i < clarifications.length; i++) {
      const e = clarifications[i];
      lines.push(`  #${i+1} 问题: ${e.q}`);
      lines.push(`       回答: ${e.a}`);
    }
    lines.push("");
    lines.push("生成新问题前先自检:新问题跟上面任何一个的核心意图是否相同?");
    lines.push("如果相同 → 返回 done 或换一个完全不同的维度。");
    lines.push("如果不同 → 提出新问题(带新 dimension)。");
  } else {
    lines.push("尚未澄清任何问题。");
  }
  lines.push("");
  lines.push(`已澄清轮数: ${clarifications.length}(软上限 7,到顶强制 done)`);
  lines.push("常见维度参考:目标产出/范围边界/验收标准/约束/任务性质/风格基调");
  return lines.join("\n");
}
