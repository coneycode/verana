import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
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
  const bus = options.bus ?? new EventBus();
  const client = options.client ?? new HttpLlmClient(await loadConfig(options.rootDir));

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return renderHomePage();
  });

  app.get("/projects", async () => listProjects(options.rootDir));

  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => getProject(options.rootDir, request.params.id));

  app.get<{ Params: { id: string } }>("/projects/:id/clarify", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const question = await nextClarificationQuestion(state, client);
    return question ?? { summary: buildGoalSummary(state) };
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/projects/:id/input", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const next = await nextClarificationQuestion(state, client);
    const updated = appendClarification(state, request.body.answer, next);
    await saveProjectState(options.rootDir, updated);
    bus.publish(projectEvent("input_recorded", request.params.id));
    return updated;
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
    await runProject(options.rootDir, request.params.id, client);
    bus.publish(projectEvent("run_completed", request.params.id));
    return getProject(options.rootDir, request.params.id);
  });

  app.get<{ Params: { id: string; run: string } }>("/projects/:id/runs/:run", async (request) => {
    const runDir = join(projectPath(options.rootDir, request.params.id), "runs", request.params.run);
    const [claim, verdict, log] = await Promise.all([
      readFile(join(runDir, "claim.md"), "utf8"),
      readFile(join(runDir, "verdict.yaml"), "utf8").then((content) => parse(content)),
      readFile(join(runDir, "log.md"), "utf8"),
    ]);
    return { claim, verdict, log };
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
