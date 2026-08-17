import { mkdir, readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

import type { LlmClient } from "./llm.js";
import { EventBus, projectEvent } from "./events.js";
import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type {
  CapabilityNode, EventEntry, GraphRuntime, GraphWorkflowSpec,
  SnapshotRecord, VerdictRecord, ExecutionFacts,
} from "./types.js";
import { renderBlackboardForContext, setBlackboardField } from "./blackboard.js";
import { appendEvent, readEvents, writeSnapshot, readLatestSnapshot, nextSeq, buildProgressTruth } from "./event-log.js";
import { checkHardGuardrails, checkSoftGuardrails, shouldHumanCheckpoint, type GuardrailCheckResult } from "./guardrails.js";
import { runScheduler, reviewCapabilityGap, type SchedulerDecision, type SchedulerTask } from "./scheduler.js";
import type { ExecutorAdapter } from "./executors.js";
import { diagnoseFailure, type DiagnosisResult } from "./diagnostician.js";
import { artifactFailureVerdict, collectArtifacts, getProjectDeliverableContract, renderArtifactForVerifier, renderDeliverableContract, validateArtifactContract } from "./artifacts.js";
import { materializeArtifacts } from "./materializer.js";

// 测试注入:设了就用 fake executor,不调 hermes CLI
let injectedExecutor: ExecutorAdapter | null = null;
export function setExecutorForTest(ea: ExecutorAdapter | null) { injectedExecutor = ea; }

/** 从事件日志提取某节点的历史归因结果(供 diagnostician 看"上次按X修了没用") */
async function getNodeDiagnoses(solutionDir: string, nodeId: string): Promise<DiagnosisResult[]> {
  const events = await readEvents(solutionDir, 0);
  return events
    .filter(e => e.type === "diagnosis" && e.node === nodeId)
    .map(e => ({
      root_cause: (e.data?.root_cause as DiagnosisResult["root_cause"]) ?? "A_instruction_vague",
      explanation: (e.data?.explanation as string) ?? "",
    }));
}

const EXECUTOR_SYSTEM = `你是一个执行者。根据节点描述和上下文,完成指定的工作,产出交付物。

规则:
- 用中文写,Markdown 格式
- 内容要具体、有实质,不要空话
- 直接输出内容正文,不要加多余说明`;

const CROSS_CHECK_SYSTEM = `你是一个独立验证者。判断另一个模型给出的判断是否正确。

返回 JSON:
{"agree": true/false, "reason": "你的独立判断和理由"}

规则:
- 你是独立的,不要受给定判断影响,自己重新判断
- agree=true 仅当你独立判断后结论一致
- 用中文`;

const VERIFIER_SYSTEM = `你是一个独立的验收者(verifier)。判断节点的交付物是否满足验收标准。

返回 JSON:
{"passed": true/false, "reasons": ["理由1", ...], "evidence": ["证据引用"]}

规则:
- 你是独立于执行者的,不信自述
- 用中文`;

export async function runGraphProject(rootDir: string, projectId: string, client: LlmClient, bus?: EventBus): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const wf = state.status.workflows.solution;
  if (!wf) throw new Error("Solution workflow does not exist");

  if (wf.workflow_status !== "executing") {
    throw new Error(`Workflow not executable from ${wf.workflow_status}`);
  }

  // 立刻通知前端:执行开始(不等第一个 scheduler 事件)
  bus?.publish(projectEvent("status_changed", projectId, { status: "executing", node: wf.current_node ?? "", iteration: wf.iteration }));

  const dir = projectPath(rootDir, projectId);
  const solutionDir = join(dir, "solution");
  const spec = await readGraphSpec(rootDir, projectId);
  const deliverableContract = getProjectDeliverableContract(spec);
  const startTime = Date.now();
  let totalTokens = 0;

  // 恢复:读最近快照
  const snap = await readLatestSnapshot(solutionDir);
  if (snap) {
    wf.current_node = snap.current_node;
    wf.iteration = snap.iteration;
    wf.blackboard = snap.blackboard;
    // 如果恢复到半截(有 current_node 但没 done),重跑该节点
    if (snap.awaiting === "none_midstep" && snap.current_node) {
      // 重新执行当前节点(丢弃半成品)
    }
  }

  // 初始化 instances 的 remaining:有非空 instances 的节点,blackboard 里初始化 {node_id}_remaining
  for (const cap of spec.capabilities) {
    if (cap.instances && cap.instances.length > 0) {
      const remainingKey = `${cap.id}_remaining`;
      const existing = wf.blackboard[remainingKey];
      const allNames = cap.instances.map(i => i.name);
      const allNamesSet = new Set(allNames);
      // 只有当 existing 包含且仅包含 allNames 里的所有 name 时才保留(防止残留脏数据/缺实例)
      const isValid = Array.isArray(existing) && existing.length === allNames.length && existing.every(n => allNamesSet.has(n));
      if (!isValid) {
        wf.blackboard[remainingKey] = allNames;
      }
    }
  }
  await saveProjectState(rootDir, state);

  let consecutiveFail = 0;

  while (true) {
    // 硬护栏
    const hardHit = checkHardGuardrails(spec.guardrails, wf.iteration, totalTokens, startTime);
    if (hardHit.hit) {
      wf.workflow_status = "awaiting_human";
      wf.awaiting = "human";
      wf.awaiting_reason = hardHit.reason;
      wf.awaiting_scene = "guardrail";
      await appendEvent(solutionDir, { type: "guardrail_hit", reason: hardHit.reason, data: { which: hardHit.which } });
      await saveProjectState(rootDir, state);
      bus?.publish(projectEvent("human_required", projectId, { scene: "guardrail", reason: hardHit.reason }));
      return;
    }

    // 阶段性人审
    if (shouldHumanCheckpoint(spec, wf.iteration)) {
      wf.workflow_status = "awaiting_human";
      wf.awaiting = "human";
      wf.awaiting_reason = `第 ${wf.iteration} 轮阶段性人审`;
      wf.awaiting_scene = "checkpoint";
      await appendEvent(solutionDir, { type: "human_required", reason: `第${wf.iteration}轮检查点`, data: { iteration: wf.iteration } });
      await saveProjectState(rootDir, state);
      bus?.publish(projectEvent("human_required", projectId, { scene: "checkpoint", reason: `第${wf.iteration}轮检查点` }));
      return;
    }

    // 进度真相:从事件日志提取带 verdict 的执行轨迹,机械折叠成摘要(不吃 claim!)
    const progressTruth = await buildProgressTruth(solutionDir);

    // 调度大脑决策 — 吃 verdict 事实,不吃 claim
    const decision = await runScheduler(client, spec, wf.blackboard, progressTruth, wf.iteration);
    await appendEvent(solutionDir, { type: "scheduler_decision", reason: decision.tasks.map(t => t.reason).join("; ") || "(no tasks)", data: { tasks: decision.tasks, is_complete: decision.is_complete, capability_gap: decision.capability_gap } });
    bus?.publish(projectEvent("scheduler_decision", projectId, { tasks: decision.tasks, is_complete: decision.is_complete }));

    // 完成判断
    if (decision.is_complete) {
      wf.workflow_status = "final_review";
      wf.awaiting = "none";
      await appendEvent(solutionDir, { type: "node_done", reason: "完成标准满足,进入 final_review" });
      await saveProjectState(rootDir, state);
      bus?.publish(projectEvent("status_changed", projectId, { status: "final_review" }));
      return;
    }

    // 空 tasks 且没完成 → 转人审(scheduler 没给可执行任务)
    if (decision.tasks.length === 0) {
      wf.workflow_status = "awaiting_human";
      wf.awaiting = "human";
      wf.awaiting_reason = `scheduler 返回空 tasks 且未完成: ${decision.capability_gap ?? "无明确理由"}`;
      wf.awaiting_scene = "anomaly";
      await saveProjectState(rootDir, state);
      bus?.publish(projectEvent("human_required", projectId, { scene: "anomaly", reason: wf.awaiting_reason }));
      return;
    }

    // 单任务时的 action 路由(不并行的 action 只会出现在单任务里)
    // 多任务时只会有 execute/retry_with_feedback/switch_node/resume
    const firstTask = decision.tasks[0];
    if (decision.tasks.length === 1) {
      const task = firstTask;
      const action = task.action ?? "execute";
      if (action === "human") {
        wf.workflow_status = "awaiting_human";
        wf.awaiting = "human";
        wf.awaiting_reason = `scheduler 转人审: ${task.reason}`;
        wf.awaiting_scene = "failure";
        await saveProjectState(rootDir, state);
        bus?.publish(projectEvent("human_required", projectId, { scene: "failure", reason: wf.awaiting_reason }));
        return;
      }
      if (action === "skip_node") {
        wf.iteration += 1;
        await appendEvent(solutionDir, { type: "node_done", node: task.next_node || "?", reason: `跳过(scheduler判定非必要)` });
        await saveProjectState(rootDir, state);
        continue;
      }
      if (action === "materialize") {
        // scheduler 决策:让 materializer 从已有产出整理正式产物
        const nodeId = wf.current_node ?? task.next_node;
        if (!nodeId) {
          wf.workflow_status = "awaiting_human";
          wf.awaiting = "human";
          wf.awaiting_reason = "materialize 但没有 current_node";
          wf.awaiting_scene = "anomaly";
          await saveProjectState(rootDir, state);
          return;
        }
        const node = spec.capabilities.find(c => c.id === nodeId);
        if (!node) {
          wf.workflow_status = "awaiting_human";
          wf.awaiting = "human";
          wf.awaiting_reason = `materialize 但节点 ${nodeId} 不存在`;
          wf.awaiting_scene = "anomaly";
          await saveProjectState(rootDir, state);
          return;
        }
        const lastRunId = wf.runs[nodeId]?.[wf.runs[nodeId].length - 1];
        if (!lastRunId) {
          wf.workflow_status = "awaiting_human";
          wf.awaiting = "human";
          wf.awaiting_reason = `materialize 但节点 ${nodeId} 没有 run`;
          wf.awaiting_scene = "anomaly";
          await saveProjectState(rootDir, state);
          return;
        }
        const runDir = join(dir, "runs", lastRunId);
        let snapshot = await collectArtifacts({ projectDir: dir, runDir, runId: lastRunId, node, instance: task.instance });
        let report = await validateArtifactContract({ snapshot, node, projectDir: dir, deliverableType: spec.goal.deliverable_type, deliverableContract, instance: task.instance });
        if (report.passed) {
          wf.iteration += 1;
          await saveProjectState(rootDir, state);
          continue;
        }
        const instruction = "";
        const materialization = await materializeArtifacts({ client, projectDir: dir, runDir, snapshot, report, node, deliverableType: spec.goal.deliverable_type, deliverableContract, instruction, instance: task.instance });
        await writeYaml(join(runDir, "materialization-report.yaml"), materialization);
        await appendEvent(solutionDir, {
          type: materialization.passed ? "artifact_materialized" : "artifact_materialization_failed",
          node: nodeId,
          run_id: lastRunId,
          reason: materialization.passed ? `materialized: ${materialization.written.join(", ")}` : materialization.skipped_reason,
          data: { report: join("runs", lastRunId, "materialization-report.yaml"), written: materialization.written, targets: materialization.targets },
        });
        if (materialization.passed) {
          snapshot = await collectArtifacts({ projectDir: dir, runDir, runId: lastRunId, node, instance: task.instance });
          report = await validateArtifactContract({ snapshot, node, projectDir: dir, deliverableType: spec.goal.deliverable_type, deliverableContract, instance: task.instance });
          await writeYaml(join(runDir, "artifact-report.yaml"), report);
          await appendEvent(solutionDir, { type: report.passed ? "artifact_validated" : "artifact_failed", node: nodeId, run_id: lastRunId, data: { passed: report.passed, report: join("runs", lastRunId, "artifact-report.yaml"), failure_codes: report.outputs.flatMap(o => o.failures.map(f => f.code)) } });
          if (report.passed) {
            const artifactBody = await renderArtifactForVerifier(snapshot);
            const verdict = await verifyAgentNode(rootDir, projectId, lastRunId, node, spec, client, bus, artifactBody, snapshot.entries.map(e => e.snapshot_path), task.instance);
            await writeYaml(join(dir, "runs", lastRunId, "verdict.yaml"), verdict);
            await appendEvent(solutionDir, { type: "verdict", node: nodeId, run_id: lastRunId, reason: `passed=${verdict.passed} ${verdict.reasons.join("; ")}`, data: { passed: verdict.passed } });
            bus?.publish(projectEvent("verdict", projectId, { node: nodeId, runId: lastRunId, verdict }));
            if (verdict.passed) {
              if (node.updates && node.updates.length > 0) {
                await applyBlackboardUpdate(client, node, await renderArtifactForVerifier(snapshot), wf.blackboard, spec);
                await appendEvent(solutionDir, { type: "blackboard_updated", node: nodeId, data: { fields: node.updates } });
                bus?.publish(projectEvent("blackboard_updated", projectId, { node: nodeId, fields: node.updates }));
              }
              wf.iteration += 1;
              await appendEvent(solutionDir, { type: "node_done", node: nodeId, run_id: lastRunId });
              const seq = await nextSeq(solutionDir);
              await writeSnapshot(solutionDir, { seq, current_node: nodeId, iteration: wf.iteration, blackboard: wf.blackboard, awaiting: "none" });
              await saveProjectState(rootDir, state);
              continue;
            }
          }
        }
        wf.iteration += 1;
        await saveProjectState(rootDir, state);
        continue;
      }
      if (action === "request_capability" || (decision.capability_gap && !task.next_node)) {
        const review = await reviewCapabilityGap(client, spec, decision.capability_gap ?? "", wf.blackboard, task.reason);
        if (review.reasonable && review.newNode) {
          spec.capabilities.push(review.newNode);
          wf.capabilities_added.push({ node: review.newNode, reason: decision.capability_gap ?? "", at_seq: await nextSeq(solutionDir) });
          await writeYaml(join(solutionDir, "workflow.yaml"), spec);
          await appendEvent(solutionDir, { type: "capability_added", reason: decision.capability_gap ?? "", data: { node_id: review.newNode.id, composer_reason: review.reason } });
          continue;
        } else {
          wf.workflow_status = "awaiting_human";
          wf.awaiting = "human";
          wf.awaiting_reason = `能力缺口不合理: ${decision.capability_gap} / Composer: ${review.reason}`;
          wf.awaiting_scene = "capability_gap";
          await saveProjectState(rootDir, state);
          bus?.publish(projectEvent("human_required", projectId, { scene: "capability_gap", reason: wf.awaiting_reason }));
          return;
        }
      }
    }

    // 执行型任务(execute/retry_with_feedback/switch_node/resume)— 支持并行多任务
    const execTasks = decision.tasks;
    // 为每个任务解析节点
    const taskNodes: CapabilityNode[] = [];
    for (const task of execTasks) {
      const node = spec.capabilities.find(c => c.id === task.next_node);
      if (!node) {
        wf.workflow_status = "awaiting_human";
        wf.awaiting = "human";
        wf.awaiting_reason = `调度选了不存在的节点 ${task.next_node}`;
        wf.awaiting_scene = "anomaly";
        await saveProjectState(rootDir, state);
        return;
      }
      taskNodes.push(node);
    }

    // 软护栏检查(每个任务对应节点)
    for (let i = 0; i < taskNodes.length; i++) {
      const node = taskNodes[i];
      const softHit = await checkSoftGuardrails(client, spec, wf.blackboard, node.desc);
      if (softHit.hit) {
        wf.workflow_status = "awaiting_human";
        wf.awaiting = "human";
        wf.awaiting_reason = `软护栏: ${softHit.which} — ${softHit.reason}`;
        wf.awaiting_scene = "guardrail";
        const action = spec.guardrails.soft.find(s => s.id === softHit.which)?.action ?? "stop_human";
        await appendEvent(solutionDir, { type: "guardrail_hit", reason: softHit.reason, data: { which: softHit.which, action } });
        await saveProjectState(rootDir, state);
        bus?.publish(projectEvent("human_required", projectId, { scene: "guardrail", reason: softHit.reason }));
        return;
      }
    }

    // 硬护栏:重试次数检查(每个节点)
    const maxRetries = spec.guardrails.hard.max_retries_per_node ?? 3;
    for (let i = 0; i < taskNodes.length; i++) {
      const node = taskNodes[i];
      const currentRetries = wf.node_retries[node.id] ?? 0;
      if (currentRetries >= maxRetries) {
        wf.workflow_status = "awaiting_human";
        wf.awaiting = "human";
        wf.awaiting_reason = `节点 ${node.id} 重试耗尽 (${currentRetries}次,上限 ${maxRetries})。scheduler 仍想执行,转人审。`;
        wf.awaiting_scene = "failure";
        await saveProjectState(rootDir, state);
        bus?.publish(projectEvent("human_required", projectId, { scene: "failure", reason: wf.awaiting_reason }));
        return;
      }
    }

    // 设置 current_node(单任务时直接设;多任务时取第一个)
    wf.current_node = taskNodes[0].id;
    wf.awaiting = "none_midstep";
    await saveProjectState(rootDir, state);
    for (let i = 0; i < execTasks.length; i++) {
      const task = execTasks[i];
      const node = taskNodes[i];
      await appendEvent(solutionDir, { type: "node_selected", node: node.id, reason: task.reason, instance: task.instance });
    }

    // 先串行获取所有 runId(避免 nextRunId 冲突)— 获取后立即创建目录防止重复
    const runIds: string[] = [];
    for (let i = 0; i < execTasks.length; i++) {
      const task = execTasks[i];
      const node = taskNodes[i];
      const rid = await nextRunId(rootDir, projectId);
      runIds.push(rid);
      // 立即创建 runDir,防止下一个 nextRunId 返回相同 ID
      await mkdir(join(projectPath(rootDir, projectId), "runs", rid), { recursive: true });
      wf.runs[node.id] = [...(wf.runs[node.id] ?? []), rid];
      await appendEvent(solutionDir, { type: "run_created", node: node.id, run_id: rid, instance: task.instance });
      bus?.publish(projectEvent("node_selected", projectId, { node: node.id, runId: rid, reason: task.reason, status: "running", instance: task.instance }));
    }
    await saveProjectState(rootDir, state);

    // 执行 + 验证所有任务
    const doExecute = async (i: number) => {
      const task = execTasks[i];
      const node = taskNodes[i];
      const rid = runIds[i];
      return executeAndVerifyInstance(rootDir, projectId, rid, node, spec, wf, client, bus, task.instance, task.context_fields, deliverableContract, solutionDir);
    };

    const results = execTasks.length === 1
      ? [await doExecute(0)]
      : await Promise.all(execTasks.map((_, i) => doExecute(i)));

    // 统一处理 verdict
    let anyFailed = false;
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const task = execTasks[i];
      const node = taskNodes[i];
      const rid = runIds[i];
      await writeYaml(join(dir, "runs", rid, "verdict.yaml"), r.verdict);
      await appendEvent(solutionDir, { type: "verdict", node: node.id, run_id: rid, reason: `passed=${r.verdict.passed} ${r.verdict.reasons.join("; ")}`, data: { passed: r.verdict.passed, cross_check_agree: r.verdict.cross_check_agree, failure_class: r.verdict.failure_class } });
      bus?.publish(projectEvent("verdict", projectId, { node: node.id, runId: rid, verdict: r.verdict }));

      if (r.verdict.passed) {
        // passed:更新 blackboard
        if (node.updates && node.updates.length > 0) {
          await applyBlackboardUpdate(client, node, r.claim, wf.blackboard, spec);
          await appendEvent(solutionDir, { type: "blackboard_updated", node: node.id, data: { fields: node.updates } });
          bus?.publish(projectEvent("blackboard_updated", projectId, { node: node.id, fields: node.updates }));
        }
        // passed:如果有 instance,从 remaining 移除
        if (task.instance) {
          const rk = `${node.id}_remaining`;
          const remaining = wf.blackboard[rk];
          if (Array.isArray(remaining)) {
            wf.blackboard[rk] = remaining.filter((inst: string) => inst !== task.instance);
            await appendEvent(solutionDir, { type: "blackboard_updated", node: node.id, data: { field: rk, removed: task.instance, remaining: wf.blackboard[rk] } });
            bus?.publish(projectEvent("blackboard_updated", projectId, { node: node.id, field: rk }));
          }
        }
      } else {
        // fail:归因
        anyFailed = true;
        const retries = (wf.node_retries[node.id] ?? 0) + 1;
        wf.node_retries[node.id] = retries;
        const diagnosis = await diagnoseFailure(client, {
          node, verdict: r.verdict, claim: r.claim, artifact: r.artifactBody, instruction: r.instruction,
          blackboard: wf.blackboard, spec, failCount: retries,
          previousDiagnoses: await getNodeDiagnoses(solutionDir, node.id),
        });
        await appendEvent(solutionDir, { type: "diagnosis", node: node.id, run_id: rid, reason: `根因: ${diagnosis.root_cause} — ${diagnosis.explanation.slice(0, 200)}`, data: { root_cause: diagnosis.root_cause, explanation: diagnosis.explanation, fail_count: retries } });
        bus?.publish(projectEvent("diagnosis", projectId, { node: node.id, runId: rid, diagnosis }));
      }
    }

    if (anyFailed) {
      // 有失败:设置 consecutiveFail,等所有并行任务结束后统一 continue
      consecutiveFail += 1;
    } else {
      consecutiveFail = 0;
    }

    wf.iteration += 1;
    await appendEvent(solutionDir, { type: "node_done", node: taskNodes[0].id, run_id: runIds.join(",") });
    await saveProjectState(rootDir, state);

    // 快照(节点完成 = 检查点)
    const seq = await nextSeq(solutionDir);
    await writeSnapshot(solutionDir, { seq, current_node: taskNodes[0].id, iteration: wf.iteration, blackboard: wf.blackboard, awaiting: "none" });
    await saveProjectState(rootDir, state);
    // 不管 pass/fail,都 continue 下一轮(scheduler 会基于 progress truth 决策)
    continue;
  }
}

