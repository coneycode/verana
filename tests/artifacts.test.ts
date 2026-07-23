import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { artifactFailureVerdict, collectArtifacts, getProjectDeliverableContract, renderArtifactForVerifier, validateArtifactContract, validateDeliverableStructure } from "../src/artifacts.js";
import type { CapabilityNode } from "../src/types.js";
import { validateGraphWorkflow } from "../src/workflow-validator.js";

const agentNode: CapabilityNode = {
  id: "write_report",
  kind: "agent",
  desc: "写报告",
  outputs: [{ path: "solution/report.md", desc: "报告正文", min_bytes: 40, min_lines: 3 }],
  checks: [{ method: "llm_rubric", desc: "内容完整" }],
};

test("workflow validator requires outputs for agent nodes", () => {
  const spec = baseSpec([{ ...agentNode, outputs: undefined }]);
  const result = validateGraphWorkflow(spec);
  assert.equal(result.passed, false);
  assert.equal(result.errors.some((e) => e.includes("artifact contract required")), true);
});

test("workflow validator rejects unsafe and duplicate output paths", () => {
  const spec = baseSpec([{ ...agentNode, outputs: [
    { path: "../escape.md", desc: "bad" },
    { path: "../escape.md", desc: "bad again" },
  ] }]);
  const result = validateGraphWorkflow(spec);
  assert.equal(result.passed, false);
  assert.equal(result.errors.some((e) => e.includes("duplicate output path")), true);
  assert.equal(result.errors.some((e) => e.includes("escapes project root")), true);
});

test("artifact collector freezes declared output snapshot", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const source = join(projectDir, "solution", "report.md");
  await mkdir(join(projectDir, "solution"), { recursive: true });
  await writeFile(source, "# 报告\n\n这是正式正文。\n\n- 来源 A\n- 来源 B\n- 来源 C\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].exists, true);
  await writeFile(source, "mutated", "utf8");
  const frozen = await readFile(snapshot.entries[0].snapshot_path, "utf8");
  assert.match(frozen, /这是正式正文/);
  assert.doesNotMatch(frozen, /mutated/);
});

test("deliverable structure validator keeps generic research defaults separate from project-specific contracts", () => {
  const badResearch = "# 调研笔记\n\n## 产品概览\n\n让我先看一下资料。";
  const researchFailures = validateDeliverableStructure(badResearch, "research");
  assert.equal(researchFailures.some((f) => f.code === "deliverable_structure_missing_section"), true);
  assert.equal(researchFailures.some((f) => f.message.includes("主要发现")), true);

  const projectContract = getProjectDeliverableContract({
    goal: {
      raw: "竞品对比",
      clarified: "竞品对比",
      deliverable_type: "research",
      iterative: false,
      acceptance: [
        "评测能力包含自动化测试、效果评估、评分体系",
        "可观测能力包含链路追踪、日志、指标监控、告警、流量回放",
        "包含功能有无/支持程度的结构化功能矩阵表格",
      ],
    },
    clarifications: [],
    hard_constraints: ["必须客观呈现各产品能力现状"],
    deliverable_contract: undefined,
  });
  assert.equal(projectContract.required_sections.includes("评测3维"), true);
  assert.equal(projectContract.required_sections.includes("可观测5维"), true);
  assert.equal(projectContract.required_sections.includes("功能矩阵"), true);

  const creativeFailures = validateDeliverableStructure("# 小说章节\n\n## 正文\n\n夜色压下来,街角的灯忽明忽暗。", "creative");
  assert.equal(creativeFailures.length, 0);

  const implementationFailures = validateDeliverableStructure("# 修复记录\n\n## 问题\n\n缺少校验。\n\n## 方案\n\n加入结构契约。", "implementation");
  assert.equal(implementationFailures.some((f) => f.message.includes("实现细节")), true);
  assert.equal(implementationFailures.some((f) => f.message.includes("验证")), true);
});

test("artifact validator applies deliverable structure contract", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const source = join(projectDir, "solution", "report.md");
  await mkdir(join(projectDir, "solution"), { recursive: true });
  await writeFile(source, "# 调研报告\n\n## 产品概览\n\n让我先说明我查了哪些资料。\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const report = await validateArtifactContract({ snapshot, node: agentNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, false);
  assert.equal(report.outputs.some((o) => o.failures.some((f) => f.code === "deliverable_structure_missing_section")), true);
  assert.equal(report.outputs.some((o) => o.failures.some((f) => f.code === "deliverable_structure_forbidden_pattern")), true);
});

