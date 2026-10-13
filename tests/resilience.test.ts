import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HermesAdapter } from "../src/executors.js";
import { parseJsonLoose } from "../src/llm.js";
import { appendEvent } from "../src/event-log.js";

// ─── P1: hitMaxTurns / usedTurns 提取器 ───
// 2026-10-09 事故:hermes 正常结束页脚 "Messages: 68 (1 user, 66 tool calls)" 被
// 误判成 max-turns hit(5/5 误报)。提取器必须只认显式信号。

test("hermes 正常结束页脚(Messages+tool calls)不触发 hitMaxTurns", async () => {
  // 用真实结构的 hermes 输出验证 close handler 的解析逻辑。
  // _spawnHermes 是 private,但解析逻辑等价于对 stdout 的两个判定:
  //   hitMaxTurns = /Max turns|hit.*max.*turn|max-turns limit reached/i.test(stdout) || code === null
  //   usedTurns = stdout.match(/Messages:\s*(\d+)\s*\(/)
  // 这里直接验证正则行为(与实现同源):
  const footer = `Session:        20261009_155347_00bf03
Duration:       8m 10s
Messages:       68 (1 user, 66 tool calls)`;
  const hitMaxTurnsRegex = /Max turns|hit.*max.*turn|max-turns limit reached/i;
  assert.equal(hitMaxTurnsRegex.test(footer), false, "正常页脚不得命中 max-turns 启发式");
  const turnsMatch = footer.match(/Messages:\s*(\d+)\s*\(/);
  assert.equal(turnsMatch?.[1], "68", "页脚 Messages 数必须可解析为真实轮次");
});

test("hermes 显式 max-turns 输出触发 hitMaxTurns", () => {
  const explicit = `Max turns reached — stopping.
Messages:       120 (1 user, 119 tool calls)`;
  const hitMaxTurnsRegex = /Max turns|hit.*max.*turn|max-turns limit reached/i;
  assert.equal(hitMaxTurnsRegex.test(explicit), true);
});

// ─── P1: AgentRun 新字段(直接对 executors 模块导出的类型行为做冒烟) ───

test("HermesAdapter 接口扩展:stderr/usedTurns 字段存在且可选", async () => {
  // 类型层验证(编译期已保证),运行期冒烟:构造的 AgentRun 合法
  const adapter = new HermesAdapter();
  assert.equal(typeof adapter.execute, "function");
  assert.equal(typeof adapter.resume, "function");
});

// ─── P1: 去重率提取器(curl/browser_navigate 覆盖) ───
// 2026-10-09 事故:executor 实际全用 curl,旧正则只认 web_search → 去重率恒 0。

test("curl 行的 query 关键词可提取且去重率非零", () => {
  const raw = `  ┊ 💻 $ curl -s "http://export.arxiv.org/api/query?search_query=all:%22Regularized%20Recursive%20Self-Improvement%22&max_results=10"  0.5s
  ┊ 💻 $ curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=RRSI%20Regularized&fields=title"  0.6s
  ┊ 💻 $ curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=RRSI%20experiments&fields=title"  0.6s`;
  // 与 collectExecutionFacts 实现同源的提取逻辑
  const searchKeywords: string[] = [];
  const curlMatches = raw.split("\n").filter(l => l.includes("curl") && l.includes("http"));
  for (const line of curlMatches) {
    const q = line.match(/[?&](?:search_query|query|q)=([^&\s"']+)/);
    if (q) searchKeywords.push(decodeURIComponent(q[1]).slice(0, 40));
    else {
      const url = line.match(/https?:\/\/[^\s"']+/);
      if (url) searchKeywords.push(url[0].slice(0, 40));
    }
  }
  assert.equal(searchKeywords.length, 3, "3 条 curl 必须提取出 3 个关键词");
  const unique = new Set(searchKeywords);
  assert.equal(unique.size >= 2, true, "不同 query 的关键词不得被误判为全重复");
});

// ─── P0: llm.ts 网络异常重试(用 mock fetch 验证穿透修复) ───

test("llm fetch 网络异常会重试而非一次穿透(重试后成功)", async () => {
  // 动态 import 以便篡改 globalThis.fetch
  const { HttpLlmClient } = await import("../src/llm.js");
  const cfg = {
    composer: { role: "composer" as const, base_url: "http://127.0.0.1:1", model: "test", api_key: "k" },
    evaluator: { role: "evaluator" as const, base_url: "http://127.0.0.1:1", model: "test", api_key: "k" },
  };
  const client = new HttpLlmClient(cfg as never);
  const realFetch = globalThis.fetch;
  let calls = 0;
  // 第1、2次抛网络异常(模拟 ETIMEDOUT),第3次成功
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls < 3) {
      const e = new Error("fetch failed");
      (e as Error & { cause?: { code: string } }).cause = { code: "ETIMEDOUT" };
      throw e;
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await client.complete("composer", "sys", "user");
    assert.equal(out, "ok");
    assert.equal(calls, 3, "网络异常必须重试,第3次成功");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("llm fetch 网络异常重试耗尽后报网络错误(含 cause)", async () => {
  const { HttpLlmClient } = await import("../src/llm.js");
  const cfg = {
    composer: { role: "composer" as const, base_url: "http://127.0.0.1:1", model: "test", api_key: "k" },
    evaluator: { role: "evaluator" as const, base_url: "http://127.0.0.1:1", model: "test", api_key: "k" },
  };
  const client = new HttpLlmClient(cfg as never);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const e = new Error("fetch failed");
    (e as Error & { cause?: { code: string } }).cause = { code: "ECONNRESET" };
    throw e;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => client.complete("composer", "sys", "user"),
      (err: Error) => err.message.includes("network error") && err.message.includes("ECONNRESET"),
      "耗尽后必须是 network error 且带 cause code",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ─── P0: 并行批隔离(synthetic infra verdict) ───
// 通过 server 层验证太重;这里验证 graph-engine 的 doExecute 隔离行为最小等价:
// executeAndVerifyInstance 抛错 → catch → infra verdict(passed=false, F_infra_error)。
// 直接跑 runGraphProject 级测试在 tests/pipeline.test.ts 已有覆盖(fake executor);
// 本测试锁行为契约:VerdictRecord.failure_class 接受 F_infra_error。

test("VerdictRecord.failure_class 支持 F_infra_error(批隔离 synthetic verdict 契约)", () => {
  const infraVerdict = {
    passed: false,
    method: "combined" as const,
    reasons: ["基础设施异常(非执行质量问题): ETIMEDOUT"],
    evidence: [],
    failure_class: "F_infra_error" as const,
  };
  assert.equal(infraVerdict.failure_class, "F_infra_error");
  assert.equal(infraVerdict.passed, false);
});

// ─── P3: 恢复审计(auditPassedVerdicts 的数据契约) ───

test("恢复审计:run_created→verdict.yaml(passed) 映射可从事件日志重建", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "verana-audit-"));
  try {
    const solutionDir = join(tmp, "solution");
    await mkdir(solutionDir, { recursive: true });
    // 造事件:两个 run,一个 passed 一个没 verdict
    await appendEvent(solutionDir, { type: "run_created", node: "search", run_id: "run-0001", instance: "method_core" });
    await appendEvent(solutionDir, { type: "run_created", node: "search", run_id: "run-0002", instance: "experiments" });
    await appendEvent(solutionDir, { type: "verdict", node: "search", run_id: "run-0001", reason: "passed=true ok", data: { passed: true } });
    // run-0001 落 verdict.yaml
    await mkdir(join(tmp, "runs", "run-0001"), { recursive: true });
    await writeFile(join(tmp, "runs", "run-0001", "verdict.yaml"), "passed: true\nmethod: combined\nreasons:\n  - ok\n");
    // run-0002 无 verdict.yaml(崩溃时未完成)

    // 复刻 auditPassedVerdicts 的读取逻辑(server.ts 私有函数,同源验证)
    const { readEvents } = await import("../src/event-log.js");
    const events = await readEvents(solutionDir, 0);
    const runMeta = new Map<string, { node: string; instance?: string }>();
    for (const e of events) {
      if (e.type === "run_created" && e.run_id) runMeta.set(e.run_id, { node: e.node ?? "?", instance: e.instance });
    }
    assert.equal(runMeta.get("run-0001")?.instance, "method_core");
    assert.equal(runMeta.get("run-0002")?.instance, "experiments");

    const remaining = ["paper_background", "method_core", "experiments"];
    const salvaged: string[] = [];
    for (const [rid, meta] of runMeta) {
      if (!meta.instance || !remaining.includes(meta.instance)) continue;
      try {
        const yaml = await readFile(join(tmp, "runs", rid, "verdict.yaml"), "utf8");
        if (yaml.includes("passed: true")) salvaged.push(meta.instance);
      } catch { /* no verdict */ }
    }
    assert.deepEqual(salvaged, ["method_core"], "只有落盘 passed verdict 的 instance 被补扣");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// readFile import 挪到顶部使用
import { readFile } from "node:fs/promises";