/** 执行单个 instance 并验证(封装 execute → max-turns 复核 → artifact collect/validate/verify)
 *  返回 verdict + claim + artifactBody + instruction,不处理 blackboard remaining 和 retries */
async function executeAndVerifyInstance(
  rootDir: string,
  projectId: string,
  runId: string,
  node: CapabilityNode,
  spec: GraphWorkflowSpec,
  wf: GraphRuntime,
  client: LlmClient,
  bus: EventBus | undefined,
  instance: string | undefined,
  contextFields: string[] | undefined,
  deliverableContract: ReturnType<typeof getProjectDeliverableContract>,
  solutionDir: string,
): Promise<{ verdict: VerdictRecord; claim: string; artifactBody: string; instruction: string }> {
  const dir = projectPath(rootDir, projectId);

  const execResult = await executeNode(rootDir, projectId, runId, node, spec, wf.blackboard, client, bus, instance, contextFields);
  const runResult = execResult.content;
  const instruction = execResult.instruction;

  // max-turns hit 检测:executor 因 max-turns 或 timeout 退出,不直接判 fail
  const DEFAULT_MAX_TURNS = 120;
  if (execResult.hitMaxTurns) {
    const resumedRuns: string[] = Array.isArray((wf as GraphRuntime & { resumed_runs?: string[] }).resumed_runs) ? (wf as GraphRuntime & { resumed_runs?: string[] }).resumed_runs! : [];
    const hasResumedBefore = resumedRuns.includes(runId);
    const cumulativeMax = DEFAULT_MAX_TURNS * 2;

    // 防呆:已 resume 过 或 到累计上限 → 不再 resume
    if (hasResumedBefore || execResult.usedTurns >= cumulativeMax) {
      bus?.publish(projectEvent("max_turns_review", projectId, { runId, nodeId: node.id, verdict: "abandon", reason: "已 resume 过或到累计上限" }));
    } else {
      // 机械收集执行轨迹事实
      const facts = await collectExecutionFacts(rootDir, projectId, runId, node, execResult.usedTurns, hasResumedBefore, instance);
      bus?.publish(projectEvent("llm_status", projectId, { message: `max-turns hit,Composer 复核中...` }));

      // Composer 复核
      const { reviewMaxTurnsHit } = await import("./pipeline.js");
      const review = await reviewMaxTurnsHit(client, node, spec, facts);
      await appendEvent(solutionDir, { type: "max_turns_review", node: node.id, run_id: runId, data: { verdict: review.verdict, reason: review.reason, reframe_action: review.reframe_action ?? null, new_max_turns: review.new_max_turns ?? null } });
      bus?.publish(projectEvent("max_turns_review", projectId, { runId, nodeId: node.id, verdict: review.verdict, reason: review.reason }));

      if (review.verdict === "resume" && review.new_max_turns && execResult.sessionId) {
        // 续接执行:hermes --resume <session_id>(只有有 session_id 时才能 resume）
        bus?.publish(projectEvent("llm_status", projectId, { message: `Composer 判定 resume,续接执行(新上限 ${review.new_max_turns})...` }));
        const resumeResult = await resumeExecution(rootDir, projectId, runId, node, spec, execResult.sessionId, review.new_max_turns, bus, instance);
        // 标记已 resume
        if (!Array.isArray((wf as GraphRuntime & { resumed_runs?: string[] }).resumed_runs)) {
          (wf as GraphRuntime & { resumed_runs?: string[] }).resumed_runs = [];
        }
        (wf as GraphRuntime & { resumed_runs?: string[] }).resumed_runs!.push(runId);
        // resume 后更新 content
        if (resumeResult.content) {
          await appendFile(join(dir, "runs", runId, "stream.md"), `\n## Resume 续接输出\n\n${resumeResult.content}\n`, "utf8");
        }
      } else if (review.verdict === "resume" && !execResult.sessionId) {
        // Composer 判 resume 但没有 session_id(timeout kill 时 hermes 没输出 session_id)
        // 降级为 abandon,走正常 fail 流程
        bus?.publish(projectEvent("llm_status", projectId, { message: `无法 resume(无 session_id),走正常 fail 流程` }));
      }
      // reframe / abandon → 不做特殊处理,继续正常流程(verifier 会判 fail → diagnostician → scheduler 路由)
    }
  }

  // 验证
  let verdict: VerdictRecord;
  let artifactBody = runResult;
  if (node.kind === "light") {
    verdict = await crossCheckLight(rootDir, projectId, runId, node, spec, wf.blackboard, client, bus, runResult);
  } else {
    const runDir = join(dir, "runs", runId);
    const snapshot = await collectArtifacts({ projectDir: dir, runDir, runId, node, instance });
    await appendEvent(solutionDir, { type: "artifact_collected", node: node.id, run_id: runId, data: { snapshot_dir: join("runs", runId, "artifacts"), outputs: snapshot.entries.map(e => e.declared_path) } });
    const report = await validateArtifactContract({
      snapshot,
      node,
      projectDir: dir,
      deliverableType: spec.goal.deliverable_type,
      deliverableContract,
      instance,
    });

    await writeYaml(join(runDir, "artifact-report.yaml"), report);
    await appendEvent(solutionDir, { type: report.passed ? "artifact_validated" : "artifact_failed", node: node.id, run_id: runId, data: { passed: report.passed, report: join("runs", runId, "artifact-report.yaml"), failure_codes: report.outputs.flatMap(o => o.failures.map(f => f.code)) } });
    if (!report.passed) {
      verdict = artifactFailureVerdict(report);
    } else {
      artifactBody = await renderArtifactForVerifier(snapshot);
      verdict = await verifyAgentNode(rootDir, projectId, runId, node, spec, client, bus, artifactBody, snapshot.entries.map(e => e.snapshot_path), instance);
    }
  }

  return { verdict, claim: runResult, artifactBody, instruction };
}

