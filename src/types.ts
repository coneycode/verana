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
  | "awaiting_human"
  | "blocked"
  | "failed"
  | "cancelled";

export type CheckMethod = "command" | "file_exists" | "llm_rubric" | "manual";
export type NodeKind = "light" | "agent";

/** 轻节点:单次调用;重节点:自主 agent。同一个节点可被多次执行(多轮) */
export interface CapabilityNode {
  id: string;
  kind: NodeKind;
  desc: string;
  agent?: string;           // 重节点:agent 名;轻节点:可选(给 evaluator 看的角色)
  skills?: string[];
  inputs?: Array<{ path?: string; ref?: string; desc: string }>;
  outputs?: Array<{ path: string; desc: string }>;
  checks: Array<{ method: CheckMethod; target?: string; desc: string }>;
  /** 这个节点负责更新 blackboard 的哪些字段(更新记忆节点用) */
  updates?: string[];
}

export interface Guardrails {
  hard: {
    max_iterations: number;
    max_cost_tokens?: number;
    max_wall_time?: string;
    max_retries_per_node?: number;
  };
  soft: Array<{
    id: string;
    desc: string;            // 语义红线描述,独立模型检查
    action: "stop_human" | "require_confirm";  // require_confirm 用于不可逆操作
  }>;
  human_checkpoint_every?: number;  // 每 N 轮人审
}

/** blackboard schema:Composer 定制的跨轮记忆结构 */
export interface BlackboardSchema {
  fields: Array<{
    key: string;
    desc: string;
    bounded: boolean;        // 是否要被更新节点压缩保持有界
  }>;
}

/** 工作流规格 v0.2 — 图工作流(能力+护栏+记忆),非静态 DAG */
export interface GraphWorkflowSpec {
  version: "0.2";
  project_id: string;
  phase: WorkflowPhase;
  flow_type: "graph";
  goal: {
    raw: string;
    clarified: string;
    deliverable_type: "research" | "creative" | "implementation";
    iterative: boolean;
    acceptance: string[];
  };
  clarifications: Array<{ q: string; a: string }>;
  required_capabilities: string[];
  selected_executor: string;
  agents: string[];
  skills: string[];
  scripts: string[];
  capabilities: CapabilityNode[];
  guardrails: Guardrails;
  blackboard_schema: BlackboardSchema;
  entry_node: string;       // 入口节点(Composer 指定)
  completion_criteria: string[];  // 完成标准(语义,调度判断)
  policies: {
    long_running: { idle_watchdog: string; max_wall: string };
    on_failure: string;
  };
}

/** 事件日志条目(append-only) */
export interface EventEntry {
  seq: number;
  ts: string;
  type:
    | "node_selected" | "node_start" | "node_done" | "verdict"
    | "blackboard_updated" | "guardrail_hit" | "human_required"
    | "scheduler_decision" | "capability_added" | "run_created"
    | "llm_stream";
  node?: string;
  run_id?: string;
  reason?: string;          // 调度理由/护栏原因/人审原因
  data?: Record<string, unknown>;
}

/** 状态快照(每节点完成打一次) */
export interface SnapshotRecord {
  seq: number;              // 对应最后一条事件的 seq
  ts: string;
  current_node: string | null;
  iteration: number;
  blackboard: Record<string, unknown>;
  awaiting: "none" | "human" | "composer" | "none_midstep";
}

/** blackboard 当前值 + 运行时状态(存 status.yaml) */
export interface GraphRuntime {
  workflow_status: WorkflowStatus;
  selected_executor?: string;
  required_capabilities?: string[];
  current_node: string | null;
  iteration: number;
  awaiting: "none" | "human" | "composer" | "none_midstep";
  awaiting_reason?: string;   // 为什么停下
  awaiting_scene?: "failure" | "guardrail" | "capability_gap" | "checkpoint" | "anomaly";
  blackboard: Record<string, unknown>;
  runs: Record<string, string[]>;  // node_id -> [run_id,...]
  node_retries: Record<string, number>;
  capabilities_added: Array<{ node: CapabilityNode; reason: string; at_seq: number }>;
}

export interface VerdictRecord {
  passed: boolean;
  method: CheckMethod | "combined" | "cross_check";
  reasons: string[];
  evidence: string[];
  cross_check_agree?: boolean;  // 轻节点交叉验证是否一致
}

export type RunResult = "passed" | "failed" | "needs_input";

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
  workflows: Partial<Record<WorkflowPhase, GraphRuntime>>;
  flow_type?: "graph";
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
