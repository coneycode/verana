import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";

test("Fastify server with LLM client exposes full solution-delivery loop via API", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-server-llm-"));
  const client = buildSmartFakeClient();
  const app = await buildServer({ rootDir: root, client });

  try {
    const homeResponse = await app.inject({ method: "GET", url: "/" });
    assert.equal(homeResponse.statusCode, 200);
    assert.match(homeResponse.body, /Verana/);

    const createResponse = await app.inject({ method: "POST", url: "/projects", payload: { goal: "调研海外红人监控系统" } });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json();
    assert.equal(created.project.status, "created");

    const clarifyResponse = await app.inject({ method: "GET", url: `/projects/${created.project.id}/clarify` });
    assert.equal(clarifyResponse.statusCode, 200);
    assert.match(clarifyResponse.json().question, /平台/);

    const inputResponse = await app.inject({ method: "POST", url: `/projects/${created.project.id}/input`, payload: { answer: "YouTube" } });
    assert.equal(inputResponse.statusCode, 200);
    assert.equal(inputResponse.json().state.status.clarifier.clarifications.length, 1);

    const planResponse = await app.inject({ method: "POST", url: `/projects/${created.project.id}/plan` });
    assert.equal(planResponse.statusCode, 200);
    assert.equal(planResponse.json().phase, "solution");

    const approvePlan = await app.inject({ method: "POST", url: `/projects/${created.project.id}/approve`, payload: { gate: "plan_review", note: "ok" } });
    assert.equal(approvePlan.statusCode, 200);

    const runResponse = await app.inject({ method: "POST", url: `/projects/${created.project.id}/run` });
    assert.equal(runResponse.statusCode, 200);
    assert.equal(runResponse.json().status.workflows.solution.status, "final_review");

    const runLogResponse = await app.inject({ method: "GET", url: `/projects/${created.project.id}/runs/run-0001` });
    assert.equal(runLogResponse.statusCode, 200);
    assert.equal(runLogResponse.json().verdict.passed, true);

    const eventsResponse = await app.inject({ method: "GET", url: `/projects/${created.project.id}/events?once=1` });
    assert.equal(eventsResponse.statusCode, 200);
    assert.match(eventsResponse.body, /event: snapshot/);
  } finally {
    await app.close();
  }
});
