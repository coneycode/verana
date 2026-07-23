import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

import type { LlmClient } from "./llm.js";
import type { CapabilityNode, DeliverableContract, DeliverableType, OutputContract } from "./types.js";
import {
  type ArtifactReport,
  type ArtifactSnapshot,
  getEffectiveDeliverableContract,
  normalizeOutputContracts,
  renderArtifactForVerifier,
  renderDeliverableContract,
  validateRelativeOutputPath,
} from "./artifacts.js";

const MATERIALIZABLE_FAILURES = new Set([
  "declared_output_missing",
  "declared_output_empty",
  "declared_output_too_small",
  "artifact_looks_like_claim",
  "artifact_looks_like_stream",
  "artifact_looks_like_process_log",
  "artifact_metadata_only",
  "deliverable_structure_missing_section",
  "deliverable_structure_forbidden_pattern",
]);

const MATERIALIZER_SYSTEM = `你是 artifact materializer。你的职责是把执行器留下的证据、claim、stream 或坏 artifact 整理成正式交付物文件。

返回 JSON:
{"artifacts":[{"path":"声明 output 路径","content":"完整 Markdown 正文","reason":"为什么可以生成"}],"skipped_reason":"如果不能生成,说明原因"}

规则:
- 只能使用输入中已有事实、来源、页面信息和证据,不得编造。
- 如果证据不足以支撑正式正文,返回 artifacts=[] 并说明 skipped_reason。
- content 必须是正式交付物正文,不能包含执行过程、工具日志、claim、自述或“我将/我已经/让我”等过程表达。
- 必须满足给定交付物结构要求。
- 只为列出的声明 output 路径生成内容。
- 用中文。`;

export interface MaterializationReport {
  attempted: boolean;
  passed: boolean;
  run_id: string;
  node_id: string;
  targets: string[];
  written: string[];
  skipped_reason?: string;
  source_summary: string[];
}

interface MaterializerResult {
  artifacts?: Array<{ path: string; content: string; reason?: string }>;
  skipped_reason?: string;
}

export function isMaterializableReport(report: ArtifactReport, outputs: OutputContract[]): boolean {
  const outputByPath = new Map(outputs.map((output) => [output.path, output]));
  return report.outputs.some((output) => {
    const contract = outputByPath.get(output.declared_path);
    if (!contract || contract.materializable === false || (contract.role ?? "deliverable") !== "deliverable") return false;
    return output.failures.some((failure) => MATERIALIZABLE_FAILURES.has(failure.code));
  });
}

export async function materializeArtifacts(args: {
  client: LlmClient;
  projectDir: string;
  runDir: string;
  snapshot: ArtifactSnapshot;
  report: ArtifactReport;
  node: CapabilityNode;
  deliverableType: DeliverableType;
  deliverableContract?: DeliverableContract;
  instruction: string;
}): Promise<MaterializationReport> {
  const outputs = normalizeOutputContracts(args.node);
  const targets = outputs.filter((output) => output.materializable !== false && (output.role ?? "deliverable") === "deliverable");
  const baseReport: MaterializationReport = {
    attempted: false,
    passed: false,
    run_id: args.snapshot.run_id,
    node_id: args.snapshot.node_id,
    targets: targets.map((target) => target.path),
    written: [],
    source_summary: ["claim.md", "stream.md", "artifact snapshot", "node inputs"],
  };

  if (!targets.length || !isMaterializableReport(args.report, outputs)) {
    return { ...baseReport, skipped_reason: "no materializable deliverable outputs or failures" };
  }

  const claim = await readFile(join(args.runDir, "claim.md"), "utf8").catch(() => "");
  const stream = await readFile(join(args.runDir, "stream.md"), "utf8").catch(() => "");
  const artifactSnapshot = await renderArtifactForVerifier(args.snapshot).catch(() => "");
  const inputContents = await readNodeInputs(args.projectDir, args.node);
  const contract = getEffectiveDeliverableContract(args.deliverableType, args.deliverableContract);

  const userPrompt = [
    `项目交付物类型: ${args.deliverableType}`,
    renderDeliverableContract(contract),
    "",
    "声明 output 目标:",
    ...targets.map((target) => `- ${target.path}: ${target.desc}`),
    "",
    "本次 artifact contract 失败:",
    stringify(args.report),
    "",
    "执行指令:",
    args.instruction.slice(0, 3000),
    "",
    "节点输入证据:",
    inputContents.slice(0, 6000) || "(无)",
    "",
    "Artifact Snapshot / 坏 artifact:",
    artifactSnapshot.slice(0, 8000) || "(无)",
    "",
    "Claim:",
    claim.slice(0, 4000) || "(无)",
    "",
    "Stream 摘要:",
    stream.slice(-6000) || "(无)",
    "",
    "请仅在证据足够时生成正式 Markdown artifact。",
  ].join("\n");

  const result = await args.client.completeJson<MaterializerResult>("evaluator", MATERIALIZER_SYSTEM, userPrompt);
  const allowed = new Set(targets.map((target) => target.path));
  const written: string[] = [];
  for (const artifact of result.artifacts ?? []) {
    if (!allowed.has(artifact.path) || !artifact.content?.trim()) continue;
    if (validateRelativeOutputPath(artifact.path).length > 0) continue;
    const target = join(args.projectDir, artifact.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.content.trim() + "\n", "utf8");
    written.push(artifact.path);
  }

  return {
    ...baseReport,
    attempted: true,
    passed: written.length > 0,
    written,
    skipped_reason: written.length > 0 ? undefined : (result.skipped_reason ?? "materializer produced no valid artifacts"),
  };
}

async function readNodeInputs(projectDir: string, node: CapabilityNode): Promise<string> {
  const parts: string[] = [];
  for (const input of node.inputs ?? []) {
    if (!input.path) continue;
    const content = await readFile(join(projectDir, input.path), "utf8").catch(() => "");
    if (content.trim()) parts.push(`--- ${input.path} ---\n${content}`);
  }
  return parts.join("\n\n");
}
