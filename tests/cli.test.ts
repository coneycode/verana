import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../src/cli.js";

test("CLI supports new, plan, approve, run, status, logs", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-cli-"));
  const lines: string[] = [];

  await runCli(["new", "调研海外红人监控系统", "--root", root], (line) => lines.push(line));
  const created = lines.find((line) => line.startsWith("created "));
  assert.ok(created);
  const projectId = created.split(" ")[1];

  lines.length = 0;
  await runCli(["plan", projectId, "--root", root], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.includes("plan_review")), true);

  lines.length = 0;
  await runCli(["approve", projectId, "plan_review", "--root", root, "--note", "ok"], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.includes("approved plan_review")), true);

  lines.length = 0;
  await runCli(["run", projectId, "--root", root], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.includes("final_review")), true);

  lines.length = 0;
  await runCli(["status", projectId, "--root", root], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.includes("solution: final_review")), true);

  lines.length = 0;
  await runCli(["logs", projectId, "run-0001", "--root", root], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.includes("verdict: passed")), true);
});
