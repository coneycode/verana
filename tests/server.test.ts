import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildServer } from "../src/server.js";

test("Fastify server exposes project creation, listing, snapshot, and SSE endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-server-"));
  const app = buildServer({ rootDir: root });

  try {
    const homeResponse = await app.inject({ method: "GET", url: "/" });
    assert.equal(homeResponse.statusCode, 200);
    assert.match(homeResponse.body, /Verana · Agent Workflow Delivery/);

    const createResponse = await app.inject({ method: "POST", url: "/projects", payload: { goal: "调研海外红人监控系统" } });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json();
    assert.equal(created.project.status, "created");

    const listResponse = await app.inject({ method: "GET", url: "/projects" });
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.json().length, 1);

    const snapshotResponse = await app.inject({ method: "GET", url: `/projects/${created.project.id}` });
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(snapshotResponse.json().project.id, created.project.id);

    const clarifyResponse = await app.inject({ method: "GET", url: `/projects/${created.project.id}/clarify` });
    assert.equal(clarifyResponse.statusCode, 200);
    assert.match(clarifyResponse.json().question, /交付/);

    const inputResponse = await app.inject({ method: "POST", url: `/projects/${created.project.id}/input`, payload: { answer: "交付调研方案" } });
    assert.equal(inputResponse.statusCode, 200);
    assert.equal(inputResponse.json().status.clarifier.clarifications.length, 1);

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