test("artifact validator validates and renders directory deliverable contents", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const dirNode: CapabilityNode = {
    ...agentNode,
    outputs: [{ path: "solution/research/", desc: "调研目录", min_bytes: 80, min_lines: 5 }],
  };
  await mkdir(join(projectDir, "solution", "research"), { recursive: true });
  await writeFile(join(projectDir, "solution", "research", "report.md"), "# 调研报告\n\n## 产品概览\n\n这是正式正文。\n\n## 主要发现\n\n这里总结关键观察。\n\n- 观察一\n- 观察二\n- 观察三\n\n## 评测3维\n\n自动化测试、效果评估、评分体系。\n\n## 可观测5维\n\n链路追踪、日志、指标、告警、Dashboard。\n\n## 结论与建议\n\n继续推进。\n", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: dirNode });
  const report = await validateArtifactContract({ snapshot, node: dirNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, true);
  assert.equal(report.outputs[0].status, "passed");

  const rendered = await renderArtifactForVerifier(snapshot);
  assert.match(rendered, /## 产品概览/);
  assert.match(rendered, /## 评测3维/);
  assert.doesNotMatch(rendered, /directory snapshot:/);
});

test("artifact validator does not apply final deliverable structure to evidence outputs", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const evidenceNode: CapabilityNode = {
    ...agentNode,
    outputs: [{ path: "solution/evidence/raw_findings.md", desc: "原始证据", role: "evidence", materializable: false, min_bytes: 40, min_lines: 3 }],
  };
  await mkdir(join(projectDir, "solution", "evidence"), { recursive: true });
  await writeFile(join(projectDir, "solution", "evidence", "raw_findings.md"), `产品A: 支持自动化测试。
来源: https://example.com/a
产品B: 仅有日志。
`, "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: evidenceNode });
  const report = await validateArtifactContract({ snapshot, node: evidenceNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, true);
  assert.equal(report.outputs.some((o) => o.failures.some((f) => f.code === "deliverable_structure_missing_section")), false);
});

test("artifact validator rejects directory outputs without readable deliverables", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const dirNode: CapabilityNode = {
    ...agentNode,
    outputs: [{ path: "solution/research/", desc: "调研目录", min_bytes: 80, min_lines: 5 }],
  };
  await mkdir(join(projectDir, "solution", "research"), { recursive: true });
  await writeFile(join(projectDir, "solution", "research", "metadata.json"), "{\"done\":true}", "utf8");

  const snapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: dirNode });
  const report = await validateArtifactContract({ snapshot, node: dirNode, projectDir, deliverableType: "research" });
  assert.equal(report.passed, false);
  assert.equal(report.outputs.some((o) => o.failures.some((f) => f.code === "declared_output_empty")), true);
});

test("artifact validator detects missing and process-log artifacts", async () => {
  const projectDir = await mkdtemp(join(tmpdir(), "verana-artifact-"));
  const runDir = join(projectDir, "runs", "run-0001");
  const missingSnapshot = await collectArtifacts({ projectDir, runDir, runId: "run-0001", node: agentNode });
  const missingReport = await validateArtifactContract({ snapshot: missingSnapshot, node: agentNode, projectDir });
  assert.equal(missingReport.passed, false);
  assert.equal(missingReport.outputs.some((o) => o.failures.some((f) => f.code === "declared_output_missing")), true);

  const source = join(projectDir, "solution", "report.md");
  await mkdir(join(projectDir, "solution"), { recursive: true });
  await writeFile(source, "让我先查看资料。\n很好,获取到了信息。\n现在我来整理。\n已完成并写入文件。\n接下来说明结果。\n", "utf8");
  const logSnapshot = await collectArtifacts({ projectDir, runDir: join(projectDir, "runs", "run-0002"), runId: "run-0002", node: agentNode });
  const logReport = await validateArtifactContract({ snapshot: logSnapshot, node: agentNode, projectDir });
  assert.equal(logReport.passed, false);
  assert.equal(logReport.outputs.some((o) => o.failures.some((f) => f.code === "artifact_looks_like_process_log")), true);
  assert.equal(artifactFailureVerdict(logReport).failure_class, "F_artifact_contract_failure");
});

function baseSpec(capabilities: CapabilityNode[]) {
  return {
    version: "0.2" as const,
    project_id: "p",
    phase: "solution" as const,
    flow_type: "graph" as const,
    goal: { raw: "raw", clarified: "clarified", deliverable_type: "research" as const, iterative: false, acceptance: ["done"] },
    clarifications: [],
    required_capabilities: [],
    selected_executor: "fake",
    agents: [],
    skills: [],
    scripts: [],
    capabilities,
    guardrails: { hard: { max_iterations: 3 }, soft: [] },
    blackboard_schema: { fields: [{ key: "summary", desc: "summary", bounded: false }] },
    entry_node: capabilities[0]?.id ?? "missing",
    completion_criteria: ["done"],
    hard_constraints: [],
    soft_guidance: [],
    policies: { long_running: { idle_watchdog: "1m", max_wall: "5m" }, on_failure: "diagnose" },
  };
}
