# Verana

> Project-based Agent Workflow delivery scaffold — graph workflow with dynamic scheduling.

Verana is a scaffold for orchestrating LLM agents to deliver project-scale work.
Instead of a static DAG that must predict every path before execution, Verana
pre-defines a **capability list + guardrails** (the boundaries), then lets a
**scheduler** dynamically decide the next step based on real runtime state.
The graph is not drawn in advance — it is the trajectory the execution walks.

---

## Table of Contents

- [What is Verana](#what-is-verana)
- [Architecture](#architecture)
  - [Three Layers](#three-layers)
  - [Graph Workflow Model](#graph-workflow-model)
  - [Full Pipeline Diagram](#full-pipeline-diagram)
  - [Artifact Contract Chain](#artifact-contract-chain)
  - [SSE Event Flow](#sse-event-flow)
  - [Iteration Promotion (instances + remaining)](#iteration-promotion)
- [Key Principles](#key-principles)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [REST API](#rest-api)
- [Design Source of Truth](#design-source-of-truth)
- [License](#license)

---

## What is Verana

Verana coordinates LLM agents to deliver complete project outcomes — research
reports, creative writing, code, etc. The core insight is:

**Don't pre-draw the entire graph. The graph is the trajectory walked by execution.**

What you pre-define and human-review is the **capability list + guardrails**
(boundaries). During execution, each step is a dynamic decision: which capability
to invoke next, based on the current blackboard state. This gives you both the
flexibility of dynamic decision-making (real context, no pre-judgment) and the
controllability of anti-black-box (hard boundaries, reasoned decisions with
audit trails, human gates at key points).

### Current Status

v2 graph workflow implementation is active. Implemented and being refined:

- Dynamic scheduler (runtime "brain")
- Event-log timeline + verdict-driven progress truth
- Diagnostician failure attribution (A-F root causes)
- Artifact contract (collect / freeze / validate)
- Materializer (scheduler-decided action)
- Sufficiency checker (3-layer pre-execution review)
- Hermes executor path
- Web/SSE control plane (unnamed event, onmessage dispatch)
- Iteration promotion: instances + remaining + scheduler instance selection

---

## Architecture

### Three Layers

```
┌──────────────────────────────────────────────────────────────────┐
│  L0  Scaffold                                                   │
│      Directory conventions + state machine + execution engine    │
│      (router / event log / snapshots / artifact contract)       │
│      Does NOT plan, does NOT do the actual work,                 │
│      does NOT judge semantic quality.                            │
├──────────────────────────────────────────────────────────────────┤
│  L1  Composer                                                   │
│      Compiles goal → capability list + guardrails +              │
│      blackboard schema + completion criteria.                    │
│      Does NOT execute, does NOT verify.                          │
├──────────────────────────────────────────────────────────────────┤
│  L2  Executor                                                   │
│      Calls existing frameworks (Hermes / Claude Code)            │
│      to execute heavy nodes.                                    │
│      Does NOT plan, does NOT schedule.                           │
└──────────────────────────────────────────────────────────────────┘
```

### Graph Workflow Model

A workflow is NOT a static `tasks[]` array. It is three parts:

```
capabilities: [...]      # capability list (nodes), planned in advance,
                         # human-reviewed, expandable during execution
guardrails: {...}        # red lines (hard limits + soft semantic checks),
                         # pre-defined
blackboard_schema: {...} # cross-round memory structure, customized by Composer
```

There are no pre-set edges and no complete graph at planning time. The scheduler
picks one node from the capability list at each step. The path walked — seen in
hindsight — is the execution graph. **Cycle = scheduler repeatedly selecting
the same node.**

Nodes come in two kinds:

- **Light node**: single LLM call or deterministic code, no autonomous loop.
  Verified via evaluator cross-validation (generation model ≠ verification model).
- **Heavy node**: dispatches an agent to do a complete task, internally may
  call models/tools/self-iterate. Verified via claim/verdict (agent self-report
  vs independent verification).

### Full Pipeline Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│              Pre-Execution Assurance (Phases 1-3)                    │
│                                                                     │
│  User Goal                                                          │
│    │                                                                │
│    ▼                                                                │
│  Clarifier ──batch Q&A + 2nd-pass verify──→ structured clarifications│
│    │                                                                │
│    ▼                                                                │
│  Composer ──generates──→ capability list + guardrails +             │
│                          blackboard schema + completion criteria    │
│                          + deliverable contract                     │
│    ▼                                                                │
│  Sufficiency Checker ──3-layer review──→ path/instruction/acceptance │
│    │                    ↗ bounce back (mechanical loop, ≤3)          │
│    ▼                                                                │
│  plan_review (human gate) ──human edits spec──→ locked               │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│              Post-Execution Attribution (Phases 4-6, exec loop)      │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │              Execution Loop (router-driven)                    │  │
│  │                                                                │  │
│  │  ① Hard guardrail check (code-judged, breach → forced stop)   │  │
│  │  ② Periodic human review (every N rounds)                    │  │
│  │  ③ buildProgressTruth (mechanical fold from event log,       │  │
│  │     does NOT eat claim)                                        │  │
│  │  ④ Scheduler decision (eats progress truth + blackboard,     │  │
│  │     does NOT eat claim)                                        │  │
│  │     │                                                          │  │
│  │     ├─ is_complete → final_review (human reviews deliverable)│  │
│  │     ├─ action=human → stop, route to human                    │  │
│  │     ├─ action=skip_node → skip, continue                     │  │
│  │     ├─ action=materialize → ⑧ materializer → re-collect      │  │
│  │     ├─ action=request_capability → Composer re-check →       │  │
│  │     │                              new node added              │  │
│  │     └─ action=execute/retry → select node, continue           │  │
│  │                                                                │  │
│  │  ⑤ Soft guardrail check (independent model, breach → stop)   │  │
│  │  ⑥ Executor runs → claim + disk artifacts                     │  │
│  │  ⑦ Artifact Collector → freeze snapshot →                    │  │
│  │     mechanical contract check                                  │  │
│  │     │                                                          │  │
│  │     ├─ contract fail → artifactFailureVerdict → ⑨            │  │
│  │     └─ contract pass → ⑧ Verifier semantic judgment         │  │
│  │                                                                │  │
│  │  ⑧ Verifier (judges artifact snapshot, NOT claim)              │  │
│  │     │                                                          │  │
│  │     ├─ pass → update blackboard → snapshot → next round ④    │  │
│  │     └─ fail ───────────────────────────────┐                 │  │
│  │                                             │                 │  │
│  │  ⑨ Diagnostician attribution ◄──────────────┘                 │  │
│  │     │  input: verdict fail + claim + artifact +               │  │
│  │     │        instruction + blackboard                         │  │
│  │     │  output: single root cause (A-F) + explanation          │  │
│  │     │  Type F is determined without LLM call                  │  │
│  │     │                                                          │  │
│  │     └─ write to event log → continue (next round ④)           │  │
│  │                                                                │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Hard guardrails: max_iterations / max_retries_per_node             │
│  materialize is NOT a retry, not subject to max_retries              │
│  retry exceeding limit → escalate to human                          │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Artifact Contract Chain

The fact layer — code-driven, no LLM involved:

```
Executor finishes
  │
  ▼
node.outputs declared disk files
  │
  ▼
collectArtifacts ──→ freeze to runs/<run-id>/artifacts/
  │
  ▼
validateArtifactContract (code mechanical check)
  │
  ├─ Universal layer (all types):
  │   - file exists / non-empty / size / line count
  │   - path safety
  │   - format parse (json/yaml)
  │   - not looks_like claim/stream/process_log/metadata_only
  │
  ├─ Structure layer (by deliverable_type):
  │   - research/creative: hand to verifier for semantic judgment
  │     (no mechanical chapter matching)
  │   - implementation: code checks (interface reserved)
  │
  ▼
Artifact Report (passed/failed + failure_codes)
  │
  ├─ fail (shape: looks_like_*/metadata_only/too_small)
  │     → scheduler may choose action=materialize
  │       → materializer salvages from claim/stream/bad artifact
  │       → re-collect / re-validate
  │
  ├─ fail (missing: missing/empty)
  │     → scheduler chooses action=retry_with_feedback
  │       → executor re-executes
  │
  └─ pass → verifier does semantic judgment
```

### SSE Event Flow

```
Backend EventBus
  │  publish(event)
  │  project_id="*" emits only once (no duplication)
  ▼
Server SSE endpoint
  │  unnamed event (only data lines, type in JSON payload)
  │  wildcard subscription skips current project events (no duplication)
  ▼
Frontend EventSource.onmessage
  │  receives all events uniformly, dispatches by data.type
  │
  ├─ snapshot → initial load
  ├─ llm_status → status bar update (no refresh)
  ├─ plan_progress → planning progress local render (no refresh)
  ├─ llm_stream → timeline block real-time output (no refresh)
  ├─ node_selected/verdict/diagnosis/artifact_* → timeline + refresh
  ├─ scheduler_decision → timeline + refresh
  ├─ human_required → human review card + refresh
  └─ unknown event → refresh (not discarded)
```

### Iteration Promotion

The graph workflow model allows the same node to be scheduled multiple times.
The `instances + remaining` mechanism (committed, see
`docs/design/iterations-proposal/README.md`) makes this precise:

```
┌──────────────────────────────────────────────────────────────┐
│  Planning Phase                                              │
│                                                              │
│  Composer outputs:                                          │
│    capabilities:                                             │
│      - id: collect_evidence                                  │
│        instances: [agent_loop, agent_team, traework,         │
│                    qoderwork, workbuddy, dumate]             │
│      - id: write_report                                      │
│        instances: []  # one-shot                            │
│      - id: review_report                                    │
│        instances: []  # one-shot                            │
│    blackboard_schema:                                       │
│      - collect_evidence_remaining  (bounded)                │
│                                                              │
│  workflow-validator:                                        │
│    nodes with non-empty instances MUST have                │
│    {node_id}_remaining in blackboard_schema                 │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Execution Phase                                            │
│                                                              │
│  ① scaffold initializes:                                    │
│     blackboard.collect_evidence_remaining = [all 6]         │
│                                                              │
│  ② scheduler decision:                                      │
│     sees remaining → picks "traework"                       │
│     output: next_node=collect_evidence, instance=traework │
│                                                              │
│  ③ scaffold assembles instruction:                          │
│     "this run: collect evidence for traework"               │
│                                                              │
│  ④ executor executes:                                       │
│     only does traework → produces evidence/traework.md     │
│                                                              │
│  ⑤ verifier: pass                                           │
│                                                              │
│  ⑥ scaffold updates (code, not LLM):                        │
│     remaining = remaining.filter(i => i !== "traework")     │
│                                                              │
│  ⑦ next round scheduler:                                   │
│     sees remaining shrunk → picks next instance             │
│     remaining empty → node done → next node                │
│                                                              │
│  Failure retry (only re-runs the failed instance):          │
│     collect_evidence/traework → fail                       │
│     → diagnostician attributes cause                       │
│     → scheduler retries with feedback, instance=traework  │
│     → executor improves traework only                      │
│     → passed instances (agent_loop etc.) unaffected        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Code-layer guarantees vs prompt-layer guidance:**

| What | Mechanism | Reliability |
|------|-----------|-------------|
| instances field exists | types.ts type definition | code-guaranteed |
| nodes with instances have remaining in blackboard | workflow-validator hard check | code-guaranteed |
| remaining initialization | graph-engine at execution start | code-guaranteed |
| instance injected into executor instruction | graph-engine code | code-guaranteed |
| instance removed after verdict pass | graph-engine code | code-guaranteed |
| Composer outputs instances | prompt guidance | not guaranteed, validator catches |
| scheduler selects instance | prompt guidance | not guaranteed, but scheduler sees remaining |
| executor only does specified instance | prompt guidance | not guaranteed |

---

## Key Principles

These are locked design decisions (see `docs/design/v2-noun-index.md`):

1. **Scheduler eats verdict facts, not claims.** The agent's self-report is
   unverified — only the verifier's verdict is truth.
2. **Verifier sees artifact snapshots, not claims.** Judgment is based on
   frozen disk artifacts, never the agent's words.
3. **A claim is never a deliverable.** Self-reported output must pass
   independent verification.
4. **Materialize is a scheduler action, not an automatic bypass.** Salvaging
   a bad artifact is an explicit decision, not a silent side-channel.
5. **Materialize is not a retry.** `max_retries` only intercepts retries;
   materialize is unconstrained by it.
6. **The sole dispatch outlet is the scheduler.** No other component decides
   what runs next.
7. **Scaffold does not overstep into planning.** The execution engine does not
   help Composer decompose nodes.
8. **Deliverable contracts are not forced to be generic.** If a universal
   structure can't be achieved, don't hardcode defaults.
9. **SSE sends unnamed events.** Frontend `onmessage` dispatches uniformly —
   no event-type-specific listeners, no silent drops.

---

## Quick Start

```sh
npm install
npm test
npm run typecheck

cp verana.config.example.yaml verana.config.yaml  # fill in your models + keys

# CLI
npm run cli -- new "调研海外红人监控系统"
npm run cli -- list
npm run cli -- clarify <project-id>
npm run cli -- input <project-id> "自研系统，覆盖数据源和合规"
npm run cli -- plan <project-id>
npm run cli -- approve <project-id> plan_review --note "通过"
npm run cli -- run <project-id>
npm run cli -- logs <project-id> run-0001
npm run cli -- approve <project-id> final_review --note "方案闭环"

# Server (Fastify + SSE + Web UI)
VERANA_ROOT=~/verana-data npm run server
# -> open http://127.0.0.1:3317
```

---

## Configuration

`verana.config.yaml` (gitignored). Two model roles — must be different models
to avoid self-certification:

```yaml
composer:
  base_url: "http://your-gateway/anthropic"
  model: "ppio/pa/claude-opus-4-8"
  api_key: "sk-xxx"

evaluator:
  base_url: "http://your-gateway/anthropic"
  model: "pa/claude-sonnet-5"
  api_key: "sk-xxx"
```

LLM client uses Anthropic native Messages API (`/v1/messages`, `x-api-key`,
`anthropic-version`). To switch to OpenAI-compatible API, replace
`HttpLlmClient` in `llm.ts`.

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/projects` | Create project |
| GET | `/projects` | List all |
| GET | `/projects/:id` | Get state |
| DELETE | `/projects/:id` | Delete project |
| POST | `/projects/:id/clarify-batch` | Generate clarification questions |
| POST | `/projects/:id/clarify-answer` | Submit clarification answers |
| POST | `/projects/:id/plan` | Compose graph workflow (SSE progress) |
| GET | `/projects/:id/workflow` | Get plan_review workflow spec |
| PUT | `/projects/:id/workflow` | Edit plan_review workflow spec |
| POST | `/projects/:id/approve` | Approve a gate |
| POST | `/projects/:id/reject` | Reject a gate (bounce) |
| POST | `/projects/:id/run` | Execute graph workflow |
| POST | `/projects/:id/human-verdict` | Resolve human-review stop |
| POST | `/projects/:id/rerun-from` | Reset and rerun from a phase |
| GET | `/projects/:id/timeline` | Rebuild timeline from events.log |
| GET | `/projects/:id/runs/:run` | Get claim, verdict, and stream log |
| GET | `/projects/:id/runs/:run/stream` | Get run stream log only |
| GET | `/projects/:id/deliverables` | List markdown deliverables |
| GET | `/projects/:id/deliverables/export` | Export deliverables as one markdown |
| GET | `/projects/:id/events` | SSE event stream |

---

## Design Source of Truth

| Document | Content |
|----------|---------|
| `docs/design/v2-orchestration-design.md` | Master design document (v0.5). See Appendix B for implementation status. |
| `docs/design/v2-noun-index.md` | Authoritative index of all nouns and processes. |
| `docs/design/v2-runtime-kernel-spec.md` | Runtime kernel spec: data models, function contracts, mechanical checks, test lists. |
| `docs/design/iterations-proposal/README.md` | Iteration promotion: instances + remaining + scheduler instance selection. |

Per `AGENTS.md`: before changing code, inspect the design-doc git diff/log first.
Design docs are the source of truth, under git version control. `[LOCKED]` marks
decisions confirmed with the product owner — do not override without discussion.

---

## License

Verana is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE).
You may use it for free for noncommercial purposes. Commercial use is not allowed
except for the limited evaluation periods described in LICENSE.

---

---

# Verana (中文)

> 项目制 Agent Workflow 交付脚手架 — 图工作流 + 动态调度。

Verana 是一个协调 LLM agent 完成项目级交付的脚手架。不采用执行前必须预判
所有走向的静态 DAG，而是预先定义**能力清单 + 护栏**(边界)，再由**调度大脑**
基于真实运行时状态动态决定下一步。图不是预先画的，是执行走出来的轨迹。

---

## 目录

- [Verana 是什么](#verana-是什么)
- [架构](#架构)
  - [三层职责](#三层职责)
  - [图工作流模型](#图工作流模型)
  - [完整流程图](#完整流程图)
  - [Artifact Contract 链路](#artifact-contract-链路)
  - [SSE 事件流](#sse-事件流)
  - [迭代提升 (instances + remaining)](#迭代提升)
- [关键铁律](#关键铁律)
- [快速开始](#快速开始)
- [配置](#配置)
- [REST API](#rest-api-1)
- [设计文档](#设计文档)
- [许可证](#许可证)

---

## Verana 是什么

Verana 协调 LLM agent 完成完整项目产出——调研报告、创作类写作、代码等。核心洞察:

**不预先画完整图，图是执行走出来的轨迹。**

预先定义并经人审的是**能力清单 + 护栏**(边界)，执行中每一步基于当前 blackboard
状态动态决策调哪个能力。既有动态决策的灵活(带真实上下文做决策，不预判)，又有
反黑盒的可控(能力是硬边界、决策带理由留痕、关键点停下问人)。

### 当前状态

v2 图工作流实现进行中，已实现并打磨中:

- 动态 scheduler(运行时"大脑")
- 事件日志时间线 + verdict 驱动的进度真相
- Diagnostician 失败归因(A-F 根因)
- Artifact contract(收集/冻结/校验)
- Materializer(scheduler 决策触发)
- Sufficiency checker(事前三层审查)
- Hermes executor 路径
- Web/SSE 控制面(unnamed event, onmessage 统一分发)
- 迭代提升: instances + remaining + scheduler 选实例

---

## 架构

### 三层职责

```
┌──────────────────────────────────────────────────────────────────┐
│  L0  Scaffold                                                   │
│      目录约定 + 状态机 + 执行引擎                                │
│      (router / 事件日志 / 快照 / artifact contract)              │
│      不规划、不执行具体工作、不判断语义质量                        │
├──────────────────────────────────────────────────────────────────┤
│  L1  Composer                                                   │
│      编译目标 → 能力清单 + 护栏 +                                │
│      blackboard schema + 完成标准                               │
│      不执行、不验证                                              │
├──────────────────────────────────────────────────────────────────┤
│  L2  Executor                                                   │
│      调现成框架(Hermes / Claude Code)执行重节点                 │
│      不规划、不调度                                              │
└──────────────────────────────────────────────────────────────────┘
```

### 图工作流模型

一个 workflow 不是静态的 `tasks[]`，而是三部分:

```
capabilities: [...]      # 能力清单(节点)，规划时列全，人审过，执行中可动态扩展
guardrails: {...}        # 护栏(红线)，预定义
blackboard_schema: {...} # 跨轮记忆结构，由 Composer 定制
```

规划时不设边、不画完整图。scheduler 每步从能力清单选一个节点执行。走过的路径
事后回看才是一张图(执行轨迹)。**循环 = scheduler 反复选中同一节点。**

节点分两类:

- **轻节点**: 单次 LLM 调用或确定性代码，无自主循环。过 evaluator 交叉验证
  (生成模型 ≠ 验证模型)。
- **重节点**: 派一个 agent 完成完整任务，内部可多次调模型/工具/自我迭代。
  走 claim/verdict(agent 自报 vs 独立验证)。

### 完整流程图

```
┌─────────────────────────────────────────────────────────────────────┐
│                        事前保证(阶段一~三)                           │
│                                                                     │
│  用户目标                                                            │
│    │                                                                │
│    ▼                                                                │
│  Clarifier ──批量问答 + 二次校验──→ 结构化澄清信息                     │
│    │                                                                │
│    ▼                                                                │
│  Composer ──生成──→ 能力清单 + 护栏 +                                 │
│                    blackboard schema + 完成标准                      │
│                    + deliverable contract                            │
│    ▼                                                                │
│  Sufficiency Checker ──三层审查──→ 路径/指令/验收                     │
│    │                ↗ 打回重生成(机械循环,≤3次)                      │
│    ▼                                                                │
│  plan_review(人审) ──人可编辑 spec──→ 锁定                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     事后归因(阶段四~六,执行循环)                      │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    执行循环(router 驱动)                      │    │
│  │                                                             │    │
│  │  ① 硬护栏检查(代码判,碰线→强制停)                            │    │
│  │  ② 阶段性人审(每N轮)                                        │    │
│  │  ③ buildProgressTruth(从事件日志机械折叠,不吃 claim)         │    │
│  │  ④ Scheduler 决策(吃进度真相+blackboard,不吃 claim)          │    │
│  │     │                                                       │    │
│  │     ├─ is_complete → final_review(人审交付物)                │    │
│  │     ├─ action=human → 停,转人审                              │    │
│  │     ├─ action=skip_node → 跳过,继续                           │    │
│  │     ├─ action=materialize → ⑧ materializer → 重新 collect    │    │
│  │     ├─ action=request_capability → Composer 复核 → 新增节点  │    │
│  │     └─ action=execute/retry → 选节点,继续                      │    │
│  │                                                             │    │
│  │  ⑤ 软护栏检查(独立模型,碰线→停)                              │    │
│  │  ⑥ Executor 执行 → claim + 磁盘产物                          │    │
│  │  ⑦ Artifact Collector → 冻结 snapshot → 机械契约检查          │    │
│  │     │                                                       │    │
│  │     ├─ 契约 fail → artifactFailureVerdict → ⑨               │    │
│  │     └─ 契约 pass → ⑧ Verifier 语义判定                       │    │
│  │                                                             │    │
│  │  ⑧ Verifier(判 artifact snapshot,非 claim)                  │    │
│  │     │                                                       │    │
│  │     ├─ pass → 更新 blackboard → 快照 → 下一轮 ④              │    │
│  │     └─ fail ─────────────────────────────────┐               │    │
│  │                                               │               │    │
│  │  ⑨ Diagnostician 归因 ◄───────────────────────┘               │    │
│  │     │  输入:verdict fail + claim + artifact + 指令 + blackboard│    │
│  │     │  输出:单一主根因(A-F) + 说明                            │    │
│  │     │  F 类确定性判定(不调 LLM)                               │    │
│  │     │                                                       │    │
│  │     └─ 写入事件日志 → continue(下一轮 Scheduler ④ 决策路由)    │    │
│  │                                                             │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  硬护栏:max_iterations/max_retries_per_node(代码判,强制)             │
│  materialize 不算 retry,不受 max_retries 限制                       │
│  retry 超限 → 转人审                                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Artifact Contract 链路

事实层，代码驱动，无 LLM 参与:

```
Executor 执行完
  │
  ▼
node.outputs 声明的磁盘文件
  │
  ▼
collectArtifacts ──→ 冻结到 runs/<run-id>/artifacts/
  │
  ▼
validateArtifactContract(代码机械检查)
  │
  ├─ 通用层(所有类型):
  │   - 文件存在 / 非空 / 大小 / 行数
  │   - 路径安全
  │   - 格式 parse(json/yaml)
  │   - 不像 claim/stream/process_log/metadata_only
  │
  ├─ 结构层(按 deliverable_type 分流):
  │   - research/creative: 交给 verifier 语义判断(不做机械章节匹配)
  │   - implementation: 代码检查(留接口)
  │
  ▼
Artifact Report(passed/failed + failure_codes)
  │
  ├─ fail(形态类: looks_like_*/metadata_only/too_small)
  │     → scheduler 可选 action=materialize
  │       → materializer 从 claim/stream/坏 artifact 整理
  │       → 重新 collect/validate
  │
  ├─ fail(缺失类: missing/empty)
  │     → scheduler 选 action=retry_with_feedback
  │       → executor 重新执行
  │
  └─ pass → verifier 做语义判定
```

### SSE 事件流

```
后端 EventBus
  │  publish(event)
  │  project_id="*" 时只 emit 一次(不重复)
  ▼
server SSE 端点
  │  unnamed event(只发 data 行,type 在 JSON payload 里)
  │  通配订阅跳过当前项目事件(不重复)
  ▼
前端 EventSource.onmessage
  │  统一接收所有事件,按 data.type 分发
  │
  ├─ snapshot → 初始加载
  ├─ llm_status → 状态栏更新(不触发 refresh)
  ├─ plan_progress → 规划进度局部渲染(不触发 refresh)
  ├─ llm_stream → timeline block 实时输出(不触发 refresh)
  ├─ node_selected/verdict/diagnosis/artifact_* → timeline 更新 + refresh
  ├─ scheduler_decision → timeline 更新 + refresh
  ├─ human_required → 人审卡 + refresh
  └─ 未知事件 → refresh(不丢弃)
```

### 迭代提升

图工作流模型允许同一节点被多次调度。instances + remaining 机制(已实现，
见 `docs/design/iterations-proposal/README.md`)让这个过程精准:

```
┌──────────────────────────────────────────────────────────────┐
│  规划阶段                                                    │
│                                                              │
│  Composer 输出:                                             │
│    capabilities:                                            │
│      - id: collect_evidence                                 │
│        instances: [agent_loop, agent_team, traework,        │
│                    qoderwork, workbuddy, dumate]            │
│      - id: write_report                                     │
│        instances: []  # 一次性                              │
│      - id: review_report                                   │
│        instances: []  # 一次性                              │
│    blackboard_schema:                                      │
│      - collect_evidence_remaining  (bounded)               │
│                                                              │
│  workflow-validator:                                       │
│    有非空 instances 的节点 MUST 在 blackboard_schema 里有  │
│    {node_id}_remaining 字段                                │
│                                                              │
└──────────────────────────┬───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  执行阶段                                                    │
│                                                              │
│  ① scaffold 初始化:                                         │
│     blackboard.collect_evidence_remaining = [全部6个]       │
│                                                              │
│  ② scheduler 决策:                                         │
│     看 remaining → 选 "traework"                           │
│     输出: next_node=collect_evidence, instance=traework   │
│                                                              │
│  ③ scaffold 组装指令:                                       │
│     "本次处理 traework 方案的证据收集"                       │
│                                                              │
│  ④ executor 执行:                                          │
│     只做 traework → 产出 evidence/traework.md              │
│                                                              │
│  ⑤ verifier: pass                                           │
│                                                              │
│  ⑥ scaffold 更新(代码,非 LLM):                            │
│     remaining = remaining.filter(i => i !== "traework")     │
│                                                              │
│  ⑦ 下一轮 scheduler:                                       │
│     看 remaining 少了 → 选下一个实例                        │
│     remaining 空 → 该节点完成 → 调下一个节点                │
│                                                              │
│  失败重试(只重跑失败的实例):                               │
│     collect_evidence/traework → fail                       │
│     → diagnostician 归因                                    │
│     → scheduler retry with feedback, instance=traework   │
│     → executor 只改进 traework                             │
│     → 已 passed 的(agent_loop 等)不受影响                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**代码层保证 vs prompt 层引导:**

| 事项 | 方式 | 可靠性 |
|------|------|--------|
| instances 字段存在 | types.ts 类型定义 | 代码保证 |
| 有 instances 的节点有 remaining | workflow-validator 硬校验 | 代码保证 |
| remaining 初始化 | graph-engine 执行开始时 | 代码保证 |
| instance 放进 executor 指令 | graph-engine 代码 | 代码保证 |
| verdict pass 后移除 instance | graph-engine 代码 | 代码保证 |
| Composer 输出 instances | prompt 引导 | 不保证,校验兜底 |
| scheduler 选 instance | prompt 引导 | 不保证,但 scheduler 能看到 remaining |
| executor 只做指定 instance | prompt 引导 | 不保证 |

---

## 关键铁律

已锁定的设计决策(见 `docs/design/v2-noun-index.md`):

1. **scheduler 吃 verdict 事实,不吃 claim。** agent 自报不可信，只有 verifier
   的 verdict 是真相。
2. **verifier 只看 artifact snapshot,不看 claim。** 判定基于冻结的磁盘产物，
   不看 agent 的话。
3. **claim 永远不是 deliverable。** 自报产出必须过独立验证。
4. **materialize 是 scheduler 的 action,不是自动旁路。** 拯救坏 artifact 是
   显式决策，不是静默侧通道。
5. **materialize 不算 retry。** max_retries 只拦截 retry，materialize 不受其限。
6. **调度决策唯一出口是 scheduler。** 没有其他组件决定下一步跑什么。
7. **scaffold 不越界做规划。** 执行引擎不帮 Composer 拆节点。
8. **deliverable_contract 做不到通用就不硬做。** 没有通用默认章节结构。
9. **SSE 发 unnamed event。** 前端 onmessage 统一分发——不按事件类型单独
   监听，不静默丢弃。

---

## 快速开始

```sh
npm install
npm test
npm run typecheck

cp verana.config.example.yaml verana.config.yaml  # 填入你的模型 + 密钥

# CLI
npm run cli -- new "调研海外红人监控系统"
npm run cli -- list
npm run cli -- clarify <project-id>
npm run cli -- input <project-id> "自研系统，覆盖数据源和合规"
npm run cli -- plan <project-id>
npm run cli -- approve <project-id> plan_review --note "通过"
npm run cli -- run <project-id>
npm run cli -- logs <project-id> run-0001
npm run cli -- approve <project-id> final_review --note "方案闭环"

# Server (Fastify + SSE + Web UI)
VERANA_ROOT=~/verana-data npm run server
# -> 打开 http://127.0.0.1:3317
```

---

## 配置

`verana.config.yaml` (gitignored)。两个模型角色——必须是不同模型，避免自证:

```yaml
composer:
  base_url: "http://your-gateway/anthropic"
  model: "ppio/pa/claude-opus-4-8"
  api_key: "sk-xxx"

evaluator:
  base_url: "http://your-gateway/anthropic"
  model: "pa/claude-sonnet-5"
  api_key: "sk-xxx"
```

LLM client 使用 Anthropic 原生 Messages API(`/v1/messages`, `x-api-key`,
`anthropic-version`)。切换到 OpenAI 兼容 API，替换 `llm.ts` 中的
`HttpLlmClient`。

---

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/projects` | 创建项目 |
| GET | `/projects` | 列出所有 |
| GET | `/projects/:id` | 获取状态 |
| DELETE | `/projects/:id` | 删除项目 |
| POST | `/projects/:id/clarify-batch` | 生成澄清问题 |
| POST | `/projects/:id/clarify-answer` | 提交澄清回答 |
| POST | `/projects/:id/plan` | 合成图工作流(SSE 进度) |
| GET | `/projects/:id/workflow` | 获取 plan_review workflow spec |
| PUT | `/projects/:id/workflow` | 编辑 plan_review workflow spec |
| POST | `/projects/:id/approve` | 批准一个 gate |
| POST | `/projects/:id/reject` | 驳回一个 gate |
| POST | `/projects/:id/run` | 执行图工作流 |
| POST | `/projects/:id/human-verdict` | 解决人审停止 |
| POST | `/projects/:id/rerun-from` | 重置并从某阶段重跑 |
| GET | `/projects/:id/timeline` | 从 events.log 重建时间线 |
| GET | `/projects/:id/runs/:run` | 获取 claim, verdict, stream log |
| GET | `/projects/:id/runs/:run/stream` | 只获取 run stream log |
| GET | `/projects/:id/deliverables` | 列出 markdown 交付物 |
| GET | `/projects/:id/deliverables/export` | 导出交付物为一个 markdown |
| GET | `/projects/:id/events` | SSE 事件流 |

---

## 设计文档

| 文档 | 内容 |
|------|------|
| `docs/design/v2-orchestration-design.md` | 主设计文档 (v0.5)。附录 B 有实现状态。 |
| `docs/design/v2-noun-index.md` | 所有名词与流程的权威索引。 |
| `docs/design/v2-runtime-kernel-spec.md` | 运行时内核规格:数据模型、函数契约、机械校验、测试清单。 |
| `docs/design/iterations-proposal/README.md` | 迭代提升:instances + remaining + scheduler 选实例。 |

按 `AGENTS.md` 约定:改代码前先看设计文档的 git diff/log。设计文档是真相源，
纳入 git 版本管理。`[LOCKED]` 标记表示已与产品负责人确认的决策，不要擅自推翻。

---

## 许可证

Verana 采用 [PolyForm Noncommercial License 1.0.0](LICENSE)。可免费用于非商业
用途。商业用途不允许，LICENSE 中描述的有限评估期除外。
