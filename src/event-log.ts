import { appendFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventEntry, SnapshotRecord } from "./types.js";

export async function appendEvent(solutionDir: string, entry: Omit<EventEntry, "seq" | "ts">): Promise<EventEntry> {
  const logPath = join(solutionDir, "events.log");
  const seq = await nextSeq(solutionDir);
  const full: EventEntry = { ...entry, seq, ts: new Date().toISOString() };
  await mkdir(solutionDir, { recursive: true });
  await appendFile(logPath, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export async function readEvents(solutionDir: string, afterSeq = 0): Promise<EventEntry[]> {
  const logPath = join(solutionDir, "events.log");
  let raw: string;
  try {
    raw = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  return raw.trim().split("\n")
    .map((line) => JSON.parse(line) as EventEntry)
    .filter((e) => e.seq > afterSeq);
}

export async function nextSeq(solutionDir: string): Promise<number> {
  const events = await readEvents(solutionDir, 0);
  return events.length === 0 ? 1 : (events[events.length - 1].seq + 1);
}

export async function writeSnapshot(solutionDir: string, snap: Omit<SnapshotRecord, "ts">): Promise<SnapshotRecord> {
  const dir = join(solutionDir, "snapshots");
  await mkdir(dir, { recursive: true });
  const full: SnapshotRecord = { ...snap, ts: new Date().toISOString() };
  await writeFile(join(dir, `snap-${String(snap.seq).padStart(6, "0")}.json`), JSON.stringify(full, null, 2), "utf8");
  await writeFile(join(solutionDir, "blackboard.yaml"), asYaml(full.blackboard), "utf8");
  return full;
}

export async function readLatestSnapshot(solutionDir: string): Promise<SnapshotRecord | null> {
  const dir = join(solutionDir, "snapshots");
  let files: string[];
  try {
    files = await (await import("node:fs/promises")).readdir(dir);
  } catch {
    return null;
  }
  const snaps = files.filter(f => f.startsWith("snap-")).sort();
  if (snaps.length === 0) return null;
  const latest = snaps[snaps.length - 1];
  return JSON.parse(await readFile(join(dir, latest), "utf8")) as SnapshotRecord;
}

function asYaml(obj: Record<string, unknown>, indent = 0): string {
  const sp = " ".repeat(indent);
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      lines.push(`${sp}${k}:`);
      lines.push(asYaml(v as Record<string, unknown>, indent + 2));
    } else if (Array.isArray(v)) {
      lines.push(`${sp}${k}:`);
      for (const item of v) {
        lines.push(`${sp}  - ${typeof item === "string" ? item : JSON.stringify(item)}`);
      }
    } else {
      lines.push(`${sp}${k}: ${v === null || v === undefined ? "null" : JSON.stringify(v)}`);
    }
  }
  return lines.join("\n");
}

/**
 * 生成进度真相摘要(喂给 scheduler)。
 * 从事件日志提取"带 verdict 的执行轨迹",机械折叠:
 * - 早期折叠:超过阈值的旧记录按"节点名×verdict通过次数"聚合
 * - 近期明细:保留最近 N 条(节点+run+verdict+简短理由)
 * - 进度信号:各节点通过次数汇总
 *
 * 不用 LLM,纯代码机械聚合(确定、可复现、不花钱)。
 */
export async function buildProgressTruth(solutionDir: string, recentN = 6, foldThreshold = 10): Promise<string> {
  const events = await readEvents(solutionDir, 0);
  // 提取 verdict + diagnosis 事件,构成"已验证的执行轨迹"
  const verdictEvents = events.filter(e => e.type === "verdict");
  const diagnosisEvents = events.filter(e => e.type === "diagnosis");
  if (verdictEvents.length === 0) {
    return "【进度真相】(尚无已验证节点,这是第一步)";
  }

  // 构建轨迹条目:每条 = {node, runId, passed, reason, rootCause}
  const trail: Array<{ node: string; runId: string; passed: boolean; reason: string; rootCause?: string }> = [];
  for (const e of verdictEvents) {
    const passed = e.data?.passed === true || e.data?.passed === "true";
    const runId = e.run_id ?? e.data?.run_id ?? "?";
    const reason = (e.reason ?? "").slice(0, 80);
    // 查对应的归因(同 run_id)
    const diag = diagnosisEvents.find(d => d.run_id === e.run_id);
    trail.push({
      node: e.node ?? "?", runId: String(runId), passed, reason,
      rootCause: diag ? `${diag.data?.root_cause}: ${(diag.data?.explanation as string ?? "").slice(0, 60)}` : undefined,
    });
  }

  // 计算各节点通过次数(进度信号)
  const passCounts: Record<string, number> = {};
  for (const t of trail) {
    if (t.passed) passCounts[t.node] = (passCounts[t.node] ?? 0) + 1;
  }

  const lines: string[] = ["【进度真相 — 带 verdict 的执行轨迹】"];

  // 早期折叠
  if (trail.length > foldThreshold) {
    const early = trail.slice(0, trail.length - recentN);
    const folded: Record<string, { pass: number; fail: number }> = {};
    for (const t of early) {
      if (!folded[t.node]) folded[t.node] = { pass: 0, fail: 0 };
      if (t.passed) folded[t.node].pass++; else folded[t.node].fail++;
    }
    const parts = Object.entries(folded).map(([node, c]) => `${node}×${c.pass}✓${c.fail > 0 ? `×${c.fail}✗` : ""}`);
    lines.push(`早期(已折叠): ${parts.join(" | ")}`);
  }

  // 近期明细
  const recent = trail.slice(-recentN);
  if (recent.length > 0) {
    lines.push("近期明细:");
    for (const t of recent) {
      const rc = t.rootCause ? ` [根因:${t.rootCause}]` : "";
      lines.push(`  - ${t.node} (${t.runId}) ${t.passed ? "passed" : "FAILED"} — ${t.reason}${rc}`);
    }
  }

  // 进度信号
  const sigParts = Object.entries(passCounts).map(([node, n]) => `${node} 已通过 ${n} 次`);
  if (sigParts.length > 0) {
    lines.push(`【进度信号】${sigParts.join("; ")}`);
  }

  return lines.join("\n");
}
