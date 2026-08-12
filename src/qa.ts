import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LlmClient } from "./llm.js";
import type { ProjectState } from "./types.js";

interface FileContent {
  name: string;
  content: string;
}

const QA_CHAT_SYSTEM = `你是一个文档问答助手。根据提供的检索上下文和对话历史，回答用户关于项目交付物的问题。

规则:
- 只基于提供的检索上下文回答，不要编造信息
- 如果上下文里没有相关信息，说"根据现有资料，没有找到相关信息"
- 引用数据时标注来源文件
- 用中文回答`;

/** 读取项目所有交付物文件 */
async function loadDeliverableFiles(projectDir: string): Promise<FileContent[]> {
  const files: FileContent[] = [];
  const solutionDir = join(projectDir, "solution");
  const evidenceDir = join(solutionDir, "evidence");
  
  // 读 evidence 目录
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(evidenceDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = await readFile(join(evidenceDir, entry), "utf-8");
        files.push({ name: `evidence/${entry}`, content });
      } catch { /* skip */ }
    }
  } catch { /* no evidence dir */ }
  
  // 读 solution 目录下的 .md 文件（report, review_notes 等）
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(solutionDir);
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      try {
        const content = await readFile(join(solutionDir, entry), "utf-8");
        const name = entry.replace(/\.md$/, "");
        // 避免重复 evidence 文件
        if (!files.find(f => f.name === `evidence/${entry}`)) {
          files.push({ name, content });
        }
      } catch { /* skip */ }
    }
  } catch { /* no solution dir */ }
  
  return files;
}

/** 转义正则特殊字符 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 关键词检索：从所有文件中找出与问题最相关的 top 3 */
function retrieveRelevantFiles(question: string, files: FileContent[]): FileContent[] {
  const stopWords = new Set([
    "的", "是", "了", "在", "和", "与", "或", "也", "都", "这", "那",
    "什么", "怎么", "哪个", "哪些", "多少", "请", "帮", "一下",
    "我", "你", "他", "它", "有", "没有", "不", "没",
    "可以", "能", "会", "吧", "呢", "啊", "吗", "问", "告诉",
    "关于", "对于", "根据", "目前", "现在", "最新", "最近",
  ]);
  
  // 提取关键词：按非字母数字汉字分割
  const keywords = question
    .replace(/[，。？！、\s,.\?]+/g, " ")
    .split(" ")
    .map(w => w.trim())
    .filter(w => w.length >= 2 && !stopWords.has(w));
  
  if (keywords.length === 0) return files.slice(0, 3);
  
  // 计算每个文件的命中次数
  const scored = files.map(f => {
    let score = 0;
    for (const kw of keywords) {
      const count = (f.content.match(new RegExp(escapeRegex(kw), "gi")) || []).length;
      score += count;
    }
    return { ...f, score };
  });
  
  scored.sort((a, b) => b.score - a.score);
  const withScore = scored.filter(f => f.score > 0);
  return (withScore.length > 0 ? withScore : scored).slice(0, 3);
}

/** 从文件内容中截取包含关键词的段落 */
function extractRelevantPassages(question: string, files: FileContent[], maxChars = 2000): string {
  const stopWords = new Set(["的", "是", "了", "在", "和", "与", "或", "也", "都", "这", "那", "什么", "怎么", "哪个", "哪些", "多少", "请", "帮", "一下", "我", "你", "他", "它", "有", "没有", "不", "没", "可以", "能", "会", "吧", "呢", "啊", "吗"]);
  const keywords = question.replace(/[，。？！、\s,.\?]+/g, " ").split(" ").map(w => w.trim()).filter(w => w.length >= 2 && !stopWords.has(w));
  
  if (keywords.length === 0) {
    // 无关键词，取每个文件前 maxChars/3 字符
    const perFile = Math.floor(maxChars / files.length);
    return files.map(f => `--- ${f.name} ---\n${f.content.slice(0, perFile)}`).join("\n\n");
  }
  
  const passages: string[] = [];
  const perFile = Math.floor(maxChars / files.length);
  for (const f of files) {
    // 找第一个命中关键词的位置，截取周围文本
    let startPos = 0;
    for (const kw of keywords) {
      const idx = f.content.indexOf(kw);
      if (idx >= 0) { startPos = Math.max(0, idx - 200); break; }
    }
    const passage = f.content.slice(startPos, startPos + perFile);
    passages.push(`--- ${f.name} ---\n${passage}`);
  }
  return passages.join("\n\n");
}

/** 问答主函数 */
export async function qaChat(
  state: ProjectState,
  projectDir: string,
  question: string,
  client: LlmClient,
): Promise<{ answer: string; sources: string[] }> {
  // 1. 读取所有交付物文件
  const files = await loadDeliverableFiles(projectDir);
  if (files.length === 0) {
    return { answer: "没有找到交付物文件。", sources: [] };
  }
  
  // 2. 关键词检索
  const relevant = retrieveRelevantFiles(question, files);
  const sources = relevant.map(f => f.name);
  
  // 3. 截取相关段落
  const context = extractRelevantPassages(question, relevant);
  
  // 4. 组装 prompt
  const qaMessages = state.status.qa_messages ?? [];
  const historyText = qaMessages.length > 0
    ? qaMessages.slice(-6).map(m => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`).join("\n")
    : "(无)";
  
  const userPrompt = `检索上下文(从交付物文件中提取的相关内容):
${context}

对话历史:
${historyText}

用户问题: ${question}

请回答。`;
  
  // 5. 调 LLM
  const result = await client.complete("composer", QA_CHAT_SYSTEM, userPrompt);
  
  return { answer: result, sources };
}
