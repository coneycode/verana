import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { parse as parseYaml } from "yaml";

import type { CapabilityNode, DeliverableContract, DeliverableType, GraphWorkflowSpec, OutputContract, VerdictRecord } from "./types.js";

export type ArtifactFailureCode =
  | "outputs_missing"
  | "output_path_unsafe"
  | "declared_output_missing"
  | "declared_output_empty"
  | "declared_output_too_small"
  | "artifact_looks_like_claim"
  | "artifact_looks_like_stream"
  | "artifact_looks_like_process_log"
  | "artifact_metadata_only"
  | "deliverable_structure_missing_section"
  | "deliverable_structure_forbidden_pattern"
  | "snapshot_write_failed";

export interface ArtifactFailure {
  code: ArtifactFailureCode;
  message: string;
  evidence?: string[];
}

export interface ArtifactSnapshotEntry {
  declared_path: string;
  snapshot_path: string;
  kind: "file" | "directory";
  exists: boolean;
  size_bytes: number;
  line_count?: number;
  sha256?: string;
  content_preview?: string;
}

export interface ArtifactSnapshot {
  run_id: string;
  node_id: string;
  root_dir: string;
  created_at: string;
  entries: ArtifactSnapshotEntry[];
}

export interface ArtifactOutputReport {
  declared_path: string;
  snapshot_path?: string;
  exists: boolean;
  is_file?: boolean;
  is_directory?: boolean;
  size_bytes?: number;
  line_count?: number;
  status: "passed" | "failed";
  failures: ArtifactFailure[];
}

export interface ArtifactReport {
  passed: boolean;
  run_id: string;
  node_id: string;
  checked_at: string;
  outputs: ArtifactOutputReport[];
  summary: {
    failure_class?: "F_artifact_contract_failure";
    message: string;
  };
}

const DEFAULT_MUST_NOT_LOOK_LIKE = ["claim", "stream", "process_log", "metadata_only"] as const;
const PROCESS_MARKERS = [
  "让我", "我来", "我已经", "我会", "现在", "接下来", "很好", "已完成", "获取到了", "收集了足够的信息", "我将", "我需要",
  "I will", "I have", "I'll", "Now I", "Let me", "I need to", "I've gathered", "Completed", "Done",
];
const CLAIM_MARKERS = ["已完成", "完成了", "文件已写入", "我已经", "I have completed", "completed the task", "done"];
const STREAM_MARKERS = ["Hermes Agent 输出", "LLM 输出", "执行中", "tool", "stdout", "stderr"];

const DELIVERABLE_TEMPLATES: Record<DeliverableType, DeliverableContract> = {
  research: {
    required_sections: ["产品概览", "主要发现", "结论与建议"],
    forbidden_patterns: ["思维记录", "调研过程", "我查了", "我看了", "我分析了", "让我先", "接下来我将"],
  },
  creative: {
    required_sections: ["正文"],
    forbidden_patterns: ["调研过程", "思维记录", "我查了", "我看了", "让我先", "接下来我将"],
    notes: ["创作类交付物应以正文为中心,不要把过程笔记冒充正文"],
  },
  implementation: {
    required_sections: ["问题", "方案", "实现细节", "验证"],
    forbidden_patterns: ["思维记录", "我查了", "我看了", "让我先", "接下来我将"],
  },
};

export function getDefaultDeliverableContract(deliverableType: DeliverableType): DeliverableContract {
  const template = DELIVERABLE_TEMPLATES[deliverableType];
  return {
    required_sections: [...template.required_sections],
    forbidden_patterns: [...template.forbidden_patterns],
    notes: template.notes ? [...template.notes] : undefined,
  };
}

export function renderDeliverableContract(contract: DeliverableContract): string {
  const lines = ["交付物结构要求:"];
  if (contract.required_sections.length > 0) {
    lines.push(`- 必需章节: ${contract.required_sections.join(" / ")}`);
  }
  if (contract.forbidden_patterns.length > 0) {
    lines.push(`- 禁止模式: ${contract.forbidden_patterns.join(" / ")}`);
  }
  for (const note of contract.notes ?? []) {
    lines.push(`- 备注: ${note}`);
  }
  return lines.join("\n");
}

