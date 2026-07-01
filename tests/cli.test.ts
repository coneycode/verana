import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";

test("CLI supports new, clarify, input, plan, approve, run, status, logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-cli-llm-"));
  const client = buildSmartFakeClient();
  const lines: string[] = [];

  await runCli(["new", "调研海外红人监控系统", "--root", root], (line: string) => lines.push(line), client);
  const projectId = lines.find((line) => line.startsWith("created "))?.split(" ")[1];
  assert.ok(projectId);

  lines.length = 0;
  await runCli(["clarify", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.startsWith("question:")), true);

  lines.length = 0;
  await runCli(["input", projectId, "YouTube", "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines[0], "input recorded");

  lines.length = 0;
  await runCli(["plan", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.includes("plan_review")), true);

  lines.length = 0;
  await runCli(["approve", projectId, "plan_review", "--root", root, "--note", "ok"], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.includes("approved plan_review")), true);

  lines.length = 0;
  await runCli(["run", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.includes("final_review")), true);

  lines.length = 0;
  await runCli(["status", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.includes("solution: final_review")), true);

  lines.length = 0;
  await runCli(["logs", projectId, "run-0001", "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((line) => line.includes("verdict: passed")), true);
});
