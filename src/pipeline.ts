import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LlmClient } from "./llm.js";
import { getProject, projectPath, saveProjectState, writeYaml } from "./project-store.js";
import type { GraphWorkflowSpec, GraphRuntime } from "./types.js";
import { validateGraphWorkflow } from "./workflow-validator.js";

// 重导出图执行引擎
export { runGraphProject, readGraphSpec, applyHumanVerdict } from "./graph-engine.js";

/**
 * [TEMP] composeGraphWorkflow — 临时占位。
 * 后续完整实现:Composer 规划(判断任务性质 → 列能力清单 → 定护栏 → 设计 blackboard schema)
 * 目前:手写样例 workflow.yaml 验证执行引擎。真正调用此函数时走 LLM 规划(待实现)。
 */
export async function composeGraphWorkflow(
  rootDir: string,
  projectId: string,
  _client: LlmClient,
  spec: GraphWorkflowSpec,
): Promise<GraphWorkflowSpec> {
  const state = await getProject(rootDir, projectId);
  const dir = projectPath(rootDir, projectId);

  const validation = validateGraphWorkflow(spec);
  if (!validation.passed) throw new Error(`Workflow failed hard checks: ${validation.errors.join("; ")}`);

  await writeYaml(join(dir, "solution", "workflow.yaml"), spec);
  await mkdir(join(dir, "agents"), { recursive: true });
  for (const agentName of spec.agents) {
    await writeYaml(join(dir, "agents", `${agentName}.yaml`), { name: agentName, role: agentName });
  }

  state.project.status = "solutioning";
  state.status.active_workflow = "solution";
  state.status.flow_type = "graph";
  const runtime: GraphRuntime = {
    workflow_status: "plan_review",
    selected_executor: spec.selected_executor,
    required_capabilities: spec.required_capabilities,
    current_node: null,
    iteration: 0,
    awaiting: "none",
    blackboard: {},
    runs: {},
    node_retries: {},
    capabilities_added: [],
  };
  state.status.workflows.solution = runtime;
  await saveProjectState(rootDir, state);
  return spec;
}

// 旧 composeSolutionWorkflow 已退役 — 现由 composeGraphWorkflow 替代
// 旧 runProject / rerunTask 已退役 — 现由 graph-engine.runGraphProject 替代