export function getEffectiveDeliverableContract(deliverableType: DeliverableType, contractOverride?: Partial<DeliverableContract>): DeliverableContract {
  const base = getDefaultDeliverableContract(deliverableType);
  return {
    required_sections: contractOverride?.required_sections?.length ? [...contractOverride.required_sections] : base.required_sections,
    forbidden_patterns: contractOverride?.forbidden_patterns?.length ? [...contractOverride.forbidden_patterns] : base.forbidden_patterns,
    notes: contractOverride?.notes?.length ? [...contractOverride.notes] : base.notes,
  };
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function containsAny(source: string, terms: string[]): boolean {
  return terms.some((term) => source.includes(term));
}

function deriveResearchSections(source: string): string[] {
  const sections: string[] = [];
  if (containsAny(source, ["功能矩阵", "矩阵对比", "对比表格", "表格对比"])) sections.push("功能矩阵");
  if (containsAny(source, ["评测能力", "自动化测试", "效果评估", "评分体系"])) sections.push("评测3维");
  if (containsAny(source, ["可观测能力", "链路追踪", "日志", "指标监控", "告警", "流量回放", "Dashboard"])) sections.push("可观测5维");
  if (containsAny(source, ["优劣势", "定性描述", "分析对比", "差异分析"])) sections.push("优劣势分析");
  return sections;
}

export function getProjectDeliverableContract(spec: Pick<GraphWorkflowSpec, "goal" | "clarifications" | "hard_constraints"> & { deliverable_contract?: Partial<DeliverableContract> }): DeliverableContract {
  const base = getDefaultDeliverableContract(spec.goal.deliverable_type);
  const projectSource = [
    spec.goal.raw,
    spec.goal.clarified,
    ...spec.goal.acceptance,
    ...(spec.hard_constraints ?? []),
    ...(spec.clarifications ?? []).map((item) => `${item.q}\n${item.a}`),
  ].join("\n");
  const projectRequired = spec.goal.deliverable_type === "research" ? deriveResearchSections(projectSource) : [];
  const override = spec.deliverable_contract;
  const notes = uniqueStrings([...(base.notes ?? []), ...(override?.notes ?? [])]);

  return {
    required_sections: uniqueStrings([...base.required_sections, ...projectRequired, ...(override?.required_sections ?? [])]),
    forbidden_patterns: uniqueStrings([...base.forbidden_patterns, ...(override?.forbidden_patterns ?? [])]),
    notes: notes.length > 0 ? notes : undefined,
  };
}

export function validateDeliverableStructure(text: string, deliverableType: DeliverableType, contractOverride?: DeliverableContract): ArtifactFailure[] {
  const contract = getEffectiveDeliverableContract(deliverableType, contractOverride);
  const failures: ArtifactFailure[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  const headings = normalized.split("\n").map((line) => line.trim()).filter((line) => /^#{1,6}\s+/.test(line));

  for (const section of contract.required_sections) {
    if (!containsSection(headings, normalized, section)) {
      failures.push({ code: "deliverable_structure_missing_section", message: `missing required section: ${section}` });
    }
  }

  for (const pattern of contract.forbidden_patterns) {
    if (normalized.includes(pattern)) {
      failures.push({ code: "deliverable_structure_forbidden_pattern", message: `forbidden pattern found: ${pattern}` });
    }
  }

  return failures;
}

function containsSection(headings: string[], text: string, section: string): boolean {
  const headingMatches = headings.some((line) => line.includes(section));
  if (headingMatches) return true;
  return text.includes(section);
}

export function normalizeOutputContracts(node: CapabilityNode): OutputContract[] {
  const outputs = node.outputs ?? [];
  if (node.kind === "agent" && outputs.length === 0) {
    throw new Error(`agent node ${node.id} has no outputs (artifact contract required)`);
  }
  return outputs.map((output) => {
    const inferredFormat = inferFormat(output.path, output.format);
    const kind = output.kind ?? (inferredFormat === "directory" || output.path.endsWith("/") ? "directory" : "file");
    return {
      ...output,
      kind,
      role: output.role ?? "deliverable",
      required: output.required ?? true,
      materializable: output.materializable ?? output.role !== "evidence",
      min_bytes: output.min_bytes ?? (kind === "directory" ? 1 : 200),
      min_lines: output.min_lines ?? (inferredFormat === "json" || inferredFormat === "yaml" || kind === "directory" ? 0 : 5),
      format: inferredFormat,
      must_not_look_like: output.must_not_look_like ?? [...DEFAULT_MUST_NOT_LOOK_LIKE],
    };
  });
}

export function validateOutputPaths(projectDir: string, contracts: OutputContract[]): ArtifactFailure[] {
  const failures: ArtifactFailure[] = [];
  const root = normalize(projectDir);
  for (const contract of contracts) {
    const pathFailures = validateRelativeOutputPath(contract.path);
    failures.push(...pathFailures);
    const absolute = normalize(join(projectDir, contract.path));
    const rel = relative(root, absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      failures.push({ code: "output_path_unsafe", message: `output path escapes project root: ${contract.path}` });
    }
  }
  return failures;
}

export function validateRelativeOutputPath(path: string): ArtifactFailure[] {
  const failures: ArtifactFailure[] = [];
  const normalized = normalize(path);
  if (!path || path.includes("\0")) {
    failures.push({ code: "output_path_unsafe", message: `output path is empty or contains NUL: ${path}` });
  }
  if (isAbsolute(path)) {
    failures.push({ code: "output_path_unsafe", message: `output path must be relative: ${path}` });
  }
  if (normalized === ".." || normalized.startsWith(`..`)) {
    failures.push({ code: "output_path_unsafe", message: `output path escapes project root: ${path}` });
  }
  if (/^runs\/[^/]+\/(claim\.md|stream\.md|verdict\.yaml|artifact-report\.yaml)$/.test(normalized)) {
    failures.push({ code: "output_path_unsafe", message: `output path targets run internals: ${path}` });
  }
  return failures;
}

export async function collectArtifacts(args: {
  projectDir: string;
  runDir: string;
  runId: string;
  node: CapabilityNode;
}): Promise<ArtifactSnapshot> {
  const contracts = normalizeOutputContracts(args.node);
  const entries: ArtifactSnapshotEntry[] = [];
  await mkdir(join(args.runDir, "artifacts"), { recursive: true });

  for (const contract of contracts) {
    const sourcePath = join(args.projectDir, contract.path);
    const snapshotPath = join(args.runDir, "artifacts", normalize(contract.path));
    try {
      const sourceStat = await stat(sourcePath);
      await mkdir(dirname(snapshotPath), { recursive: true });
      if (sourceStat.isDirectory()) {
        await cp(sourcePath, snapshotPath, { recursive: true });
        entries.push({
          declared_path: contract.path,
          snapshot_path: snapshotPath,
          kind: "directory",
          exists: true,
          size_bytes: sourceStat.size,
        });
      } else {
        const content = await readFile(sourcePath);
        await writeFile(snapshotPath, content);
        const text = content.toString("utf8");
        entries.push({
          declared_path: contract.path,
          snapshot_path: snapshotPath,
          kind: "file",
          exists: true,
          size_bytes: content.byteLength,
          line_count: countLines(text),
          sha256: createHash("sha256").update(content).digest("hex"),
          content_preview: text.slice(0, 500),
        });
      }
    } catch {
      entries.push({
        declared_path: contract.path,
        snapshot_path: snapshotPath,
        kind: contract.kind ?? "file",
        exists: false,
        size_bytes: 0,
      });
    }
  }

  return {
    run_id: args.runId,
    node_id: args.node.id,
    root_dir: args.runDir,
    created_at: new Date().toISOString(),
    entries,
  };
}

export async function validateArtifactContract(args: {
  snapshot: ArtifactSnapshot;
  node: CapabilityNode;
  projectDir?: string;
  deliverableType?: DeliverableType;
  deliverableContract?: DeliverableContract;
}): Promise<ArtifactReport> {
  const outputs: ArtifactOutputReport[] = [];
  let pathFailures: ArtifactFailure[] = [];
  let contracts: OutputContract[];
  try {
    contracts = normalizeOutputContracts(args.node);
  } catch (error) {
    contracts = [];
    pathFailures = [{ code: "outputs_missing", message: (error as Error).message }];
  }
  if (args.projectDir) pathFailures.push(...validateOutputPaths(args.projectDir, contracts));
  if (contracts.length === 0 && pathFailures.length === 0) {
    pathFailures.push({ code: "outputs_missing", message: `node ${args.node.id} has no outputs` });
  }

  for (const contract of contracts) {
    const entry = args.snapshot.entries.find((e) => e.declared_path === contract.path);
    const failures: ArtifactFailure[] = [...validateRelativeOutputPath(contract.path)];
    if (!entry || !entry.exists) {
      if (contract.required !== false) failures.push({ code: "declared_output_missing", message: `declared output missing: ${contract.path}` });
      outputs.push({ declared_path: contract.path, snapshot_path: entry?.snapshot_path, exists: false, status: failures.length ? "failed" : "passed", failures });
      continue;
    }

    if (entry.kind === "directory") {
      const text = await readArtifactText(entry);
      const textBytes = Buffer.byteLength(text, "utf8");
      const lineCount = countLines(text);
      if (contract.required !== false && text.trim().length === 0) {
        failures.push({ code: "declared_output_empty", message: `declared output directory has no readable deliverable files: ${contract.path}` });
      }
      const minBytes = Math.max(contract.min_bytes ?? 200, 20);
      if (textBytes > 0 && textBytes < minBytes) {
        failures.push({ code: "declared_output_too_small", message: `declared output directory content is too small: ${contract.path} (${textBytes} bytes < ${minBytes})` });
      }
      if ((contract.min_lines ?? 0) > 0 && lineCount < (contract.min_lines ?? 0)) {
        failures.push({ code: "declared_output_too_small", message: `declared output directory content has too few lines: ${contract.path} (${lineCount} lines < ${contract.min_lines})` });
      }
      failures.push(...validateLookalikes(contract, text));
      if ((contract.role ?? "deliverable") === "deliverable" && args.deliverableType && text.trim()) {
        failures.push(...validateDeliverableStructure(text, args.deliverableType, args.deliverableContract));
      }
      outputs.push({
        declared_path: contract.path,
        snapshot_path: entry.snapshot_path,
        exists: true,
        is_directory: true,
        size_bytes: textBytes,
        line_count: lineCount,
        status: failures.length ? "failed" : "passed",
        failures,
      });
      continue;
    }

    const text = await readArtifactText(entry);
    if (entry.size_bytes === 0) {
      failures.push({ code: "declared_output_empty", message: `declared output is empty: ${contract.path}` });
    }
    const minBytes = Math.max(contract.min_bytes ?? 200, 20);
    if (entry.size_bytes > 0 && entry.size_bytes < minBytes) {
      failures.push({ code: "declared_output_too_small", message: `declared output is too small: ${contract.path} (${entry.size_bytes} bytes < ${minBytes})` });
    }
    if ((contract.min_lines ?? 0) > 0 && (entry.line_count ?? 0) < (contract.min_lines ?? 0)) {
      failures.push({ code: "declared_output_too_small", message: `declared output has too few lines: ${contract.path} (${entry.line_count ?? 0} lines < ${contract.min_lines})` });
    }
    failures.push(...validateFormat(contract, text));
    failures.push(...validateLookalikes(contract, text));
    if ((contract.role ?? "deliverable") === "deliverable" && args.deliverableType && text.trim()) {
      failures.push(...validateDeliverableStructure(text, args.deliverableType, args.deliverableContract));
    }

    outputs.push({
      declared_path: contract.path,
      snapshot_path: entry.snapshot_path,
      exists: true,
      is_file: true,
      size_bytes: entry.size_bytes,
      line_count: entry.line_count,
      status: failures.length ? "failed" : "passed",
      failures,
    });
  }

  if (pathFailures.length > 0) {
    outputs.unshift({ declared_path: "(outputs)", exists: false, status: "failed", failures: pathFailures });
  }

  const passed = outputs.length > 0 && outputs.every((output) => output.status === "passed");
  return {
    passed,
    run_id: args.snapshot.run_id,
    node_id: args.snapshot.node_id,
    checked_at: new Date().toISOString(),
    outputs,
    summary: {
      failure_class: passed ? undefined : "F_artifact_contract_failure",
      message: passed ? "artifact contract passed" : "declared outputs did not produce valid artifacts",
    },
  };
}

export function artifactFailureVerdict(report: ArtifactReport): VerdictRecord {
  const failures = report.outputs.flatMap((output) => output.failures.map((failure) => `${output.declared_path}: ${failure.message}`));
  const paths = report.outputs.map((output) => output.snapshot_path).filter((path): path is string => Boolean(path));
  return {
    passed: false,
    method: "artifact_contract",
    reasons: failures.length > 0 ? failures : [report.summary.message],
    evidence: report.outputs.flatMap((output) => output.failures.flatMap((failure) => failure.evidence ?? [])),
    artifact_report: `runs/${report.run_id}/artifact-report.yaml`,
    artifact_paths: paths,
    failure_class: "F_artifact_contract_failure",
  };
}

export async function renderArtifactForVerifier(snapshot: ArtifactSnapshot): Promise<string> {
  const parts = ["# Artifact Snapshot"];
  for (const entry of snapshot.entries) {
    parts.push(`\n## ${entry.declared_path}\n`);
    if (!entry.exists) {
      parts.push("(missing)");
      continue;
    }
    if (entry.kind === "directory") {
      const text = await readArtifactText(entry);
      parts.push(text.trim() ? text : `(directory snapshot has no readable deliverable files: ${entry.snapshot_path})`);
      continue;
    }
    parts.push(await readFile(entry.snapshot_path, "utf8"));
  }
  return parts.join("\n");
}

function inferFormat(path: string, format?: OutputContract["format"]): OutputContract["format"] {
  if (format) return format;
  if (path.endsWith("/")) return "directory";
  if (path.endsWith(".md") || path.endsWith(".markdown")) return "markdown";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "yaml";
  return "text";
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r?\n/).length;
}

function validateFormat(contract: OutputContract, text: string): ArtifactFailure[] {
  try {
    if (contract.format === "json") JSON.parse(text);
    if (contract.format === "yaml") parseYaml(text);
    return [];
  } catch (error) {
    return [{ code: "declared_output_too_small", message: `${contract.path} does not parse as ${contract.format}: ${(error as Error).message}` }];
  }
}

async function readArtifactText(entry: ArtifactSnapshotEntry): Promise<string> {
  if (!entry.exists) return "";
  if (entry.kind !== "directory") return readFile(entry.snapshot_path, "utf8").catch(() => "");
  return readMarkdownDirectory(entry.snapshot_path);
}

async function readMarkdownDirectory(dir: string): Promise<string> {
  const parts: string[] = [];
  const names = await readdir(dir).catch(() => []);
  for (const name of names.sort()) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      const nested = await readMarkdownDirectory(path);
      if (nested.trim()) parts.push(nested);
      continue;
    }
    if (/\.(md|markdown|txt)$/i.test(name)) {
      parts.push(await readFile(path, "utf8").catch(() => ""));
    }
  }
  return parts.join("\n\n");
}

