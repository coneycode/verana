import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";

import { appendClarification, buildGoalSummary, nextClarificationQuestion } from "./clarifier.js";
import { HttpLlmClient, loadConfig, type LlmClient } from "./llm.js";
import { approveGate, createProject, getProject, listProjects, projectPath, rejectGate, saveProjectState } from "./project-store.js";
import { composeSolutionWorkflow, runProject } from "./pipeline.js";

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

  if (command === "plan") {
    const workflow = await composeSolutionWorkflow(root, projectId, llm);
    output(`${workflow.phase}: plan_review`);
    output(`executor: ${workflow.selected_executor}`);
    output(`tasks: ${workflow.tasks.map((task) => task.id).join(",")}`);
    return;
  }

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

  if (command === "run") {
    await runProject(root, projectId, llm);
    const state = await getProject(root, projectId);
    output(`${state.status.active_workflow}: ${state.status.workflows.solution?.status ?? "unknown"}`);
    return;
  }

  if (command === "status") {
    const state = await getProject(root, projectId);
    output(`${state.project.id}: ${state.project.status}`);
    const solution = state.status.workflows.solution;
    if (solution) output(`solution: ${solution.status}`);
    if (state.status.awaiting_input) output(`awaiting_input: ${state.status.awaiting_input}`);
    return;
  }

  if (command === "logs") {
    const runId = args[1];
    if (!runId) throw new Error("Usage: verana logs <project-id> <run-id>");
    const verdict = parse(await readFile(join(projectPath(root, projectId), "runs", runId, "verdict.yaml"), "utf8"));
    output(`verdict: ${verdict.passed ? "passed" : "failed"}`);
    return;
  }

  if (command === "input") {
    const answer = args.slice(1).join(" ").trim();
    if (!answer) throw new Error("Usage: verana input <project-id> <answer>");
    const state = appendClarification(await getProject(root, projectId), answer, await nextClarificationQuestion(await getProject(root, projectId), llm));
    await saveProjectState(root, state);
    output("input recorded");
    const next = await nextClarificationQuestion(state, llm);
    output(next ? `next_question: ${next.question}` : "goal_ready");
    return;
  }

  if (command === "cancel") {
    const state = await getProject(root, projectId);
    state.project.status = "cancelled";
    await saveProjectState(root, state);
    output(`cancelled ${projectId}`);
    return;
  }

  if (command === "clarify") {
    const state = await getProject(root, projectId);
    const question = await nextClarificationQuestion(state, llm);
    if (!question) {
      output(buildGoalSummary(state));
      return;
    }
    output(`question: ${question.question}`);
    output(`risk: ${question.risk}`);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function parseArgs(argv: string[]): { command: string; args: string[]; root: string } {
  const root = resolve(optionValue(argv, "--root") ?? process.cwd());
  const filtered = argv.filter((arg, index) => {
    if (arg === "--root" || arg === "--note") return false;
    if (argv[index - 1] === "--root" || argv[index - 1] === "--note") return false;
    return true;
  });
  const [command = "", ...args] = filtered;
  return { command, args, root };
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