async function executeNode(rootDir: string, projectId: string, runId: string, node: CapabilityNode, spec: GraphWorkflowSpec, bb: Record<string, unknown>, client: LlmClient, bus: EventBus | undefined, instance?: string, contextFieldsOverride?: string[]): Promise<{ content: string; instruction: string; sessionId?: string; exitCode: number; hitMaxTurns: boolean; usedTurns: number }> {
  const dir = projectPath(rootDir, projectId);
  const solutionDir = join(dir, "solution");
  const runDir = join(dir, "runs", runId);
  const agentMaxTurns = 120;
  await mkdir(runDir, { recursive: true });
  const streamPath = join(runDir, "stream.md");
  await writeFile(streamPath, `# Run ${runId} — Node ${node.id}\n\n## 执行中...\n\n`, "utf8");

  // fallback 链: scheduler override → 节点默认 context_inputs → null(全量)
  const contextFields = contextFieldsOverride?.length ? contextFieldsOverride
    : node.context_inputs?.length ? node.context_inputs
    : null;

  const inputContents: string[] = [];
  for (const input of node.inputs ?? []) {
    if (input.path) {
      try { inputContents.push(`\n--- ${input.path} ---\n${await readFile(join(dir, input.path), "utf8")}`); } catch {}
    }
    if (input.ref === "blackboard") {
      inputContents.push(`\n--- blackboard ---\n${renderBlackboardForContext(bb, spec.blackboard_schema, contextFields)}`);
    }
  }

  const bbCtx = renderBlackboardForContext(bb, spec.blackboard_schema, contextFields);

  // 验收标准明示给 executor(执行/验收信息对称)— 含 target 和 outputs 路径
  const checksList = (node.checks ?? []).map(c => `- [${c.method}] ${c.desc}${c.target ? ` (目标: ${c.target})` : ""}`).join("\n");
  const outputsList = (node.outputs ?? []).flatMap((o) => {
    const outPath = instance ? o.path.replace(/{instance}/g, instance) : o.path;
    const line = `- ${outPath}: ${o.desc ?? ""}`;
    const alt = outPath.endsWith("/") ? `- ${outPath}content.md: ${o.desc ?? ""}` : null;
    return alt ? [line, alt] : [line];
  }).join("\n");

  const deliverableContract = getProjectDeliverableContract(spec);
  const deliverableContractText = renderDeliverableContract(deliverableContract);

  // 软引导(主观方向,不强制)
  const softGuidance = spec.soft_guidance ?? [];

  // 失败反馈:本节点最近的归因结果(让 executor 知道上次错哪、怎么改)
  const lastDiagnosis = await getNodeDiagnoses(solutionDir, node.id);
  const failFeedback = lastDiagnosis.length > 0
    ? lastDiagnosis[lastDiagnosis.length - 1]
    : null;

  const promptParts = [
    `项目目标: ${spec.goal.clarified}`,
    "",
    `节点: ${node.id} (${node.kind})`,
    `描述: ${node.desc}`,
    "",
    // instance:scheduler 选的实例,告诉 executor 这次处理哪个 + 维度边界
    instance ? (() => {
      const inst = node.instances?.find(i => i.name === instance);
      const parts = [`本次处理实例: ${instance}`];
      if (inst?.scope) parts.push(`该维度范围: ${inst.scope}`);
      if (inst?.excludes) parts.push(`不要包含: ${inst.excludes}`);
      return parts.join('\n');
    })() : "",
    "",
    // 不塞全局 hard_constraints — 相关硬约束已通过 checks 分配到节点,塞全局会让节点做超出职责的事
    checksList ? `验收标准(必须满足,你会被按这些标准验证):\\n${checksList}` : "",
    "",
    outputsList ? `产出文件路径(必须写到这些路径):\\n${outputsList}` : "",
    "",
    // 交付物结构要求只给产出最终交付物的节点(无 instance 的 agent 节点)
    // 有 instance 的节点是分维度收集,不应该按最终交付物结构写
    (!instance && node.kind === "agent") ? deliverableContractText : "",
    (!instance && node.kind === "agent") ? "必须把正式交付物正文写入声明 output 路径；不要把执行过程、工具日志、claim、完成自述写进交付物。" : "",
    instance && node.kind === "agent" ? "产出文件只需聚焦本次实例维度的证据,不要按最终交付物结构(多章节)写,不要覆盖其他维度的内容。" : "",
    "",
    // 判断节点是否有 evidence 角色的 output(搜索类节点)
    (() => {
      const hasEvidenceOutput = (node.outputs ?? []).some(o => o.role === "evidence");
      if (node.kind !== "agent") return "";
      if (hasEvidenceOutput) {
        return [
          "执行约束:",
          `- 总轮次上限${agentMaxTurns}次。`,
          "- 边搜边写:搜到一条有价值的信息,立即用 write_file 追加写入产出文件。不要积累到最后再写——每搜到一条就写一条,文件始终保持有内容。",
          "- 写入格式:每条信息标注来源(URL/出处),不需要结构化整理,原始记录即可。",
          "- 禁止反复解析同一个文件:一次打开,一次性提取所有需要的字段,不要每个关键词单独跑一遍。",
          "- 每次工具调用要有明确目的,不要用试错式搜索(一个个词试)。",
        ].join("\n");
      }
      return [
        "执行约束:",
        `- 总轮次上限${agentMaxTurns}次。产出文件是本节点的最终目的,搜索只是手段。确保在轮次用完前完成 write_file 写入产出文件。`,
        "- 禁止反复解析同一个文件:一次打开,一次性提取所有需要的字段,不要每个关键词单独跑一遍。",
        "- 每次工具调用要有明确目的,不要用试错式搜索(一个个词试)。",
      ].join("\n");
    })(),
    softGuidance.length > 0 ? `方向引导(主观偏好,尽量遵循但不强制):\\n${softGuidance.map(s => `- ${s}`).join("\\n")}` : "",
    "",
    bbCtx,
    inputContents.length > 0 ? `\\n输入:\\n${inputContents.join("\\n")}` : "",
    "",
    failFeedback ? `【上次失败反馈】\\n根因: ${failFeedback.root_cause}\\n说明: ${failFeedback.explanation}\\n这次请注意避免同样的问题。` : "",
    "",
    "请完成本节点的工作并产出内容。产出要带真实来源(如查到的 URL、引用的具体文档段落),不要凭空编造。",
  ].filter(p => p !== "");

  let content: string;
  let agentSessionId: string | undefined;
  let agentExitCode = 0;
  let agentHitMaxTurns = false;
  if (node.kind === "agent") {
    // 重节点:走 ExecutorAdapter(hermes CLI),让 agent 框架用自己的工具(web/browser/...)完成
    bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", message: "调用 Hermes agent 执行(带 web 工具)..." }));
    const { HermesAdapter } = await import("./executors.js");
    const adapter = injectedExecutor ?? new HermesAdapter();
    const probe = await adapter.probe();
    if (!probe.available) throw new Error(`Hermes executor not available: ${probe.reason}`);
    // 测试环境(fake executor)用短 timeout;真实 hermes 用 10min
    const isFake = adapter.name !== "hermes";
    const agentRun = await adapter.execute(promptParts.join("\n"), dir, {
      maxTurns: agentMaxTurns, toolsets: ["web", "browser", "terminal", "file"], timeoutMs: isFake ? 30_000 : 600_000,
      onOutputLine: (line) => {
        // hermes 的每一行输出实时推给前端(工具调用过程 + 最终输出)
        if (line.trim()) bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", delta: line + "\n" }));
      },
    });
    content = agentRun.claim || agentRun.raw;
    agentSessionId = agentRun.sessionId;
    agentExitCode = agentRun.exitCode;
    agentHitMaxTurns = agentRun.hitMaxTurns ?? false;
    if (!content && !agentHitMaxTurns) throw new Error(`Hermes agent returned empty (exit ${agentRun.exitCode})`);
    await appendFile(streamPath, `\n## Hermes Agent 输出\n\n${content}\n`, "utf8");
    // 诊断日志:完整 raw 存单独文件,stream.md 只存摘要
    await appendFile(streamPath, `\n## 诊断\n\nexit_code: ${agentRun.exitCode}\nsession_id: ${agentRun.sessionId ?? "(none)"}\nhit_max_turns: ${agentHitMaxTurns}\nclaim_len: ${agentRun.claim.length}\nraw_len: ${agentRun.raw.length}\nraw_file: runs/${runId}/raw-stdout.txt\n`, "utf8");
    await writeFile(join(runDir, "raw-stdout.txt"), agentRun.raw, "utf8");
    // 把 agent 产出作为一整段推到前端(hermes -Q 只输出最终结果,不是逐字流)
    bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", delta: content }));
    bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", message: "Hermes agent 执行完成" }));
  } else {
    // 轻节点:直调 LLM(判断/转换/更新记忆,不需要工具)
    bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", message: "LLM 流式生成中..." }));
    content = await client.complete("composer", EXECUTOR_SYSTEM, promptParts.join("\n"), (delta) => {
      bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", delta }));
    });
    await appendFile(streamPath, `\n## LLM 输出\n\n${content}\n`, "utf8");
    bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", message: "LLM 输出完成" }));
  }

  // claim 留痕(原始产出,带对话外壳,供归因用)
  await writeFile(join(runDir, "claim.md"), `# Claim\n\nNode ${node.id} (${node.kind}).\n\n${content}`, "utf8");

  return {
    content,
    instruction: promptParts.join("\n"),
    sessionId: agentSessionId,
    exitCode: agentExitCode,
    hitMaxTurns: agentHitMaxTurns,
    usedTurns: agentMaxTurns,  // TODO: 从 hermes 输出提取实际轮次
  };
}

