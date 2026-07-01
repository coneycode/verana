export type ProjectStatus =
  | "created"
  | "solutioning"
  | "solution_approved"
  | "implementing"
  | "delivered"
  | "cancelled";

export type WorkflowPhase = "solution" | "implementation";
export type WorkflowStatus =
  | "clarifying"
  | "goal_confirm"
  | "composing"
  | "plan_review"
  | "executing"
  | "final_review"
  | "approved"
  | "awaiting_input"
  | "blocked"
  | "failed"
  | "cancelled";

export type TaskStatus = "pending" | "running" | "verifying" | "delivered" | "failed" | "awaiting_input";
export type RunResult = "passed" | "failed" | "needs_input";
export type CheckMethod = "command" | "file_exists" | "llm_rubric" | "manual";
export type GateType = "human_approval" | "auto_check";

export interface ProjectRecord {
  id: string;
  goal: string;
  status: ProjectStatus;
  created_at: string;
}

export interface StatusRecord {
  project_id: string;
  active_workflow: WorkflowPhase | null;
  active_task: string | null;
  blocked_reason: string | null;
  awaiting_input: string | null;
  clarifier?: ClarifierRecord;
  workflows: Partial<Record<WorkflowPhase, WorkflowRecord>>;
}

export interface ClarifierRecord {
  status: "clarifying" | "goal_confirmed";
  clarifications: Array<{ q: string; a: string; risk: string }>;
  current_question?: { question: string; risk: string } | null;
}

export interface ProjectState {
  project: ProjectRecord;
  status: StatusRecord;
}

export interface WorkflowRecord {
  phase: WorkflowPhase;
  status: WorkflowStatus;
  selected_executor?: string;
  required_capabilities?: string[];
  tasks: Record<string, TaskRuntime>;
  gates: GateRecord[];
}

export interface TaskRuntime {
  id: string;
  status: TaskStatus;
  depends_on?: string[];
  runs?: string[];
  feedback?: string[];
}

export interface GateRecord {
  id: string;
  type: GateType;
  title: string;
  options: Array<"approve" | "reject">;
  on_approve?: {
    writes?: string;
    next?: WorkflowStatus;
  };
  on_reject?: {
    bounce_to: string;
    cascade: "downstream";
    feedback_to_context: boolean;
  };
  audit?: boolean;
}

export interface WorkflowSpec {
  version: "0.1";
  project_id: string;
  phase: WorkflowPhase;
  goal: {
    raw: string;
    clarified: string;
    deliverable_type: "research" | "implementation";
    acceptance: string[];
  };
  clarifications: Array<{ q: string; a: string }>;
  required_capabilities: string[];
  selected_executor: string;
  agents: string[];
  skills: string[];
  scripts: string[];
  tasks: TaskSpec[];
  gates: GateRecord[];
  policies: {
    long_running: {
      idle_watchdog: string;
      max_wall: string;
    };
    on_failure: string;
  };
}

export interface TaskSpec {
  id: string;
  desc: string;
  agent: string;
  skills?: string[];
  depends_on?: string[];
  inputs?: Array<{ path?: string; ref?: string; desc: string }>;
  outputs: Array<{ path: string; desc: string }>;
  checks: Array<{ method: CheckMethod; target?: string; desc: string }>;
}

export interface VerdictRecord {
  passed: boolean;
  method: CheckMethod | "combined";
  reasons: string[];
  evidence: string[];
}
