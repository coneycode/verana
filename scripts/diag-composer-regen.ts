/**
 * 诊断脚本 v3:复现 server 的 Composer regen 循环(生成→硬校验→带问题重试×3)
 * 每次 dump: stop_reason / usage / text 长度 / JSON 完整性 / 校验结果 / 原始输出文件
 * 用法: npx tsx scripts/diag-composer-regen.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

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

function buildUserPrompt(lastIssues: string): string {
  const lines = [`目标: ${GOAL}`, ""];
  lines.push("澄清结论:");
  for (const c of CONCLUSIONS) lines.push(`  [${c.topic}] ${c.conclusion}`);
  lines.push("", "## 本次任务类型: research", "", "### 能力链骨架(参考,在此基础上细化):", `  ${chain}`, "", "### 关键注意事项:", `  ${guidance}`, "", "请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
  if (lastIssues) lines.push("", `【上轮问题清单(请修复)】\n${lastIssues}`);
  return lines.join("\n");
}

const url = `${composer.base_url.replace(/\/$/, "")}/v1/messages`;

/** 与 parseJsonLoose 等价的宽松提取(独立实现,不 import 以便诊断独立) */
function looseParse(raw: string): any {
  const fenced = raw.replace(/```json\s*/g, "").replace(/```/g, "").trim();
  const start = fenced.search(/[[{]/);
  const end = Math.max(fenced.lastIndexOf("}"), fenced.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error("no JSON found");
  return JSON.parse(fenced.slice(start, end + 1));
}

/** 核心硬校验复刻:instances 非空 → blackboard_schema 必须有 {id}_remaining */
function checkRemaining(spec: any): string[] {
  const errors: string[] = [];
  const fields = new Set((spec.blackboard_schema?.fields ?? []).map((f: any) => f.key));
  for (const cap of spec.capabilities ?? []) {
    if (cap.instances && cap.instances.length > 0) {
      if (!fields.has(`${cap.id}_remaining`)) {
        errors.push(`capability ${cap.id} has instances but blackboard_schema missing field "${cap.id}_remaining"`);
      }
    }
  }
  return errors;
}

const MAX_REGEN = 3;
let lastIssues = "";

for (let attempt = 1; attempt <= MAX_REGEN; attempt++) {
  const userPrompt = buildUserPrompt(lastIssues);
  const body = {
    model: composer.model,
    max_tokens: 8192,
    system: COMPOSER_SYSTEM_BASE,
    messages: [{ role: "user", content: userPrompt }],
  };
  console.log(`\n=== attempt ${attempt}/${MAX_REGEN} (user prompt ${userPrompt.length}ch${lastIssues ? ", with issues" : ""}) ===`);
  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": composer.api_key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const elapsed = Date.now() - t0;
  const rawText = await res.text();
  if (!res.ok) {
    console.log(`HTTP ${res.status} in ${elapsed}ms: ${rawText.slice(0, 300)}`);
    break;
  }
  const data = JSON.parse(rawText);
  const blocks = (data.content ?? []).map((b: any) => b.type);
  const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
  const thinkBlock = (data.content ?? []).find((b: any) => b.type === "thinking");
  const outTok = data.usage?.output_tokens;
  const tokPerSec = outTok ? (outTok / (elapsed / 1000)).toFixed(1) : "?";
  console.log(`${elapsed}ms stop_reason=${data.stop_reason} out_tokens=${outTok} (${tokPerSec} tok/s) blocks=[${blocks}] thinking=${thinkBlock?.thinking?.length ?? 0}ch text=${textBlock?.text?.length ?? 0}ch`);
  writeFileSync(`scripts/diag-regen-attempt${attempt}.json`, rawText);

  if (!textBlock?.text) {
    console.log("NO TEXT BLOCK — empty content case!");
    console.log("usage:", JSON.stringify(data.usage));
    break;
  }
  const text = textBlock.text;
  // JSON 完整性检查:text 是否以 } 结尾(fenced JSON 被截断的信号)
  const trimmed = text.trim().replace(/```$/, "").trim();
  const jsonEndsProperly = trimmed.endsWith("}");
  console.log(`text ends with '}': ${jsonEndsProperly}${jsonEndsProperly ? "" : " <-- TRUNCATED? tail: " + JSON.stringify(trimmed.slice(-80))}`);

  try {
    const spec = looseParse(text);
    const caps = (spec.capabilities ?? []).map((c: any) => c.id);
    const bbFields = (spec.blackboard_schema?.fields ?? []).map((f: any) => f.key);
    console.log(`parsed OK: capabilities=[${caps.join(",")}]`);
    console.log(`blackboard fields=[${bbFields.join(",")}]`);
    const errors = checkRemaining(spec);
    if (errors.length === 0) {
      console.log(">>> _remaining check PASSED");
      break;
    }
    console.log(`>>> _remaining check FAILED: ${errors.join("; ")}`);
    lastIssues = errors.map(e => `[硬校验] ${e}`).join("\n");
  } catch (e) {
    console.log(`JSON PARSE FAILED: ${(e as Error).message}`);
    lastIssues = `[硬校验] JSON 解析失败: ${(e as Error).message}`;
    if (attempt === MAX_REGEN) break;
  }
}
console.log("\n=== regen loop done ===");