/** 轻节点交叉验证:生成模型出结果 → evaluator 独立判一次 → 不一致(fail)走归因 */
async function crossCheckLight(rootDir: string, projectId: string, runId: string, node: CapabilityNode, spec: GraphWorkflowSpec, bb: Record<string, unknown>, client: LlmClient, bus: EventBus | undefined, genResult: string): Promise<VerdictRecord> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);
  const streamPath = join(runDir, "stream.md");

  const checkDescs = node.checks.map(c => `- [${c.method}] ${c.desc}`).join("\n");
  const bbCtx = renderBlackboardForContext(bb, spec.blackboard_schema);

  // evaluator 独立重新判断
  const userPrompt = [
    `节点: ${node.id}`,
    `描述: ${node.desc}`,
    "",
    "验收标准:",
    checkDescs,
    "",
    "blackboard:",
    bbCtx,
    "",
    "生成模型的产出:",
    genResult.slice(0, 2000),
    "",
    "你独立判断这个产出是否满足验收标准。返回 agree(你是否同意产出合格)和理由。",
  ].join("\n");

  bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "verifying", message: "交叉验证中..." }));
  const result = await client.completeJson<{ agree: boolean; reason: string }>("evaluator", CROSS_CHECK_SYSTEM, userPrompt);
  await appendFile(streamPath, `\n## 交叉验证\n\nagree: ${result.agree}\nreason: ${result.reason}\n`, "utf8");

  // 生成模型自己说合格(passed),evaluator 说 agree 才算一致
  const passed = result.agree;
  return {
    passed,
    method: "cross_check",
    reasons: [result.reason],
    evidence: [],
    cross_check_agree: result.agree,
  };
}

