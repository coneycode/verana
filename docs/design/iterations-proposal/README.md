# 迭代提升方案 — instances + remaining + scheduler 选实例

状态: 待实现
对应 commit: 本文档与代码改动在同一 commit 提交
创建: 2026-07-27

---

## 1. 问题

当前节点粒度粗（3-4个），scheduler 只能线性走，没有"试错迭代提升"的空间。
同一节点可被多次调度，但 scheduler 不知道"还差什么没做"，无法精准调度。
重试时从头重跑整个大节点，浪费资源。

## 2. 目标

- 节点按功能拆细，每个节点只做一件事
- 一个节点可被 scheduler 调多次，每次处理一个实例
- scheduler 精准选择"这次做哪个实例"
- 重试只重跑出问题的实例，不重跑已完成的
- executor 在基础上改进而非从头重写

## 3. 核心机制

### 3.1 instances（静态，spec 里）

所有节点都有 instances 字段。空 = 一次性节点。非空 = 可多次调度。

```
capabilities:
  - id: collect_evidence
    instances: ["agent_loop", "agent_team", "traework", "qoderwork", "workbuddy", "dumate"]
  - id: write_report
    instances: []   # 一次性
  - id: review_report
    instances: []   # 一次性
```

### 3.2 remaining（动态，blackboard 里）

blackboard 里为每个有非空 instances 的节点维护 "{node_id}_remaining" 字段。

```
blackboard:
  collect_evidence_remaining: ["agent_loop", "agent_team", ...]  # 初始 = instances 副本
  write_report_remaining: 不存在（instances 为空，不初始化）
```

- 执行开始时：scaffold 初始化 remaining = instances 副本
- executor 执行完一个实例 + verdict pass 后：scaffold 从 remaining 移除该实例
- remaining 空 = 该节点全部完成

### 3.3 scheduler 输出 instance

SchedulerDecision 加 instance 字段。scheduler 看 blackboard 的 remaining，选一个实例。

```
{
  "next_node": "collect_evidence",
  "instance": "traework",
  "reason": "traework 还没收集，继续",
  "action": "execute"
}
```

一次性节点（instances 为空）不输出 instance。

### 3.4 数据流

```
① scaffold 初始化: blackboard.collect_evidence_remaining = ["agent_loop", ...]

② scheduler 决策:
   看 blackboard.remaining（通过 renderBlackboardForContext）
   → 选 "traework"
   → 输出 next_node=collect_evidence + instance="traework"

③ scaffold 组装指令:
   把 instance="traework" 放进 executor 指令
   "本次处理 traework 方案的证据收集"

④ executor 执行:
   只管做 traework
   产出 solution/evidence/traework.md

⑤ verifier 判定:
   artifact contract + 语义判定 → pass

⑥ scaffold 更新 blackboard:
   代码直接操作: remaining = remaining.filter(i => i !== "traework")
   不依赖 LLM 提取

⑦ 下一轮 scheduler:
   看 remaining → 少了 traework → 选下一个
   remaining 空 → 该节点完成 → 调下一个节点
```

### 3.5 精准重试

节点拆细后，重试只重跑出问题的实例：

```
collect_evidence 执行 traework → fail
→ diagnostician 归因 → scheduler 决策 retry
→ scheduler 输出 next_node=collect_evidence + instance="traework"
→ executor 只重做 traework，不重做已 passed 的 agent_loop
```

fail feedback 带上次产出 + 具体不足：
```
"上次 traework 证据产出像过程日志。请改进。"
```

executor 在基础上改进，不从头重写。

## 4. 改动清单

### 4.1 types.ts

```ts
// CapabilityNode 加 instances
export interface CapabilityNode {
  // ...已有字段
  instances?: string[];  // 空/不写 = 一次性; 非空 = 可多次调度
}

// SchedulerDecision 加 instance
export interface SchedulerDecision {
  next_node: string;
  reason: string;
  capability_gap: string;
  is_complete: boolean;
  action?: "execute" | "retry_with_feedback" | "switch_node" | "request_capability" | "skip_node" | "human" | "materialize";
  instance?: string;  // scheduler 选择的实例（有 instances 的节点才输出）
}
```

### 4.2 pipeline.ts — Composer prompt

Composer prompt 加规则：
- 所有节点都声明 instances 字段
- 可多次调度的节点（如按方案/章节/维度收集）列出实例清单
- 一次性的节点 instances 留空数组
- blackboard schema 里为有非空 instances 的节点设计 "{node_id}_remaining" 字段

ComposerLlmResult 的 capabilities 加 instances 字段。
assembleSpec 透传 instances。

### 4.3 workflow-validator.ts — 校验

硬校验规则：
- 所有节点都有 instances 字段（没有就报错）
- 有非空 instances 的节点，blackboard_schema 里必须有 "{node_id}_remaining" 字段
  （key 名约定：{node_id}_remaining，bounded: true）

### 4.4 graph-engine.ts — 初始化 + 指令组装 + remaining 更新

