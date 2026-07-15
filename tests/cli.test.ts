import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";
import { setExecutorForTest } from "../src/graph-engine.js";
import { FakeExecutorAdapter } from "../src/fake-llm.js";
import { buildSmartFakeClient } from "../src/fake-llm.js";

test("CLI: new → approve plan → run → status", async () => {
  setExecutorForTest(new FakeExecutorAdapter());
  const root = await mkdtemp(join(tmpdir(), "verana-cli-graph-"));
  const client = buildSmartFakeClient();
  const lines: string[] = [];

  await runCli(["new", "写小说", "--root", root], (line: string) => lines.push(line), client);
  const projectId = lines.find((l) => l.startsWith("created "))?.split(" ")[1];
  assert.ok(projectId);

  lines.length = 0;
  await runCli(["plan", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((l) => l.includes("planned solution workflow")), true);

  lines.length = 0;
  await runCli(["approve", projectId, "plan_review", "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((l) => l.includes("approved plan_review")), true);

  lines.length = 0;
  await runCli(["run", projectId, "--root", root], (line: string) => lines.push(line), client);
  // 图引擎跑完(scheduler 2轮后 is_complete) → final_review
  assert.equal(lines.some((l) => l.includes("final_review")), true, `got: ${lines.join(",")}`);

  lines.length = 0;
  await runCli(["status", projectId, "--root", root], (line: string) => lines.push(line), client);
  assert.equal(lines.some((l) => l.includes("solution")), true);
});
