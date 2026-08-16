export type ProjectStatus =
  | "created"
  | "composing"
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
export type DeliverableType = "research" | "creative" | "implementation";
export type ArtifactKind = "file" | "directory";
export type ArtifactFormat = "markdown" | "json" | "yaml" | "text" | "directory";
export type ArtifactLookalike = "claim" | "stream" | "process_log" | "metadata_only";

export type OutputRole = "evidence" | "deliverable" | "intermediate";

export interface OutputContract {
  path: string;
  desc: string;
  kind?: ArtifactKind;
  role?: OutputRole;
  required?: boolean;
  materializable?: boolean;
  min_bytes?: number;
  min_lines?: number;
  format?: ArtifactFormat;
  must_not_look_like?: ArtifactLookalike[];
}

export interface DeliverableContract {
  required_sections: string[];
  forbidden_patterns: string[];
  notes?: string[];
}

/** 轻节点:单次调用;重节点:自主 agent。同一个节点可被多次执行(多轮) */
export interface CapabilityNode {
  id: string;
  name?: string;           // 中文短名(前端展示用,如"收集证据");不填则前端用 desc 前缀
  kind: NodeKind;
  desc: string;
  agent?: string;           // 重节点:agent 名;轻节点:可选(给 evaluator 看的角色)
  skills?: string[];
  inputs?: Array<{ path?: string; ref?: string; desc: string }>;
  outputs?: OutputContract[];
  checks: Array<{ method: CheckMethod; target?: string; desc: string }>;
  /** 这个节点负责更新 blackboard 的哪些字段(更新记忆节点用) */
  updates?: string[];
  /** 实例清单:空/不写 = 一次性节点; 非空 = 可多次调度,每次处理一个实例 */
  instances?: Instance[];
  /** 这个节点执行时需要注入哪些 blackboard 字段作为上下文;不填=fallback 全量 */
  context_inputs?: string[];
}

export interface Instance {
  name: string;
  scope?: string;      // 该维度包含什么
  excludes?: string;   // 该维度不包含什么(来自其他维度)
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
    deliverable_type: DeliverableType;
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
  hard_constraints: string[];     // 客观硬约束(进 checks + 进指令,双向锁)
  soft_guidance: string[];         // 主观软引导(只进指令,保留 agent 自由度)
  deliverable_contract?: DeliverableContract;
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
    | "artifact_collected" | "artifact_validated" | "artifact_failed"
    | "artifact_materialized" | "artifact_materialization_failed"
    | "llm_stream" | "diagnosis" | "max_turns_review";
  node?: string;
  run_id?: string;
  reason?: string;          // 调度理由/护栏原因/人审原因
  instance?: string;        // scheduler 选的实例(有 instances 的节点)
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
  method: CheckMethod | "combined" | "cross_check" | "artifact_contract";
  reasons: string[];
  evidence: string[];
  artifact_report?: string;
  artifact_paths?: string[];
  failure_class?: "F_artifact_contract_failure";
  cross_check_agree?: boolean;  // 轻节点交叉验证是否一致
}

export type RunResult = "passed" | "failed" | "needs_input";

export interface ProjectRecord {
  id: string;
  name?: string;
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
  qa_messages?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface ClarifierRecord {
  status: "clarifying" | "goal_confirmed";
  messages: Array<{ role: "assistant" | "user"; content: string }>;
  conclusions?: Array<{ topic: string; conclusion: string }>;
  // 兼容旧格式
  clarifications?: Array<{ q: string; a: string; risk: string }>;
  pending_batch?: Array<{ question: string; risk: string; dimension: string }> | null;
}

export interface ProjectState {
  project: ProjectRecord;
  status: StatusRecord;
}

// ===== max-turns 动态调整 =====

/** 机械收集的执行轨迹事实(喂给 Composer 复核) */
export interface ExecutionFacts {
  outputFiles: Array<{
    path: string;
    exists: boolean;
    bytes: number;
    lines: number;
    modifiedAt: string | null;
  }>;
  streamLastNBehaviors: string[];  // 最后 N 轮的工具调用类型摘要
  searchKeywordsDedupRatio: number;  // 最后 N 轮搜索关键词去重率(0=全重复,1=全不同)
  usedTurns: number;
  hasResumedBefore: boolean;
}

/** Composer 对 max-turns hit 的复核结果 */
export interface MaxTurnsReview {
  verdict: "resume" | "reframe" | "abandon";
  reason: string;
  reframe_action?: "split_node" | "adjust_check" | null;
  new_max_turns?: number;  // resume 时的新上限
}

/** executor 执行结果(含 session_id 供 resume 用) */
export interface ExecutorResult {
  content: string;
  instruction: string;
  sessionId?: string;
  exitCode: number;
  hitMaxTurns: boolean;  // executor 是否因 max-turns 退出
}
