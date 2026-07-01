import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.js";

test("clarify asks one question with risk disclosure and input records answers", async () => {
  const root = await mkdtemp(join(tmpdir(), "verana-clarify-"));
  const lines: string[] = [];
  await runCli(["new", "调研海外红人监控系统", "--root", root], (line) => lines.push(line));
  const projectId = lines.find((line) => line.startsWith("created "))?.split(" ")[1];
  assert.ok(projectId);

  lines.length = 0;
  await runCli(["clarify", projectId, "--root", root], (line) => lines.push(line));
  assert.equal(lines.some((line) => line.startsWith("question:")), true);
  assert.equal(lines.some((line) => line.startsWith("risk:")), true);

  lines.length = 0;
  await runCli(["input", projectId, "交付调研方案", "--root", root], (line) => lines.push(line));
  assert.equal(lines[0], "input recorded");
  assert.equal(lines.some((line) => line.startsWith("next_question:")), true);
});