/** 重节点:artifact/verdict 独立验证 */
async function verifyAgentNode(rootDir: string, projectId: string, runId: string, node: CapabilityNode, spec: GraphWorkflowSpec, client: LlmClient, bus: EventBus | undefined, artifactBody: string, artifactPaths: string[], instance?: string): Promise<VerdictRecord> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);
  const streamPath = join(runDir, "stream.md");

  const checkDescs = node.checks.map(c => `- [${c.method}] ${c.desc}${c.target ? ` (target: ${c.target})` : ""}`).join("\n");
  const deliverableContractText = renderDeliverableContract(getProjectDeliverableContract(spec));
  const instanceNote = instance
    ? `\n本次验证范围:本节点是分实例节点,本次只处理了实例「${instance}」。只验证该实例的产出是否满足验收标准,不要因为缺少其他实例的产出而判 fail。交付物结构要求(如有)是最终完整交付物的要求,不是单个实例的要求;单个实例只需满足节点 checks 中与该实例相关的部分。\n`
    : "";
  const userPrompt = [
    `节点: ${node.id}`,
    `描述: ${node.desc}`,
    instance ? `本次实例: ${instance}` : "",
    "",
    "验收标准:",
    checkDescs,
    "",
    instanceNote,
    deliverableContractText,
    "",
    "交付物 Artifact Snapshot:",
    artifactBody,
    "",
    "请独立判断 artifact snapshot 是否满足验收标准。不要把 claim、执行过程日志、过程自述当成交付物。交付物结构要求(如有)仅供参考,节点 checks 是主要验收标准;deliverable_contract 与 checks 冲突时以 checks 为准。",
    "",
    `当前日期: ${new Date().toISOString().slice(0, 10)}。被验证的文档引用此日期之前的数据(含本年度数据)是正常的,不视为臆造。只有在无来源且与可查证事实矛盾时才判定为臆造数据。`,
  ].join("\n");

  bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "verifying", message: "验证模型判定中..." }));
  const result = await client.completeJson<{ passed: boolean; reasons: string[]; evidence: string[] }>("evaluator", VERIFIER_SYSTEM, userPrompt);
  await appendFile(streamPath, `\n## 验证结果\n\npassed: ${result.passed}\nreasons: ${(result.reasons ?? []).join("; ")}\n`, "utf8");

  return {
    passed: result.passed,
    method: "combined",
    reasons: result.reasons ?? [],
    evidence: result.evidence ?? [],
    artifact_report: `runs/${runId}/artifact-report.yaml`,
    artifact_paths: artifactPaths,
  };
}

