import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";

import { HttpLlmClient, loadConfig, type LlmClient } from "./llm.js";
import { planGraphWorkflow } from "./pipeline.js";
import { approveGate, createProject, getProject, listProjects, projectPath, rejectGate } from "./project-store.js";

export type Output = (line: string) => void;

export async function runCli(argv: string[], output: Output = console.log, client?: LlmClient): Promise<void> {
  const { command, args, root } = parseArgs(argv);
  const llm = client ?? new HttpLlmClient(await loadConfig(root));

  if (command === "new") {
    const goal = args.join(" ").trim();
    if (!goal) throw new Error("Usage: verana new <goal>");
    const project = await createProject(root, goal);
    output(`created ${project.id}`);
    output(`status ${project.status}`);
    return;
  }

  if (command === "list") {
    const projects = await listProjects(root);
    for (const project of projects) output(`${project.id}\t${project.status}\t${project.goal}`);
    return;
  }

  const projectId = args[0];
  if (!projectId) throw new Error(`Usage: verana ${command} <project-id>`);

  if (command === "approve") {
    const gateId = args[1];
    if (!gateId) throw new Error("Usage: verana approve <project-id> <gate-id>");
    await approveGate(root, projectId, gateId, optionValue(argv, "--note") ?? "");
    output(`approved ${gateId}`);
    return;
  }

  if (command === "reject") {
    const gateId = args[1];
    if (!gateId) throw new Error("Usage: verana reject <project-id> <gate-id>");
    await rejectGate(root, projectId, gateId, optionValue(argv, "--note") ?? "rejected");
    output(`rejected ${gateId}`);
    return;
  }

  if (command === "plan") {
    await planGraphWorkflow(root, projectId, llm);
    output("planned solution workflow");
    return;
  }

  if (command === "run") {
    const { runGraphProject } = await import("./graph-engine.js");
    await runGraphProject(root, projectId, llm);
    const state = await getProject(root, projectId);
    const wf = state.status.workflows.solution;
    output(`${state.status.active_workflow}: ${wf?.workflow_status ?? "unknown"}`);
    if (wf?.awaiting === "human") output(`awaiting_human: ${wf.awaiting_scene} — ${wf.awaiting_reason}`);
    return;
  }

  if (command === "status") {
    const state = await getProject(root, projectId);
    output(`${state.project.id}: ${state.project.status}`);
    const solution = state.status.workflows.solution;
    if (solution) {
      output(`solution: ${solution.workflow_status}`);
      output(`iteration: ${solution.iteration}, current_node: ${solution.current_node ?? "-"}`);
      if (solution.awaiting === "human") output(`awaiting_human: ${solution.awaiting_scene} — ${solution.awaiting_reason}`);
    }
    return;
  }

  if (command === "logs") {
    const runId = args[1];
    if (!runId) throw new Error("Usage: verana logs <project-id> <run-id>");
    const verdict = parse(await readFile(join(projectPath(root, projectId), "runs", runId, "verdict.yaml"), "utf8").catch(() => "passed: false"));
    output(`verdict: ${verdict.passed ? "passed" : "failed"}`);
    return;
  }

  if (command === "input") {
    output("批量澄清请通过 Web UI 操作(http://localhost:8787)");
    return;
  }

  if (command === "clarify") {
    const state = await getProject(root, projectId);
    const batch = state.status.clarifier?.pending_batch;
    if (batch && batch.length > 0) {
      for (const q of batch) {
        output(`[${q.dimension}] ${q.question}`);
        output(`  risk: ${q.risk}`);
      }
    } else {
      output("no pending questions (clarification may be complete)");
    }
    return;
  }

  if (command === "cancel") {
    await rejectGate(root, projectId, "cancel", "user cancelled");
    output("cancelled");
    return;
  }

  output(`unknown command: ${command}`);
  output(USAGE);
}

const USAGE = `verana new|list|clarify|plan|status|approve|reject|run|logs|input|cancel`;

function parseArgs(argv: string[]): { command: string; args: string[]; root: string } {
  const rootIdx = argv.indexOf("--root");
  const root = resolve(rootIdx >= 0 ? argv[rootIdx + 1] ?? "." : ".");
  // 兼容有/无 node 前缀:跳过前两个非 flag 参数(可能是 node + script),取第一个作为 command
  const cleaned = argv.filter((a) => a !== "--root" && a !== (rootIdx >= 0 ? argv[rootIdx + 1] : "__none__"));
  const startIdx = cleaned[0] === process.argv[0] || cleaned[0]?.endsWith("node") || cleaned[0]?.endsWith(".js") ? 1 : 0;
  const realArgs = cleaned.slice(startIdx).filter((a) => !a.startsWith("--"));
  const command = realArgs[0] ?? "";
  const args = realArgs.slice(1);
  return { command, args, root };
}

function optionValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}