执行开始时（runGraphProject 初始化阶段）：
```
遍历 spec.capabilities
对每个有非空 instances 的节点：
  if (blackboard[node_id + "_remaining"] 不存在)
    blackboard[node_id + "_remaining"] = [...node.instances]
```

scheduler decision 返回 instance 后：
- 组装 executor 指令时带"本次处理 {instance}"
- 如果 instance 为空/undefined，不添加这段

verdict pass 后，如果有 instance：
```
const remainingKey = node.id + "_remaining";
const remaining = blackboard[remainingKey];
if (Array.isArray(remaining))
  blackboard[remainingKey] = remaining.filter(i => i !== decision.instance);
```

verdict pass 后的 blackboard 更新事件里记录 remaining 变化。

### 4.5 scheduler.ts — prompt + SchedulerDecision

SchedulerDecision 接口加 instance 字段。

prompt 加规则：
- 对于有 remaining 的节点（blackboard 里有 {node_id}_remaining 非空），
  从 remaining 里选一个实例，输出 instance 字段
- 优先选 remaining 里的第一个或有优先级的
- 一次性节点（无 remaining）不输出 instance

## 5. 代码层保证 vs prompt 引导

| 事项 | 方式 | 可靠性 |
|------|------|--------|
| instances 字段存在 | types.ts 类型定义 | 代码保证 |
| 有 instances 的节点有 blackboard remaining 字段 | workflow-validator 硬校验 | 代码保证 |
| remaining 初始化 | graph-engine 执行开始时 | 代码保证 |
| instance 放进 executor 指令 | graph-engine 代码 | 代码保证 |
| verdict pass 后移除 instance | graph-engine 代码 | 代码保证 |
| Composer 输出 instances | prompt 引导 | 不保证，校验兜底 |
| scheduler 选 instance | prompt 引导 | 不保证，但 scheduler 能看到 remaining |
| executor 只做指定 instance | prompt 引导 | 不保证 |

## 6. 全流程示例

### 6.1 规划阶段

```
用户: 调研6个agent方案
Clarifier: 澄清 → 6个方案清单 + 对比维度 + 客观呈现

Composer 输出:
  capabilities:
    - id: collect_evidence
      instances: ["agent_loop", "agent_team", "traework", "qoderwork", "workbuddy", "dumate"]
    - id: write_report
      instances: []
    - id: review_report
      instances: []
  
  blackboard_schema:
    fields:
      - key: collect_evidence_remaining
        desc: 未收集的方案
        bounded: true
      - key: summary
        desc: 摘要
        bounded: true

workflow-validator:
  collect_evidence 有 instances → blackboard 有 collect_evidence_remaining → 通过
  write_report instances 为空 → 不需要 remaining → 通过
  review_report instances 为空 → 不需要 remaining → 通过

plan_review: 人审通过
```

### 6.2 执行阶段

```
scaffold 初始化:
  blackboard.collect_evidence_remaining = ["agent_loop", "agent_team", ...]

轮1 scheduler:
  看 remaining: 6个 → 选 "agent_loop"
  输出: next_node=collect_evidence, instance="agent_loop"

scaffold 组装指令:
  "本次处理 agent_loop 方案的证据收集"

executor:
  收集 agent_loop → 产出 evidence/agent_loop.md

verifier: pass

scaffold 更新:
  remaining = remaining.filter(i => i !== "agent_loop")
  → ["agent_team", "traework", ...]

轮2 scheduler:
  看 remaining: 5个 → 选 "agent_team"
  ...

轮6 scheduler:
  看 remaining: 1个 → 选 "dumate"
  executor → pass → remaining = []

轮7 scheduler:
  看 remaining: 空 → collect_evidence 完成
  → 选 write_report（无 instance）
  → executor 写完整报告 → pass

轮8 scheduler:
  → 选 review_report（无 instance）
  → verifier pass/fail
  fail → diagnostician → scheduler retry（只重跑 write_report，不重跑 collect_evidence）
```

### 6.3 失败重试场景

```
轮3 executor 执行 traework → 产出垃圾（像过程日志）
→ artifact contract fail → diagnostician 归因 F
→ scheduler 决策 retry_with_feedback
→ 输出: next_node=collect_evidence, instance="traework"
→ scaffold 组装指令带 fail feedback:
   "上次 traework 证据产出像过程日志。请改进。"
→ executor 只重做 traework
→ agent_loop/agent_team 不受影响（已 passed）
```

## 7. 与设计文档的关系

本方案不改变设计文档的架构原则，是已有机制的落地：
- "同一节点可被多次调度"（设计文档 2.1）→ instances + remaining 机制
- "scheduler 吃 blackboard"（设计文档 3.1）→ scheduler 看 remaining 选 instance
- "blackboard 由更新记忆节点维护"（设计文档 2.3）→ scaffold 初始化 + 代码更新 remaining
- "claim 不是 deliverable"（设计文档 6.1）→ instance 从 scheduler decision 来，不从 claim 提取