/** 更新记忆节点:把节点产出压进 blackboard 指定字段(由 LLM 提取/压缩) */
async function applyBlackboardUpdate(client: LlmClient, node: CapabilityNode, nodeOutput: string, bb: Record<string, unknown>, spec: GraphWorkflowSpec): Promise<void> {
  if (!node.updates) return;
  const UPDATE_SYSTEM = `你是一个记忆维护者。从节点产出中提取信息,更新到 blackboard 的指定字段。如果是滚动摘要字段,要压缩保持有界(老内容压成粗概要,近内容留细节)。

返回 JSON:
{"updates": {"字段名": "新值", ...}}

规则:
- 只更新给定的字段
- 滚动摘要字段要保持有界(不超过500字)
- 用中文`;

  const fields = node.updates.map(f => `- ${f}: ${spec.blackboard_schema.fields.find(x=>x.key===f)?.desc ?? ""}`).join("\n");
  const bbCtx = renderBlackboardForContext(bb, spec.blackboard_schema);
  const userPrompt = [
    "要更新的字段:", fields, "",
    "当前 blackboard:", bbCtx, "",
    "节点产出:", nodeOutput.slice(0, 3000), "",
    "提取信息更新到指定字段。",
  ].join("\n");

  const result = await client.completeJson<{ updates: Record<string, string> }>("composer", UPDATE_SYSTEM, userPrompt);
  for (const [k, v] of Object.entries(result.updates ?? {})) {
    setBlackboardField(bb, k, v);
  }
}

