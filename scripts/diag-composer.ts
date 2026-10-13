/**
 * 诊断脚本:复现 Composer "empty content" 问题
 * 用与 src/llm.ts 完全相同的请求体直接调网关,dump 完整原始响应(含 stop_reason / block 类型)。
 * 用法: npx tsx scripts/diag-composer.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const cfg = parse(readFileSync("verana.config.yaml", "utf8"));
const composer = cfg.composer;

// --- 真实项目数据(2026-09-23-豆包爱学产品调研) ---
const GOAL = "调研豆包爱学的近期动态，产品形态、产品目标等信息；我需要对这个产品做个全面的了解；";
const CONCLUSIONS = [
  { topic: "任务性质", conclusion: "对豆包爱学做竞品分析，全面了解这款产品" },
  { topic: "最终产出", conclusion: "不需要正式文档，自己心里有全面的了解即可" },
  { topic: "调研范围", conclusion: "产品定位、目标用户、产品形态、核心功能、商业模式等方面全面覆盖" },
  { topic: "时间范围", conclusion: "重点梳理最近半年的动态，包括更新、改版、重要功能上线等大动作" },
  { topic: "信息来源", conclusion: "公开资料(官方公告、媒体报道、应用商店信息)加亲自下载体验核心功能相结合" },
  { topic: "验收标准", conclusion: "达到竞品分析所需的认知深度，各方面都过一遍并形成对产品的完整印象" },
];

// --- 从 pipeline.ts 源码原样提取 COMPOSER_SYSTEM_BASE(避免两份拷贝漂移) ---
const src = readFileSync("src/pipeline.ts", "utf8");
const m = src.match(/const COMPOSER_SYSTEM_BASE = `([\s\S]*?)`;/);
if (!m) throw new Error("COMPOSER_SYSTEM_BASE not found in pipeline.ts");
const COMPOSER_SYSTEM_BASE = m[1];

// --- buildComposerPrompt 的复刻(pipeline.ts L260-279) ---
const TASK_TYPE = "research";
const chain = "plan_outline(light) → search(×N instances, 按维度拆分) → write_evidence(×N instances, 按维度拆分) → synthesize(agent) → polish_report(agent) → review_report(agent)";
const guidance = "调研型任务。先规划大纲(含每个维度的调研方向)。search 节点边搜边写原始结果到 solution/search/{instance}.md(搜到一条写一条,每条标注来源,不要求结构化)。write_evidence 从 search 文件整理成 solution/evidence/{instance}.md(只整理不搜索)。synthesize 从所有 evidence 综合成完整报告。有 instances 的 output path 必须含 {instance} 占位符。search 和 write_evidence 的 instances 清单一致。";
const lines = [`目标: ${GOAL}`, ""];
if (CONCLUSIONS.length > 0) {
  lines.push("澄清结论:");
  for (const c of CONCLUSIONS) lines.push(`  [${c.topic}] ${c.conclusion}`);
}
lines.push("", `## 本次任务类型: ${TASK_TYPE}`, "", `### 能力链骨架(参考,在此基础上细化):`, `  ${chain}`, "", `### 关键注意事项:`, `  ${guidance}`, "", "请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
const userPrompt = lines.join("\n");

console.log(`system prompt: ${COMPOSER_SYSTEM_BASE.length} chars`);
console.log(`user prompt: ${userPrompt.length} chars`);

// --- 与 llm.ts _doComplete 完全一致的请求体 ---
const url = `${composer.base_url.replace(/\/$/, "")}/v1/messages`;
const body = {
  model: composer.model,
  max_tokens: 8192,
  system: COMPOSER_SYSTEM_BASE,
  messages: [{ role: "user", content: userPrompt }],
};

const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-api-key": composer.api_key,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify(body),
});
const elapsed = Date.now() - t0;
const rawText = await res.text();
console.log(`\nHTTP ${res.status} in ${elapsed}ms, body length: ${rawText.length}`);

// dump 原始响应供分析
const outFile = "scripts/diag-composer-response.json";
writeFileSync(outFile, rawText);
console.log(`raw response saved to ${outFile}`);

if (res.ok) {
  try {
    const data = JSON.parse(rawText);
    console.log("\n=== response structure ===");
    console.log("stop_reason:", data.stop_reason);
    console.log("model:", data.model);
    console.log("content blocks:", (data.content ?? []).map((b: any) => b.type));
    const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
    console.log("has text block:", !!textBlock);
    if (textBlock) console.log("text length:", textBlock.text?.length);
    // usage
    if (data.usage) console.log("usage:", JSON.stringify(data.usage));
  } catch (e) {
    console.log("JSON parse failed:", (e as Error).message);
    console.log("body head:", rawText.slice(0, 500));
  }
} else {
  console.log("body head:", rawText.slice(0, 1000));
}
