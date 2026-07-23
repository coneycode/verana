import assert from "node:assert";
import { rm, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSmartFakeClient } from "../src/fake-llm.js";
import { collectArtifacts, validateArtifactContract } from "../src/artifacts.js";
import { materializeArtifacts, isMaterializableReport } from "../src/materializer.js";
import type { CapabilityNode } from "../src/types.js";

const agentNode: CapabilityNode = {
  id: "write_report",
  kind: "agent",
  desc: "写调研报告",
  inputs: [],
  outputs: [{ path: "solution/report.md", desc: "调研报告", min_bytes: 40, min_lines: 3 }],
  checks: [{ method: "llm_rubric", desc: "结构完整" }],
};

test("isMaterializableReport: looks_like_process_log is materializable", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-mat-"));
  const runDir = join(projectDir, "runs", "run-0001");
  await mkdir(join(projectDir, "solution"), { recursive: true });
  // 写一个像过程日志的文件(触发 artifact_looks_like_process_log)
  await writeFile(join(projectDir, "solution", "report.md"), "让我先看一下资料。我来分析一下。接下来我将总结。我已经完成了调研。\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const report = await validateArtifactContract({ snapshot, node: agentNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, false);
  assert.equal(isMaterializableReport(report, agentNode.outputs!), true);
});

test("isMaterializableReport: declared_output_missing is NOT materializable", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-mat-"));
  const runDir = join(projectDir, "runs", "run-0001");
  // 不写文件 → declared_output_missing
  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const report = await validateArtifactContract({ snapshot, node: agentNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, false);
  assert.equal(isMaterializableReport(report, agentNode.outputs!), false);
});

test("materializeArtifacts: generates valid deliverable from bad artifact", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-mat-"));
  const runDir = join(projectDir, "runs", "run-0001");
  await mkdir(join(projectDir, "solution"), { recursive: true });
  await mkdir(runDir, { recursive: true });
  // 写一个像过程日志的文件
  await writeFile(join(projectDir, "solution", "report.md"), "让我先看一下资料。我来分析一下。接下来我将总结。我已经完成了调研。\n", "utf8");
  await writeFile(join(runDir, "claim.md"), "# Claim\n\n已完成调研报告\n", "utf8");
  await writeFile(join(runDir, "stream.md"), "# Run\n\n执行中...\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const report = await validateArtifactContract({ snapshot, node: agentNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, false);

  const client = buildSmartFakeClient();
  const result = await materializeArtifacts({
    client,
    projectDir: projectDir,
    runDir,
    snapshot,
    report,
    node: agentNode,
    deliverableType: "research",
    instruction: "写调研报告",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.passed, true);
  assert.ok(result.written.includes("solution/report.md"));

  // 验证写入的文件不是空/过程日志
  const { readFile: readFileFn } = await import("node:fs/promises");
  const content = await readFileFn(join(projectDir, "solution", "report.md"), "utf8");
  assert.ok(content.length > 40);
  assert.ok(content.includes("##"));
});

test("materializeArtifacts: skipped when no materializable failures", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-mat-"));
  const runDir = join(projectDir, "runs", "run-0001");
  await mkdir(runDir, { recursive: true });

  // 不写文件 → declared_output_missing (不在 MATERIALIZABLE_FAILURES 里)
  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const report = await validateArtifactContract({ snapshot, node: agentNode, projectDir, deliverableType: "research" });

  const client = buildSmartFakeClient();
  const result = await materializeArtifacts({
    client,
    projectDir: projectDir,
    runDir,
    snapshot,
    report,
    node: agentNode,
    deliverableType: "research",
    instruction: "写调研报告",
  });

  assert.equal(result.attempted, false);
  assert.ok(result.skipped_reason);
});

test("materializeArtifacts: evidence outputs are not materialized", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-mat-"));
  const runDir = join(projectDir, "runs", "run-0001");
  await mkdir(join(projectDir, "solution", "evidence"), { recursive: true });
  await mkdir(runDir, { recursive: true });

  const evidenceNode: CapabilityNode = {
    ...agentNode,
    outputs: [{ path: "solution/evidence/raw.md", desc: "原始证据", role: "evidence", materializable: false, min_bytes: 40, min_lines: 3 }],
  };
  await writeFile(join(projectDir, "solution", "evidence", "raw.md"), "让我先看一下资料。我来分析。接下来我将总结。我已经完成了。\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: evidenceNode });
  const report = await validateArtifactContract({ snapshot, node: evidenceNode, projectDir, deliverableType: "research" });

  const client = buildSmartFakeClient();
  const result = await materializeArtifacts({
    client,
    projectDir: projectDir,
    runDir,
    snapshot,
    report,
    node: evidenceNode,
    deliverableType: "research",
    instruction: "收集证据",
  });

  // evidence 不 materialize
  assert.equal(result.attempted, false);
  assert.ok(result.skipped_reason);
});
