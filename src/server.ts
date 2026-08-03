import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import { generateClarifyBatch, reviewClarifications, buildGoalSummary, type ClarificationEntry } from "./clarifier.js";
import { EventBus, projectEvent } from "./events.js";
import { HttpLlmClient, loadConfig, setLlmStatusCallback, type LlmClient } from "./llm.js";
import { approveGate, deleteProject, getProject, listProjects, projectPath, rejectGate, saveProjectState, writeYaml } from "./project-store.js";
import { composeGraphWorkflow, planGraphWorkflow } from "./pipeline.js";
import { runGraphProject, applyHumanVerdict } from "./graph-engine.js";
import { readEvents } from "./event-log.js";
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

  // 全局 LLM 状态回调 — 推给 SSE(* 通配),前端实时看到"LLM 在干什么"
  setLlmStatusCallback((status) => {
    bus.publish({
      type: "llm_status",
      project_id: "*",
      at: new Date().toISOString(),
      payload: status,
    });
  });

  // 静态文件:app.js
  app.get("/app.js", async (_request, reply) => {
    reply.type("text/javascript").send(await readFile(join(process.cwd(), "public", "app.js"), "utf8"));
  });

  app.get("/", async (_request, reply) => {
    reply.type("text/html");
    return renderHomePage();
  });

  app.get("/projects", async () => listProjects(options.rootDir));

  app.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    try {
      return await getProject(options.rootDir, request.params.id);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reply.code(404).send({ statusCode: 404, error: "Not Found", message: `Project ${request.params.id} not found` });
        return;
      }
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>("/projects/:id", async (request) => {
    await deleteProject(options.rootDir, request.params.id);
    console.log(`[delete] project ${request.params.id}`);
    bus.publish(projectEvent("project_deleted", request.params.id));
    return { status: "deleted", projectId: request.params.id };
  });

  // 一次性生成全部澄清问题
  app.post<{ Params: { id: string } }>("/projects/:id/clarify-batch", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const batch = await generateClarifyBatch(state, client);
    // 存到 state(待回答)
    if (!state.status.clarifier) {
      state.status.clarifier = { status: "clarifying", clarifications: [] };
    }
    state.status.clarifier.current_question = null;
    state.status.clarifier.pending_batch = batch.questions;
    await saveProjectState(options.rootDir, state);
    bus.publish(projectEvent("clarify_started", request.params.id));
    return batch;
  });

  // 批量回答澄清问题
  app.post<{ Params: { id: string }; Body: { answers: Array<{ q: string; a: string }> } }>("/projects/:id/clarify-answer", async (request) => {
    const state = await getProject(options.rootDir, request.params.id);
    const answers = request.body.answers ?? [];
    // 把问答追加到 clarifications
    const existing = state.status.clarifier?.clarifications ?? [];
    const newEntries: ClarificationEntry[] = answers.map(a => ({ q: a.q, a: a.a, risk: "" }));
    state.status.clarifier = {
      status: "clarifying",
      clarifications: [...existing, ...newEntries],
    };
    state.status.clarifier.pending_batch = undefined;
    await saveProjectState(options.rootDir, state);

    // 二次校验:是否需要追问
    const review = await reviewClarifications(state, client);
    if (review.needFollowup && review.questions.length > 0) {
      state.status.clarifier.pending_batch = review.questions;
      await saveProjectState(options.rootDir, state);
      bus.publish(projectEvent("input_recorded", request.params.id));
      return { needFollowup: true, questions: review.questions };
    }

    // 不需要追问,澄清完成
    state.status.clarifier.status = "goal_confirmed";
    state.project.status = "composing";
    await saveProjectState(options.rootDir, state);
    bus.publish(projectEvent("input_recorded", request.params.id));
    return { needFollowup: false, summary: buildGoalSummary(state) };
  });

  app.post<{ Params: { id: string } }>("/projects/:id/plan", async (request) => {
    const body = (request.body as { spec?: GraphWorkflowSpec }) ?? {};
    // fire-and-forget:前端不等待返回,通过 SSE 看进度
    if (body.spec) {
      composeGraphWorkflow(options.rootDir, request.params.id, client, body.spec)
        .then(() => { bus.publish(projectEvent("plan_composed", request.params.id)); })
        .catch((err: Error) => { console.error(`[plan] ${request.params.id} failed:`, err.message); bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
    } else {
      planGraphWorkflow(options.rootDir, request.params.id, client, bus)
        .then(() => { bus.publish(projectEvent("plan_composed", request.params.id)); })
        .catch((err: Error) => { console.error(`[plan] ${request.params.id} failed:`, err.message); bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
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
      // 重置到规划:清掉 workflow + runs + events
      state.status.workflows.solution = undefined;
      state.project.status = "composing";
      const solDir = join(projectPath(options.rootDir, request.params.id), "solution");
      try { await rm(join(solDir, "workflow.yaml")); } catch {}
      try { await rm(join(solDir, "events.log")); } catch {}
      try { await rm(join(projectPath(options.rootDir, request.params.id), "runs"), { recursive: true, force: true }); } catch {}
      // 重新触发 plan(fire-and-forget)
      planGraphWorkflow(options.rootDir, request.params.id, client, bus)
        .then(() => { bus.publish(projectEvent("plan_composed", request.params.id)); })
        .catch((err: Error) => { bus.publish(projectEvent("run_failed", request.params.id, { error: err.message })); });
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
    await writeYaml(wfPath, spec);
    bus.publish(projectEvent("workflow_edited", request.params.id, { reason: "人审编辑 spec" }));
    return { ok: true };
  });

  // 返回 timeline 数据(从 events.log 提取,供前端刷新后重建)
  app.get<{ Params: { id: string } }>("/projects/:id/timeline", async (request) => {
    const solDir = join(projectPath(options.rootDir, request.params.id), "solution");
    const events = await readEvents(solDir);
    return events;
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
    // unnamed SSE: 只发 data 行,type 在 JSON payload 里,前端用 onmessage 统一接收
    reply.raw.write(`data: ${JSON.stringify({ type: "snapshot", project_id: request.params.id, at: new Date().toISOString(), payload: snapshotData })}\n\n`);
    if (request.query.once === "1") {
      reply.raw.end();
      return;
    }
    const unsubscribe = bus.subscribe(request.params.id, (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    // 也订阅通配事件(LLM 状态等全局事件),但跳过当前项目的事件(上面已处理)
    const unsubscribeAll = bus.subscribe("*", (event) => {
      if (event.project_id !== request.params.id) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    });
    request.raw.on("close", () => { unsubscribe(); unsubscribeAll(); });
  });

  // 启动时恢复:检测卡在 executing 且非人审的项目,自动重新触发执行
  try {
    const projects = await listProjects(options.rootDir);
    for (const p of projects) {
      try {
        const state = await getProject(options.rootDir, p.id);
        const wf = state.status.workflows.solution;
        if (wf && wf.workflow_status === "executing" && wf.awaiting !== "human") {
          console.log(`[recover] 项目 ${p.id} 卡在 executing(awaiting=${wf.awaiting}),恢复执行`);
          runGraphProject(options.rootDir, p.id, client, bus)
            .then(() => console.log(`[recover] ${p.id} 恢复执行完成`))
            .catch((err: Error) => console.error(`[recover] ${p.id} 恢复失败:`, err.message));
        }
      } catch {
        // skip broken project
      }
    }
  } catch (err) {
    console.error("[recover] 恢复检测失败:", (err as Error)?.message ?? err);
  }

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