export async function readGraphSpec(rootDir: string, projectId: string): Promise<GraphWorkflowSpec> {
  const raw = await readFile(join(projectPath(rootDir, projectId), "solution", "workflow.yaml"), "utf8");
  return parse(raw) as GraphWorkflowSpec;
}

async function nextRunId(rootDir: string, projectId: string): Promise<string> {
  const dir = projectPath(rootDir, projectId);
  let runs: string[];
  try { runs = await readdir(join(dir, "runs")); } catch { runs = []; }
  const max = runs.map(r => /^run-(\d+)$/.exec(r)?.[1]).filter(Boolean).map(Number).reduce((a, b) => Math.max(a, b), 0);
  return `run-${String(max + 1).padStart(4, "0")}`;
}

/** 人审裁决回流:改 blackboard / 给方向指令 / 放行 */
export async function applyHumanVerdict(rootDir: string, projectId: string, verdict: {
  blackboard_edits?: Record<string, unknown>;
  direction_hint?: string;
  action: "continue" | "retry" | "abort" | "approve_irreversible";
}): Promise<void> {
  const state = await getProject(rootDir, projectId);
  const wf = state.status.workflows.solution;
  if (!wf) throw new Error("no workflow");

  if (verdict.blackboard_edits) {
    for (const [k, v] of Object.entries(verdict.blackboard_edits)) {
      wf.blackboard[k] = v;
    }
    await appendEvent(join(projectPath(rootDir, projectId), "solution"), { type: "blackboard_updated", reason: "人手改", data: verdict.blackboard_edits });
  }
  if (verdict.direction_hint) {
    wf.blackboard["human_direction"] = verdict.direction_hint;
    await appendEvent(join(projectPath(rootDir, projectId), "solution"), { type: "blackboard_updated", reason: "人方向指令", data: { human_direction: verdict.direction_hint } });
  }
  if (verdict.action === "continue" || verdict.action === "approve_irreversible" || verdict.action === "retry") {
    wf.workflow_status = "executing";
    wf.awaiting = "none";
    wf.awaiting_reason = undefined;
    wf.awaiting_scene = undefined;
    // retry:清除该节点的重试计数,让它能重新跑
    if (verdict.action === "retry" && wf.current_node) {
      wf.node_retries[wf.current_node] = 0;
    }
  }
  await saveProjectState(rootDir, state);
}