function validateLookalikes(contract: OutputContract, text: string): ArtifactFailure[] {
  const checks = contract.must_not_look_like ?? [...DEFAULT_MUST_NOT_LOOK_LIKE];
  const failures: ArtifactFailure[] = [];
  if (checks.includes("process_log") && looksLikeProcessLog(text)) {
    failures.push({ code: "artifact_looks_like_process_log", message: "内容高比例是执行过程自述,不像正式正文", evidence: sampleMarkerLines(text, PROCESS_MARKERS) });
  }
  if (checks.includes("claim") && looksLikeClaim(text)) {
    failures.push({ code: "artifact_looks_like_claim", message: "内容像 agent 完成自述而不是交付物正文", evidence: sampleMarkerLines(text, CLAIM_MARKERS) });
  }
  if (checks.includes("stream") && looksLikeStream(text)) {
    failures.push({ code: "artifact_looks_like_stream", message: "内容像 executor stream/log 输出", evidence: sampleMarkerLines(text, STREAM_MARKERS) });
  }
  if (checks.includes("metadata_only") && looksMetadataOnly(text)) {
    failures.push({ code: "artifact_metadata_only", message: "内容只有路径/行数/完成摘要等元数据,没有正文" });
  }
  return failures;
}

function looksLikeProcessLog(text: string): boolean {
  const lines = meaningfulLines(text).slice(0, 80);
  if (lines.length === 0) return false;
  const marked = lines.filter((line) => hasMarker(line, PROCESS_MARKERS)).length;
  const firstTenMarked = lines.slice(0, 10).filter((line) => hasMarker(line, PROCESS_MARKERS)).length;
  return marked / lines.length >= 0.25 || firstTenMarked >= 3;
}

