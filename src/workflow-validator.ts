import type { TaskSpec, WorkflowSpec } from "./types.js";

export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

export function validateWorkflowSpec(workflow: WorkflowSpec): ValidationResult {
  const errors: string[] = [];
  const taskIds = new Set(workflow.tasks.map((task) => task.id));

  for (const task of workflow.tasks) {
    if (task.checks.length === 0) errors.push(`Task ${task.id} has no checks`);
    for (const dependency of task.depends_on ?? []) {
      if (!taskIds.has(dependency)) errors.push(`Task ${task.id} depends on missing task ${dependency}`);
    }
  }

  for (const gate of workflow.gates) {
    const bounceTo = gate.on_reject?.bounce_to;
    if (bounceTo && !taskIds.has(bounceTo)) errors.push(`Gate ${gate.id} bounces to missing task ${bounceTo}`);
  }

  for (const cycle of detectCycles(workflow.tasks)) errors.push(`DAG cycle: ${cycle.join(" -> ")}`);

  return { passed: errors.length === 0, errors };
}

function detectCycles(tasks: TaskSpec[]): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles: string[][] = [];

  function visit(id: string, path: string[]): void {
    if (visiting.has(id)) {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency, [...path, dependency]);
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks) visit(task.id, [task.id]);
  return cycles;
}
