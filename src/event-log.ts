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
