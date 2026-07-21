import { validateRelativeOutputPath } from "./artifacts.js";
import type { GraphWorkflowSpec } from "./types.js";

export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

export function validateGraphWorkflow(spec: GraphWorkflowSpec): ValidationResult {
  const errors: string[] = [];

  // 能力清单
  if (!spec.capabilities || spec.capabilities.length === 0) {
    errors.push("capabilities is empty");
  }
  const ids = new Set<string>();
  for (const cap of spec.capabilities ?? []) {
    if (ids.has(cap.id)) errors.push(`duplicate capability id: ${cap.id}`);
    ids.add(cap.id);
    if (!cap.desc) errors.push(`capability ${cap.id} has no desc`);
    if (!cap.checks || cap.checks.length === 0) errors.push(`capability ${cap.id} has no checks (no check no execute)`);
    if (cap.kind !== "light" && cap.kind !== "agent") errors.push(`capability ${cap.id} kind must be light|agent`);
    if (cap.kind === "agent" && (!cap.outputs || cap.outputs.length === 0)) {
      errors.push(`capability ${cap.id} is agent but has no outputs (artifact contract required)`);
    }
    const outputPaths = new Set<string>();
    for (const output of cap.outputs ?? []) {
      if (outputPaths.has(output.path)) errors.push(`capability ${cap.id} has duplicate output path: ${output.path}`);
      outputPaths.add(output.path);
      for (const failure of validateRelativeOutputPath(output.path)) {
        errors.push(`capability ${cap.id} ${failure.message}`);
      }
    }
  }

  // 入口节点存在
  if (spec.entry_node && !ids.has(spec.entry_node)) {
    errors.push(`entry_node ${spec.entry_node} not in capabilities`);
  }

  // 护栏
  if (!spec.guardrails?.hard?.max_iterations) {
    errors.push("guardrails.hard.max_iterations missing (no safety valve)");
  }
  if (!spec.completion_criteria || spec.completion_criteria.length === 0) {
    errors.push("completion_criteria is empty");
  }

  // blackboard schema
  if (!spec.blackboard_schema?.fields || spec.blackboard_schema.fields.length === 0) {
    errors.push("blackboard_schema.fields is empty");
  }
  // 每个字段至少有一个节点负责更新(bounded 的字段尤其要)
  const updateableFields = new Set<string>();
  for (const cap of spec.capabilities ?? []) {
    for (const f of cap.updates ?? []) updateableFields.add(f);
  }
  for (const f of spec.blackboard_schema?.fields ?? []) {
    if (f.bounded && !updateableFields.has(f.key)) {
      errors.push(`blackboard field ${f.key} is bounded but no node updates it`);
    }
  }

  // goal
  if (!spec.goal?.clarified) errors.push("goal.clarified is empty");
  if (!spec.goal?.acceptance || spec.goal.acceptance.length === 0) errors.push("goal.acceptance is empty");

  return { passed: errors.length === 0, errors };
}
