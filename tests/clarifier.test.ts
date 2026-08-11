import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clarifyChat, buildGoalSummary, migrateClarifier } from "../src/clarifier.js";
import { FakeLlmClient } from "../src/fake-llm.js";
import { createProject, getProject, saveProjectState } from "../src/project-store.js";

test("clarifyChat: LLM 返回 ask", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-chat-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const client = new FakeLlmClient(() => ({
    json: {
      action: "ask",
      topic: "平台",
      question: "你要监控哪些平台?",
      reason: "不澄清会偏掉",
    },
  }));
  const state = await getProject(root, project.id);
  const result = await clarifyChat(state, client);
  assert.equal(result.type, "question");
  assert.equal(result.topic, "平台");
  assert.equal(result.content, "你要监控哪些平台?");
});

test("clarifyChat: LLM 返回 done + conclusions", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-done-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  state.status.clarifier = {
    status: "clarifying",
    messages: [
      { role: "assistant", content: "你要监控哪些平台?" },
      { role: "user", content: "YouTube和TikTok" },
    ],
  };
  const client = new FakeLlmClient(() => ({
    json: {
      action: "done",
      conclusions: [
        { topic: "平台", conclusion: "监控YouTube和TikTok两个平台" },
        { topic: "规模", conclusion: "几百个红人" },
      ],
    },
  }));
  const result = await clarifyChat(state, client);
  assert.equal(result.type, "done");
  assert.equal(result.conclusions.length, 2);
  assert.equal(result.conclusions[0].topic, "平台");
});

test("migrateClarifier: 旧 clarifications 转 messages", () => {
  const old = {
    status: "clarifying" as const,
    clarifications: [
      { q: "平台?", a: "YouTube", risk: "不澄清偏掉" },
      { q: "规模?", a: "几百个", risk: "影响选型" },
    ],
  };
  const migrated = migrateClarifier(old);
  assert.equal(migrated.messages.length, 4);
  assert.equal(migrated.messages[0].role, "assistant");
  assert.equal(migrated.messages[0].content, "平台?");
  assert.equal(migrated.messages[1].role, "user");
  assert.equal(migrated.messages[1].content, "YouTube");
});

test("buildGoalSummary: 从 conclusions 生成总结", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-summary-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  state.status.clarifier = {
    status: "goal_confirmed",
    messages: [
      { role: "assistant", content: "平台?" },
      { role: "user", content: "YouTube" },
    ],
    conclusions: [
      { topic: "平台", conclusion: "监控YouTube平台" },
      { topic: "规模", conclusion: "几百个红人" },
    ],
  };
  const summary = buildGoalSummary(state);
  assert.match(summary, /# Goal Confirmation/);
  assert.match(summary, /监控YouTube平台/);
  assert.match(summary, /几百个红人/);
});

test("buildGoalSummary: 兜底从 messages 提取(无 conclusions)", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-fallback-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  state.status.clarifier = {
    status: "goal_confirmed",
    messages: [
      { role: "assistant", content: "平台?" },
      { role: "user", content: "YouTube" },
    ],
  };
  const summary = buildGoalSummary(state);
  assert.match(summary, /平台/);
  assert.match(summary, /YouTube/);
});