function looksLikeClaim(text: string): boolean {
  const lines = meaningfulLines(text).slice(0, 40);
  if (lines.length === 0) return false;
  return lines.filter((line) => hasMarker(line, CLAIM_MARKERS)).length >= 2 && !hasBodyShape(lines);
}

function looksLikeStream(text: string): boolean {
  return sampleMarkerLines(text, STREAM_MARKERS).length >= 2;
}

function looksMetadataOnly(text: string): boolean {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return false;
  const metadataLines = lines.filter((line) => /(?:文件|路径|行数|大小|bytes|lines|created|written|包含|统计|summary)/i.test(line)).length;
  return lines.length <= 12 && metadataLines / lines.length >= 0.5 && !hasBodyShape(lines);
}

function meaningfulLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function hasMarker(line: string, markers: readonly string[]): boolean {
  const lower = line.toLowerCase();
  return markers.some((marker) => lower.includes(marker.toLowerCase()));
}

function sampleMarkerLines(text: string, markers: readonly string[]): string[] {
  return meaningfulLines(text).filter((line) => hasMarker(line, markers)).slice(0, 5);
}

function hasBodyShape(lines: string[]): boolean {
  const bodyLines = lines.filter((line) => line.length > 30 && !/^#/.test(line) && !/^(?:[-*]|\d+\.)\s/.test(line));
  const listLines = lines.filter((line) => /^(?:[-*]|\d+\.)\s+\S/.test(line));
  return bodyLines.length >= 2 || listLines.length >= 3;
}
