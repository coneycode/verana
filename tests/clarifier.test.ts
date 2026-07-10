import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { generateClarifyBatch, reviewClarifications, buildGoalSummary } from "../src/clarifier.js";
import { FakeLlmClient } from "../src/fake-llm.js";
import { createProject, getProject, saveProjectState } from "../src/project-store.js";

test("generateClarifyBatch: LLM 生成多个问题,代码去重", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-batch-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const client = new FakeLlmClient(() => ({
    json: {
      questions: [
        { dimension: "平台", question: "你要监控哪些平台?", risk: "不澄清会偏掉" },
        { dimension: "规模", question: "监控多少个红人?", risk: "影响方案选型" },
        { dimension: "平台", question: "你要监控哪些平台?", risk: "重复" }, // 重复,应被去重
      ],
    },
  }));
  const batch = await generateClarifyBatch(await getProject(root, project.id), client);
  assert.equal(batch.questions.length, 2); // 第三个重复被去掉
  assert.equal(batch.questions[0]?.dimension, "平台");
  assert.equal(batch.questions[1]?.dimension, "规模");
});

test("reviewClarifications: 不需要追问", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-review-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  state.status.clarifier = {
    status: "clarifying",
    clarifications: [
      { q: "监控哪些平台?", a: "YouTube和TikTok", risk: "" },
      { q: "监控多少个?", a: "几百个", risk: "" },
    ],
  };
  await saveProjectState(root, state);
  const client = new FakeLlmClient(() => ({ json: { need_followup: false } }));
  const review = await reviewClarifications(state, client);
  assert.equal(review.needFollowup, false);
  assert.equal(review.questions.length, 0);
});

test("buildGoalSummary includes all clarifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-summary-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  state.status.clarifier = {
    status: "clarifying",
    clarifications: [{ q: "平台?", a: "YouTube", risk: "不澄清偏掉" }],
  };
  const summary = buildGoalSummary(state);
  assert.match(summary, /# Goal Confirmation/);
  assert.match(summary, /YouTube/);
  assert.match(summary, /偏掉/);
});
