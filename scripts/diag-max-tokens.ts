/**
 * 诊断脚本:验证 max_tokens=16384 是否被网关接受(多模型通用性测试)
 * 用法: npx tsx scripts/diag-max-tokens.ts [max_tokens]
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const MAX_TOKENS = Number(process.argv[2] ?? 16384);

const cfg = parse(readFileSync("verana.config.yaml", "utf8"));
const composer = cfg.composer;

const GOAL = "调研豆包爱学的近期动态，产品形态、产品目标等信息；我需要对这个产品做个全面的了解；";
const CONCLUSIONS = [
  { topic: "任务性质", conclusion: "对豆包爱学做竞品分析，全面了解这款产品" },
  { topic: "最终产出", conclusion: "不需要正式文档，自己心里有全面的了解即可" },
  { topic: "调研范围", conclusion: "产品定位、目标用户、产品形态、核心功能、商业模式等方面全面覆盖" },
  { topic: "时间范围", conclusion: "重点梳理最近半年的动态，包括更新、改版、重要功能上线等大动作" },
  { topic: "信息来源", conclusion: "公开资料(官方公告、媒体报道、应用商店信息)加亲自下载体验核心功能相结合" },
  { topic: "验收标准", conclusion: "达到竞品分析所需的认知深度，各方面都过一遍并形成对产品的完整印象" },
];

const src = readFileSync("src/pipeline.ts", "utf8");
const m = src.match(/const COMPOSER_SYSTEM_BASE = `([\s\S]*?)`;/);
if (!m) throw new Error("COMPOSER_SYSTEM_BASE not found");
const COMPOSER_SYSTEM_BASE = m[1];

const chain = "plan_outline(light) → search(×N instances, 按维度拆分) → write_evidence(×N instances, 按维度拆分) → synthesize(agent) → polish_report(agent) → review_report(agent)";
const guidance = "调研型任务。先规划大纲(含每个维度的调研方向)。search 节点边搜边写原始结果到 solution/search/{instance}.md(搜到一条写一条,每条标注来源,不要求结构化)。write_evidence 从 search 文件整理成 solution/evidence/{instance}.md(只整理不搜索)。synthesize 从所有 evidence 综合成完整报告。有 instances 的 output path 必须含 {instance} 占位符。search 和 write_evidence 的 instances 清单一致。";
const lines = [`目标: ${GOAL}`, "", "澄清结论:"];
for (const c of CONCLUSIONS) lines.push(`  [${c.topic}] ${c.conclusion}`);
lines.push("", "## 本次任务类型: research", "", "### 能力链骨架(参考,在此基础上细化):", `  ${chain}`, "", "### 关键注意事项:", `  ${guidance}`, "", "请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
const userPrompt = lines.join("\n");

const url = `${composer.base_url.replace(/\/$/, "")}/v1/messages`;
const body = {
  model: composer.model,
  max_tokens: MAX_TOKENS,
  system: COMPOSER_SYSTEM_BASE,
  messages: [{ role: "user", content: userPrompt }],
};

console.log(`testing max_tokens=${MAX_TOKENS} with model=${composer.model}`);
const t0 = Date.now();
const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": composer.api_key, "anthropic-version": "2023-06-01" },
  body: JSON.stringify(body),
});
const elapsed = Date.now() - t0;
const rawText = await res.text();

if (!res.ok) {
  console.log(`HTTP ${res.status} in ${elapsed}ms — REJECTED:`);
  console.log(rawText.slice(0, 500));
  process.exit(1);
}

const data = JSON.parse(rawText);
const blocks = (data.content ?? []).map((b: any) => b.type);
const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
const thinkBlock = (data.content ?? []).find((b: any) => b.type === "thinking");
const text = textBlock?.text ?? "";
const trimmed = text.trim().replace(/```$/, "").trim();
const endsProperly = trimmed.endsWith("}");

console.log(`HTTP 200 in ${elapsed}ms`);
console.log(`stop_reason=${data.stop_reason} out_tokens=${data.usage?.output_tokens}`);
console.log(`blocks=[${blocks}] thinking=${thinkBlock?.thinking?.length ?? 0}ch text=${text.length}ch`);
console.log(`JSON complete (ends with '}'): ${endsProperly}`);

if (text) {
  // 检查关键字段是否齐全
  for (const field of ["capabilities", "guardrails", "blackboard_schema", "entry_node", "completion_criteria", "agents", "required_capabilities"]) {
    console.log(`  ${field}: ${text.includes('"' + field + '"') ? "present" : "MISSING"}`);
  }
}