// ===== max-turns 动态调整:执行轨迹收集 + resume =====

/** 机械收集执行轨迹事实(不调 LLM) */
async function collectExecutionFacts(rootDir: string, projectId: string, runId: string, node: CapabilityNode, usedTurns: number, hasResumedBefore: boolean, instance?: string): Promise<ExecutionFacts> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);

  // 1. 产出文件状态
  const outputFiles = await Promise.all((node.outputs ?? []).map(async (output) => {
    const outPath = output.path.replace(/{instance}/g, instance ?? node.instances?.[0]?.name ?? "");
    const fullPath = join(dir, outPath);
    try {
      const stat = await import("node:fs/promises").then(m => m.stat(fullPath));
      const content = await import("node:fs/promises").then(m => m.readFile(fullPath, "utf8"));
      return {
        path: outPath,
        exists: true,
        bytes: stat.size,
        lines: content.split("\n").length,
        modifiedAt: stat.mtime.toISOString(),
      };
    } catch {
      return { path: outPath, exists: false, bytes: 0, lines: 0, modifiedAt: null };
    }
  }));

  // 2. stream 最后 N 轮行为 + 搜索关键词去重率
  const rawPath = join(runDir, "raw-stdout.txt");
  let rawContent = "";
  try {
    rawContent = await import("node:fs/promises").then(m => m.readFile(rawPath, "utf8"));
  } catch {}

  // 提取工具调用行(┊ 开头),取最后 20 条
  const toolLines = rawContent.split("\n").filter(l => l.includes("┊") && (l.includes("web_search") || l.includes("browser_navigate") || l.includes("write_file") || l.includes("read_file") || l.includes("curl"))).slice(-20);
  const streamLastNBehaviors = toolLines.map(l => {
    if (l.includes("web_search")) return "搜索";
    if (l.includes("browser_navigate")) return "浏览网页";
    if (l.includes("write_file")) return "写文件";
    if (l.includes("read_file")) return "读文件";
    if (l.includes("curl")) return "curl请求";
    return "其他";
  });

  // 搜索关键词去重率
  const searchKeywords = rawContent.match(/web_search.*?["\u201c]([^"\u201d]+)["\u201d]/g)?.map(m => m.slice(-20)) ?? [];
  const uniqueKeywords = new Set(searchKeywords);
  const searchKeywordsDedupRatio = searchKeywords.length > 0
    ? uniqueKeywords.size / searchKeywords.length
    : 0;

  return {
    outputFiles,
    streamLastNBehaviors,
    searchKeywordsDedupRatio,
    usedTurns,
    hasResumedBefore,
  };
}

/** 续接执行:用 hermes --resume <session_id> */
async function resumeExecution(rootDir: string, projectId: string, runId: string, node: CapabilityNode, spec: GraphWorkflowSpec, sessionId: string, newMaxTurns: number, bus: EventBus | undefined, instance?: string): Promise<{ content: string }> {
  const dir = projectPath(rootDir, projectId);
  const runDir = join(dir, "runs", runId);
  const streamPath = join(runDir, "stream.md");

  bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", message: `Resume 续接执行(session ${sessionId.slice(0, 12)}..., 新上限 ${newMaxTurns})...` }));

  const { HermesAdapter } = await import("./executors.js");
  const adapter = injectedExecutor ?? new HermesAdapter();
  const isFake = adapter.name !== "hermes";

  // 如果 adapter 有 resume 方法,用 resume;否则 fallback 到 execute
  if (adapter.resume && !isFake) {
    const agentRun = await adapter.resume(sessionId, dir, {
      maxTurns: newMaxTurns,
      toolsets: ["web", "browser", "terminal", "file"],
      timeoutMs: 600_000,
      onOutputLine: (line) => {
        if (line.trim()) bus?.publish(projectEvent("llm_stream", projectId, { runId, nodeId: node.id, phase: "executing", delta: line + "\n" }));
      },
    });
    const content = agentRun.claim || agentRun.raw;
    await writeFile(join(runDir, "raw-stdout.txt"), agentRun.raw, "utf8");
    return { content };
  }

  // Fake executor 或无 resume:返回空(fake executor 不支持 resume)
  return { content: "" };
}
