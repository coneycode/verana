import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { appendClarification, buildGoalSummary, nextClarificationQuestion } from "../src/clarifier.js";
import { FakeLlmClient, fakeClarifierQuestion } from "../src/fake-llm.js";
import { createProject, getProject } from "../src/project-store.js";

test("nextClarificationQuestion uses LLM to generate a question", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-llm-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const client = new FakeLlmClient(() => ({ json: fakeClarifierQuestion() }));

  const question = await nextClarificationQuestion(await getProject(root, project.id), client);

  assert.equal(question?.question, "你要监控哪些平台?");
  assert.equal(question?.risk.includes("偏掉"), true);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]?.role, "composer");
});

test("nextClarificationQuestion returns null when LLM says done", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-done-"));
  const project = await createProject(root, "目标足够清晰");
  const client = new FakeLlmClient(() => ({ json: { done: true } }));

  const question = await nextClarificationQuestion(await getProject(root, project.id), client);

  assert.equal(question, null);
});

test("appendClarification records the answer with risk", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-append-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  const next = fakeClarifierQuestion();

  const updated = appendClarification(state, "YouTube 和 TikTok", next);

  assert.equal(updated.status.clarifier?.clarifications.length, 1);
  assert.equal(updated.status.clarifier?.clarifications[0]?.a, "YouTube 和 TikTok");
  assert.equal(updated.status.clarifier?.clarifications[0]?.risk, next.risk);
});

test("buildGoalSummary includes all clarifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-summary-"));
  const project = await createProject(root, "调研海外红人监控系统");
  const state = await getProject(root, project.id);
  const updated = appendClarification(state, "YouTube", fakeClarifierQuestion());

  const summary = buildGoalSummary(updated);

  assert.match(summary, /# Goal Confirmation/);
  assert.match(summary, /YouTube/);
  assert.match(summary, /偏掉/);
});
