import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { appendClarification, buildGoalSummary, nextClarificationQuestion } from "./clarifier.js";
import { EventBus, projectEvent } from "./events.js";
import { HttpLlmClient, loadConfig, type LlmClient } from "./llm.js";
import { approveGate, getProject, listProjects, projectPath, rejectGate, saveProjectState } from "./project-store.js";
import { composeSolutionWorkflow, runProject } from "./pipeline.js";
import { renderHomePage } from "./web.js";

export interface ServerOptions {
  rootDir: string;
  bus?: EventBus;
  client?: LlmClient;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); }
    catch (err) { done(err as Error, undefined); }
  });
  const bus = options.bus ?? new EventBus();
  const client = options.client ?? new HttpLlmClient(await loadConfig());

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return renderHomePage();
  });

  app.get("/projects", async () => listProjects(options.rootDir));

  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => getProject(options.rootDir, request.params.id));

  app.get<{ Params: { id: string } }>("/projects/:id/clarify", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    if (state.status.clarifier?.current_question) {
      return state.status.clarifier.current_question;
    }
    const question = await nextClarificationQuestion(state, client);
    return question ?? { summary: buildGoalSummary(state) };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/clarify", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    // If we already have a current question, don't call LLM again (avoid 429 + question changing)
    if (state.status.clarifier?.current_question) {
      return state.status.clarifier.current_question;
    }
    const question = await nextClarificationQuestion(state, client);
    if (question && !state.status.clarifier) {
      state.status.clarifier = { status: "clarifying", clarifications: [], current_question: question };
      await saveProjectState(options.rootDir, state);
    } else if (question && state.status.clarifier) {
      state.status.clarifier.current_question = question;
      await saveProjectState(options.rootDir, state);
    }
    bus.publish(projectEvent("clarify_started", request.params.id));
    return question ?? { summary: buildGoalSummary(state) };
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/projects/:id/input", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const next = await nextClarificationQuestion(state, client);
    const updated = appendClarification(state, request.body.answer, next);
    if (updated.status.clarifier) {
      updated.status.clarifier.current_question = next;
    }
    await saveProjectState(options.rootDir, updated);
    bus.publish(projectEvent("input_recorded", request.params.id));
    return { state: updated, next_question: next };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/plan", async (request) => {
    const workflow = await composeSolutionWorkflow(options.rootDir, request.params.id, client);
    bus.publish(projectEvent("plan_composed", request.params.id));
    return workflow;
  });

  app.post<{ Params: { id: string }; Body: { gate: string; note?: string } }>("/projects/:id/approve", async (request) => {
    await approveGate(options.rootDir, request.params.id, request.body.gate, request.body.note ?? "");
    bus.publish(projectEvent("gate_approved", request.params.id, { gate: request.body.gate }));
    return getProject(options.rootDir, request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { gate: string; note?: string } }>("/projects/:id/reject", async (request) => {
    await rejectGate(options.rootDir, request.params.id, request.body.gate, request.body.note ?? "rejected");
    bus.publish(projectEvent("gate_rejected", request.params.id, { gate: request.body.gate }));
    return getProject(options.rootDir, request.params.id);
  });

  app.post<{ Params: { id: string } }>("/projects/:id/run", async (request) => {
    await runProject(options.rootDir, request.params.id, client, bus);
    bus.publish(projectEvent("run_completed", request.params.id));
    return getProject(options.rootDir, request.params.id);
  });

  app.post<{ Params: { id: string; taskId: string } }>("/projects/:id/rerun/:taskId", async (request) => {
    const { rerunTask } = await import("./pipeline.js");
    await rerunTask(options.rootDir, request.params.id, request.params.taskId, client, bus);
    bus.publish(projectEvent("run_completed", request.params.id));
    return getProject(options.rootDir, request.params.id);
  });

  app.get<{ Params: { id: string; run: string } }>("/projects/:id/runs/:run", async (request) => {
    const runDir = join(projectPath(options.rootDir, request.params.id), "runs", request.params.run);
    const claim = await readFile(join(runDir, "claim.md"), "utf8").catch(() => "");
    const verdict = await readFile(join(runDir, "verdict.yaml"), "utf8").then((c) => parse(c)).catch(() => null);
    const stream = await readFile(join(runDir, "stream.md"), "utf8").catch(() => "");
    return { claim, verdict, stream };
  });

  app.get<{ Params: { id: string; run: string } }>("/projects/:id/runs/:run/stream", async (request) => {
    const streamPath = join(projectPath(options.rootDir, request.params.id), "runs", request.params.run, "stream.md");
    return readFile(streamPath, "utf8").catch(() => "");
  });

  app.get<{ Params: { id: string } }>("/projects/:id/workflow", async (request) => {
    const wfPath = join(projectPath(options.rootDir, request.params.id), "solution", "workflow.yaml");
    const raw = await readFile(wfPath, "utf8");
    return parse(raw);
  });

  app.get<{ Params: { id: string } }>("/projects/:id/deliverables", async (request) => {
    const solDir = join(projectPath(options.rootDir, request.params.id), "solution");
    const result: Array<{ path: string; content: string }> = [];
    try {
      await collectMarkdownFiles(solDir, solDir, result);
    } catch { /* solution dir not found */ }
    return result;
  });

  app.post<{ Body: { goal: string } }>("/projects", async (request) => {
    const { createProject } = await import("./project-store.js");
    const project = await createProject(options.rootDir, request.body.goal);
    bus.publish(projectEvent("project_created", project.id));
    return getProject(options.rootDir, project.id);
  });

  app.get<{ Params: { id: string }; Querystring: { once?: string } }>("/projects/:id/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(await getProject(options.rootDir, request.params.id))}\n\n`);
    if (request.query.once === "1") {
      reply.raw.end();
      return;
    }
    const unsubscribe = bus.subscribe(request.params.id, (event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
  });

  return app;
}

async function collectMarkdownFiles(baseDir: string, currentDir: string, result: Array<{ path: string; content: string }>): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFiles(baseDir, fullPath, result);
    } else if (entry.name.endsWith(".md")) {
      const relPath = fullPath.slice(baseDir.length + 1);
      const content = await readFile(fullPath, "utf8");
      result.push({ path: relPath, content });
    }
  }
}
