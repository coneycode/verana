import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { appendClarification, buildGoalSummary, nextClarificationQuestion } from "./clarifier.js";
import { EventBus, projectEvent } from "./events.js";
import { HttpLlmClient, loadConfig, type LlmClient } from "./llm.js";
import { approveGate, deleteProject, getProject, listProjects, projectPath, rejectGate, saveProjectState } from "./project-store.js";
import { composeGraphWorkflow, planGraphWorkflow } from "./pipeline.js";
import { runGraphProject, applyHumanVerdict } from "./graph-engine.js";
import { validateGraphWorkflow } from "./workflow-validator.js";
import { renderHomePage } from "./web.js";
import type { GraphWorkflowSpec } from "./types.js";

export interface ServerOptions {
  rootDir: string;
  bus?: EventBus;
  client?: LlmClient;
}

export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request) => {
    if (request.method === "POST" || request.method === "GET") {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${request.method} ${request.url}`);
    }
  });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    try { done(null, body ? JSON.parse(body as string) : {}); }
    catch (err) { done(err as Error, undefined); }
  });
  const bus = options.bus ?? new EventBus();
  const client = options.client ?? new HttpLlmClient(await loadConfig());

  // 静态文件:app.js
  app.get("/app.js", async (_request, reply) => {
    reply.type("text/javascript").send(await readFile(join(process.cwd(), "public", "app.js"), "utf8"));
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return renderHomePage();
  });

  app.get("/projects", async () => listProjects(options.rootDir));

  app.get<{ Params: { id: string } }>("/projects/:id", async (request) => getProject(options.rootDir, request.params.id));

  app.delete<{ Params: { id: string } }>("/projects/:id", async (request) => {
    await deleteProject(options.rootDir, request.params.id);
    console.log(`[delete] project ${request.params.id}`);
    bus.publish(projectEvent("project_deleted", request.params.id));
    return { status: "deleted", projectId: request.params.id };
  });

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
    const body = (request.body as { spec?: GraphWorkflowSpec }) ?? {};
    // fire-and-forget:前端不等待返回,通过 SSE 看进度
    if (body.spec) {
      composeGraphWorkflow(options.rootDir, request.params.id, client, body.spec)
        .then(() => { bus.publish(projectEvent("plan_composed", request.params.id)); })
        .catch((err: Error) => { bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
    } else {
      planGraphWorkflow(options.rootDir, request.params.id, client, bus)
        .then(() => { bus.publish(projectEvent("plan_composed", request.params.id)); })
        .catch((err: Error) => { bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
    }
    return { status: "composing", projectId: request.params.id };
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
    runGraphProject(options.rootDir, request.params.id, client, bus)
      .then(() => { bus.publish(projectEvent("run_completed", request.params.id)); })
      .catch((err: Error) => { console.error(`[run] ${request.params.id} failed:`, err.message); bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
    return { status: "running", projectId: request.params.id };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/human-verdict", async (request) => {
    const verdict = (request.body as { blackboard_edits?: Record<string, unknown>; direction_hint?: string; action: "continue" | "retry" | "abort" | "approve_irreversible" }) ?? { action: "continue" };
    await applyHumanVerdict(options.rootDir, request.params.id, verdict);
    bus.publish(projectEvent("human_verdict", request.params.id, verdict));
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

  // 从指定阶段重跑(重置后续阶段的状态)
  app.post<{ Params: { id: string }; Body: { phase: string } }>("/projects/:id/rerun-from", async (request) => {
    const phase = request.body.phase;
    const state = await getProject(options.rootDir, request.params.id);
    if (phase === "clarifying" || phase === "created") {
      // 重置到澄清:清掉 clarifier
      state.status.clarifier = { status: "clarifying", current_question: null, clarifications: [] };
      state.project.status = "created";
      state.status.workflows.solution = undefined;
    } else if (phase === "composing" || phase === "plan_review") {
      // 重置到规划:清掉 workflow
      state.status.workflows.solution = undefined;
      state.project.status = "created";
      // 清掉 solution 目录下的 workflow.yaml
      try { await rm(join(projectPath(options.rootDir, request.params.id), "solution", "workflow.yaml")); } catch {}
    } else if (phase === "executing") {
      // 重置到执行:清掉 runs/retries/blackboard,保留 spec
      const wf = state.status.workflows.solution;
      if (wf) {
        wf.runs = {};
        wf.node_retries = {};
        wf.iteration = 0;
        wf.current_node = null;
        wf.awaiting = "none";
        wf.awaiting_reason = undefined;
        wf.awaiting_scene = undefined;
        wf.workflow_status = "plan_review"; // 回 plan_review 重新 approve
      }
    }
    await saveProjectState(options.rootDir, state);
    bus.publish(projectEvent("status_changed", request.params.id, { status: phase }));
    return { ok: true };
  });

  // 人审编辑 spec(改节点/checks/硬软约束)
  app.put<{ Params: { id: string } }>("/projects/:id/workflow", async (request) => {
    const wfPath = join(projectPath(options.rootDir, request.params.id), "solution", "workflow.yaml");
    const spec = request.body as GraphWorkflowSpec;
    // 硬校验编辑后的 spec
    const validation = validateGraphWorkflow(spec);
    if (!validation.passed) throw new Error(`Edited workflow failed validation: ${validation.errors.join("; ")}`);
    await writeFile(wfPath, JSON.stringify(spec, null, 2), "utf8");
    bus.publish(projectEvent("workflow_edited", request.params.id, { reason: "人审编辑 spec" }));
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>("/projects/:id/deliverables", async (request) => {
    const solDir = join(projectPath(options.rootDir, request.params.id), "solution");
    const result: Array<{ path: string; content: string }> = [];
    try {
      await collectMarkdownFiles(solDir, solDir, result);
    } catch { /* solution dir not found */ }
    return result;
  });

  app.get<{ Params: { id: string } }>("/projects/:id/deliverables/export", async (request, reply) => {
    const solDir = join(projectPath(options.rootDir, request.params.id), "solution");
    const files: Array<{ path: string; content: string }> = [];
    try {
      await collectMarkdownFiles(solDir, solDir, files);
    } catch { /* solution dir not found */ }
    // Merge all deliverables into one markdown
    const merged = files.map(f => `# ${f.path}\n\n${f.content}`).join("\n\n---\n\n");
    const filename = `${request.params.id}-deliverables.md`;
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${filename}"`);
    return merged;
  });

  app.post<{ Body: { goal: string; name?: string } }>("/projects", async (request) => {
    const { createProject } = await import("./project-store.js");
    // 用户传了 name 就用,没传就 LLM 生成
    let title: string | undefined = request.body.name?.trim();
    if (!title) {
      try {
        const raw = await client.complete("composer",
          "你是一个项目命名助手。根据用户的目标,生成一个2-6字的中文摘要作为项目名。只输出摘要本身,不要任何额外文字或标点。",
          `目标: ${request.body.goal}`);
        title = raw.trim().replace(/^["'"]|["'"]$/g, "");
      } catch (e) {
        console.log("[create] title generation failed, using fallback:", (e as Error).message);
      }
    }
    const project = await createProject(options.rootDir, request.body.goal, title);
    console.log(`[create] project ${project.id} (goal: ${request.body.goal.slice(0, 40)})`);
    bus.publish(projectEvent("project_created", project.id));
    return getProject(options.rootDir, project.id);
  });

  app.get<{ Params: { id: string }; Querystring: { once?: string } }>("/projects/:id/events", async (request, reply) => {
    // 项目不存在时直接 404,不写 SSE header(避免删项目后 SSE 连接崩进程)
    const projectDir = projectPath(options.rootDir, request.params.id);
    try {
      await (await import("node:fs/promises")).access(projectDir);
    } catch {
      reply.code(404).send({ error: "project not found" });
      return;
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    let snapshotData: unknown;
    try {
      snapshotData = await getProject(options.rootDir, request.params.id);
    } catch {
      reply.raw.end();
      return;
    }
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshotData)}\n\n`);
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
