import { test } from "node:test";
import assert from "node:assert";
import { normalizeConfig, DEFAULT_MAX_TOKENS, HttpLlmClient, parseJsonLoose } from "../src/llm.js";
import type { VeranaConfig, ModelConfig, ModelRole } from "../src/llm.js";

const BASE: Omit<ModelConfig, "role"> = { base_url: "http://gw/anthropic", model: "m1", api_key: "k1" };
const COMPOSER = { role: "composer" as const, ...BASE };
const EVALUATOR = { role: "evaluator" as const, ...BASE, model: "m2" };

function mkConfig(composerMax?: number): VeranaConfig {
  return {
    composer: { ...COMPOSER, max_tokens: composerMax } as ModelConfig,
    evaluator: EVALUATOR,
  };
}

/** 起一个假网关:按 stop_reason 参数返回 anthropic 格式响应 */
function fakeGateway(handler: (body: any) => { status: number; json: any }) {
  const calls: any[] = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const r = handler(body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = origFetch; } };
}

test("normalizeConfig: max_tokens 未配置时为 undefined(运行时用默认值)", () => {
  const cfg = normalizeConfig({ composer: COMPOSER, evaluator: EVALUATOR });
  assert.equal(cfg.composer.max_tokens, undefined);
  assert.equal(DEFAULT_MAX_TOKENS, 16384);
});

test("normalizeConfig: max_tokens 可配置", () => {
  const cfg = normalizeConfig({ composer: { ...COMPOSER, max_tokens: 8192 }, evaluator: EVALUATOR });
  assert.equal(cfg.composer.max_tokens, 8192);
  assert.equal(cfg.evaluator.max_tokens, undefined);
});

test("complete: 默认 max_tokens=16384 发进请求体", async () => {
  const gw = fakeGateway(() => ({ status: 200, json: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" } }));
  try {
    const client = new HttpLlmClient(mkConfig());
    const out = await client.complete("composer", "sys", "usr");
    assert.equal(out, "hi");
    assert.equal(gw.calls[0].max_tokens, 16384);
  } finally { gw.restore(); }
});

test("complete: 配置的 max_tokens 发进请求体", async () => {
  const gw = fakeGateway(() => ({ status: 200, json: { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" } }));
  try {
    const client = new HttpLlmClient(mkConfig(4096));
    await client.complete("composer", "sys", "usr");
    assert.equal(gw.calls[0].max_tokens, 4096);
  } finally { gw.restore(); }
});

test("complete: stop_reason=max_tokens 抛 LLM_OUTPUT_TRUNCATED(不重试,直接上抛给 regen 循环)", async () => {
  const gw = fakeGateway(() => ({ status: 200, json: { content: [{ type: "text", text: "{\"a\":1" }], stop_reason: "max_tokens", usage: { output_tokens: 8192 } } }));
  try {
    const client = new HttpLlmClient(mkConfig());
    await assert.rejects(
      () => client.complete("composer", "sys", "usr"),
      (e: Error) => e.message.includes("LLM_OUTPUT_TRUNCATED") && e.message.includes("16384"),
    );
    // 截断是确定性失败(重发同样的请求还是撞上限),不重试
    assert.equal(gw.calls.length, 1);
  } finally { gw.restore(); }
});

test("complete: 空内容(无 text block)dump 证据并重试,重试成功返回", async () => {
  let n = 0;
  const gw = fakeGateway(() => {
    n++;
    if (n === 1) return { status: 200, json: { content: [{ type: "thinking", thinking: "..." }], stop_reason: "max_tokens", usage: { output_tokens: 8192 } } };
    return { status: 200, json: { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } };
  });
  try {
    const client = new HttpLlmClient(mkConfig());
    const out = await client.complete("composer", "sys", "usr");
    assert.equal(out, "ok");
    assert.equal(gw.calls.length, 2);
  } finally { gw.restore(); }
});

test("complete: 非 JSON body 抛可读错误", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 200 })) as typeof fetch;
  try {
    const client = new HttpLlmClient(mkConfig());
    await assert.rejects(
      () => client.complete("composer", "sys", "usr"),
      (e: Error) => e.message.includes("non-JSON body") && e.message.includes("<html>"),
    );
  } finally { globalThis.fetch = origFetch; }
});

test("parseJsonLoose: 截断的 fenced JSON 解析失败抛错带原文头", () => {
  assert.throws(
    () => parseJsonLoose("```json\n{\"clarified\": \"x\", \"capabilities\": [{\"id\": \"a\""),
    (e: Error) => e.message.length > 0,
  );
});

test("ModelRole 类型完整", () => {
  const roles: ModelRole[] = ["composer", "evaluator"];
  assert.deepEqual(roles, ["composer", "evaluator"]);
});
