import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { appendClarification, buildGoalSummary, nextClarificationQuestion } from "./clarifier.js";
import { runCli } from "./cli.js";
import { EventBus, projectEvent } from "./events.js";
import { approveGate, getProject, listProjects, projectPath, rejectGate, saveProjectState } from "./project-store.js";
import { composeSolutionWorkflow, runProject } from "./pipeline.js";
import { renderHomePage } from "./web.js";

export interface ServerOptions {
  rootDir: string;
  bus?: EventBus;
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const bus = options.bus ?? new EventBus();

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return renderHomePage();
  });

  app.get("/projects", async () => listProjects(options.rootDir));

  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => getProject(options.rootDir, request.params.id));

  app.get<{ Params: { id: string } }>("/projects/:id/clarify", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const question = nextClarificationQuestion(state);
    return question ?? { summary: buildGoalSummary(state) };
  });

  app.post<{ Params: { id: string }; Body: { answer: string } }>("/projects/:id/input", async (request) => {
    const state = appendClarification(await getProject(options.rootDir, request.params.id), request.body.answer);
    await saveProjectState(options.rootDir, state);
    bus.publish(projectEvent("input_recorded", request.params.id));
    return state;
  });

  app.post<{ Params: { id: string } }>("/projects/:id/plan", async (request) => {
    const workflow = await composeSolutionWorkflow(options.rootDir, request.params.id);
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
    await runProject(options.rootDir, request.params.id);
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
    const lines: string[] = [];
    await runCli(["new", request.body.goal, "--root", options.rootDir], (line) => lines.push(line));
    const id = lines.find((line) => line.startsWith("created "))?.split(" ")[1];
    if (!id) throw new Error("Project creation did not return an id");
    bus.publish(projectEvent("project_created", id));
    return getProject(options.rootDir, id);
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
