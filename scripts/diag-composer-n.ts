/**
 * 诊断脚本:多次调用 Composer 复现 "empty content",失败时 dump 完整原始响应
 * 用法: npx tsx scripts/diag-composer-n.ts [次数] [间隔秒]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";

const N = Number(process.argv[2] ?? 5);
const GAP = Number(process.argv[3] ?? 10) * 1000;

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
if (!m) throw new Error("COMPOSER_SYSTEM_BASE not found in pipeline.ts");
const COMPOSER_SYSTEM_BASE = m[1];

const chain = "plan_outline(light) → search(×N instances, 按维度拆分) → write_evidence(×N instances, 按维度拆分) → synthesize(agent) → polish_report(agent) → review_report(agent)";
const guidance = "调研型任务。先规划大纲(含每个维度的调研方向)。search 节点边搜边写原始结果到 solution/search/{instance}.md(搜到一条写一条,每条标注来源,不要求结构化)。write_evidence 从 search 文件整理成 solution/evidence/{instance}.md(只整理不搜索)。synthesize 从所有 evidence 综合成完整报告。有 instances 的 output path 必须含 {instance} 占位符。search 和 write_evidence 的 instances 清单一致。";
const lines = [`目标: ${GOAL}`, ""];
if (CONCLUSIONS.length > 0) {
  lines.push("澄清结论:");
  for (const c of CONCLUSIONS) lines.push(`  [${c.topic}] ${c.conclusion}`);
}
lines.push("", `## 本次任务类型: research`, "", `### 能力链骨架(参考,在此基础上细化):`, `  ${chain}`, "", `### 关键注意事项:`, `  ${guidance}`, "", "请规划图工作流(能力清单 + 护栏 + blackboard schema)。");
const userPrompt = lines.join("\n");

const url = `${composer.base_url.replace(/\/$/, "")}/v1/messages`;
const baseBody = {
  model: composer.model,
  max_tokens: 8192,
  system: COMPOSER_SYSTEM_BASE,
  messages: [{ role: "user", content: userPrompt }],
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let ok = 0, fail = 0;
const results: Array<Record<string, unknown>> = [];

for (let i = 1; i <= N; i++) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": composer.api_key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(baseBody),
    });
    const elapsed = Date.now() - t0;
    const rawText = await res.text();
    if (!res.ok) {
      fail++;
      console.log(`#${i} HTTP ${res.status} in ${elapsed}ms — body: ${rawText.slice(0, 200)}`);
      writeFileSync(`scripts/diag-fail-${i}.json`, rawText);
      results.push({ i, status: res.status, elapsed, kind: "http_error" });
      continue;
    }
    let data: any;
    try { data = JSON.parse(rawText); } catch { 
      fail++; console.log(`#${i} 200 but body not JSON in ${elapsed}ms — head: ${rawText.slice(0, 200)}`);
      writeFileSync(`scripts/diag-fail-${i}.json`, rawText);
      results.push({ i, status: res.status, elapsed, kind: "body_not_json" });
      continue;
    }
    const blockTypes = (data.content ?? []).map((b: any) => b.type);
    const textBlock = (data.content ?? []).find((b: any) => b.type === "text");
    const hasText = !!textBlock?.text;
    if (hasText) {
      ok++;
      console.log(`#${i} OK in ${elapsed}ms — stop_reason=${data.stop_reason} blocks=[${blockTypes}] text=${textBlock.text.length}ch out_tokens=${data.usage?.output_tokens}`);
      results.push({ i, status: 200, elapsed, kind: "ok", stop_reason: data.stop_reason, block_types: blockTypes, text_len: textBlock.text.length, output_tokens: data.usage?.output_tokens });
    } else {
      fail++;
      console.log(`#${i} EMPTY-CONTENT in ${elapsed}ms — stop_reason=${data.stop_reason} blocks=[${blockTypes}] usage=${JSON.stringify(data.usage)}`);
      writeFileSync(`scripts/diag-fail-${i}.json`, rawText);
      results.push({ i, status: 200, elapsed, kind: "empty_content", stop_reason: data.stop_reason, block_types: blockTypes, usage: data.usage, full_response: rawText.slice(0, 3000) });
    }
  } catch (e) {
    fail++;
    const elapsed = Date.now() - t0;
    console.log(`#${i} EXCEPTION in ${elapsed}ms — ${(e as Error).message}`);
    results.push({ i, status: 0, elapsed, kind: "exception", error: (e as Error).message });
  }
  if (i < N) await sleep(GAP);
}

console.log(`\n=== SUMMARY: ${ok} ok / ${fail} fail out of ${N} ===`);
writeFileSync("scripts/diag-composer-n-summary.json", JSON.stringify(results, null, 2));
console.log("details saved to scripts/diag-composer-n-summary.json");
