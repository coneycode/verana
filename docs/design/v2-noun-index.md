# Verana — 名词与流程总览

状态: [LOCKED] 2026-08-14
关联总纲: `v2-orchestration-design.md`

本文是 Verana 所有名词的权威索引。每个名词只定义一次,说明做什么、不做什么、跟谁配合。
流程图展示名词之间的数据流和协作关系。

---

## 1. 三层职责

| 层 | 名称 | 职责 | 不做什么 |
|----|------|------|----------|
| L0 | Scaffold | 目录约定 + 状态机 + 执行引擎(router/事件日志/快照/artifact contract) | 不规划、不执行具体工作、不判断语义质量 |
| L1 | Composer | 编译目标 → 能力清单 + 护栏 + blackboard schema + 完成标准 | 不执行、不验证 |
| L2 | Executor | 调现成框架(Hermes/Claude Code)执行重节点 | 不规划、不调度 |

---

## 2. 核心名词

### 2.1 静态对象(规划产出,plan_review 后锁定)

| 名词 | 定义 | 来源 |
|------|------|------|
| Project | 一次完整交付诉求,独占目录,粗粒度生命周期状态 | 用户创建 |
| Workflow | 项目某阶段的执行规格 = 能力清单 + 护栏 + blackboard schema + 完成标准 | Composer 生成 |
| Capability(能力节点) | 可被反复调用的执行单元。轻节点(单次调用)或重节点(自主 agent) | Composer 生成 |
| Guardrail(护栏) | 红线。硬护栏(数字上限,代码判,引擎级强制)+ 软护栏(语义红线,独立模型检查) | Composer 生成 |
| Blackboard Schema | 跨轮记忆结构定义。哪些字段、是否需压缩 | Composer 生成 |
| Deliverable Contract | 交付物结构要求(required_sections / forbidden_patterns)。由 Composer 根据任务输出,不硬套通用默认 | Composer 生成 |
| Agent | 重节点背后的执行角色(prompt/模型/工具权限/skill) | Composer 生成 |
| Skill | 可复用知识包(SKILL.md),可临时生成或从 shared 复用 | Composer 生成 |

### 2.2 动态对象(执行中变,恢复关键)

| 名词 | 定义 | 来源 |
|------|------|------|
| Blackboard | 跨轮运行时记忆。scheduler 和节点只吃它,不吃全历史 | 更新记忆节点维护 |
| Run | 一次节点的实际执行记录,含 claim/stream/artifact snapshot/verdict | executor 执行 |
| Event Log | append-only 事件日志(执行轨迹+留痕+恢复依据) | scaffold 自动记录 |
| Snapshot | 状态快照(游标+blackboard 当前值),每节点完成打一次 | scaffold 自动记录 |
| Progress Truth(进度真相) | 带 verdict 的执行轨迹摘要,机械折叠,喂给 scheduler | scaffold 从事件日志构建 |

### 2.3 角色(LLM 承担,单一职责)

| 名词 | 职责 | 不做什么 | 模型角色 |
|------|------|----------|----------|
| Clarifier | 把粗目标变成可执行:一次性批量问答 + 二次校验追问 | 不规划 | composer |
| Composer | 编译目标 → 能力清单 + 护栏 + blackboard schema + 完成标准 | 不执行、不调度 | composer |
| Sufficiency Checker | 独立检查 Composer 输出:路径完备/指令具体/验收对齐 | 不决策 | evaluator |
| Scheduler | 唯一调度决策出口。看进度真相+blackboard,选下一步节点+理由 | 不执行、不验证、不归因 | composer |
| Executor | 只干活,产出 claim + 声明输出的磁盘产物 | 不规划、不验证 | hermes(composer fallback) |
| Artifact Collector | 收集 node.outputs,冻结 snapshot,机械契约检查(通用层) | 不做语义判断 | 代码(非LLM) |
| Materializer | scheduler 触发的兜底:从 claim/stream/坏 artifact 整理正式产物 | 不决策(由 scheduler 触发) | evaluator |
| Verifier | 只判对错。判 artifact snapshot,输出 verdict(passed/fail+reasons) | 不归因、不决定下一步 | evaluator |
| Diagnostician | 只归因。拿 verdict fail + claim + artifact + 指令 + 上下文,输出单一主根因 | 不决策、不修复 | evaluator |

### 2.4 事实对象(不可变,验证链路)

| 名词 | 定义 | 信任度 |
|------|------|--------|
| Claim | executor 对本次 run 的自述证词 | UNVERIFIED,只供 diagnostician 参考 |
| Stream | executor 运行过程日志(stdout/工具调用过程) | OBSERVATION ONLY,不参与交付 |
| Artifact Snapshot | 从 node.outputs 冻结的不可变产物快照 | VERIFIER 的唯一正文输入 |
| Artifact Report | 机械契约检查报告(存在/非空/不像过程日志/格式 parse) | 代码生成,事实 |
| Verdict | verifier 独立判定(pass/fail + reasons + evidence) | 真相,引用 artifact snapshot |

### 2.5 机制对象

| 名词 | 定义 |
|------|------|
| Diagnosis | diagnostician 的归因结果:六类根因(A-F)之一 + 说明 |
| Scheduler Decision | scheduler 的决策输出:next_node + reason + action + is_complete |
| Root Cause Type | 六类:A=指令不具体 B=能力缺口 C=上下文错 D=标准不合理 E=目标问题 F=产物契约失败 |
| Action | scheduler 路由动作:execute/retry_with_feedback/switch_node/request_capability/skip_node/materialize/human/resume |
| Max-turns Review | Composer 对 max-turns hit 的复核:resume(续接)/reframe(拆分调整)/abandon(放弃) |
| Execution Facts | 机械收集的执行轨迹事实(产出文件状态/stream行为/已用轮次),喂给 Composer 复核 |

---

## 3. 流程图

### 3.1 完整流程(事前保证 + 事后归因)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        事前保证(阶段一~三)                           │
│                                                                     │
│  用户目标                                                            │
│    │                                                                │
│    ▼                                                                │
│  Clarifier ──批量问答 + 二次校验──→ 澄清信息(硬约束/软引导/验收标准)     │
│    │                                                                │
│    ▼                                                                │
│  Composer ──生成──→ 能力清单 + 护栏 + blackboard schema + 完成标准     │
│    │                         + deliverable contract                  │
│    ▼                                                                │
│  Sufficiency Checker ──检查──→ 三层审查(路径/指令/验收)                │
│    │                ↗ 打回重生成(机械循环,≤3次)                        │
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

### 3.2 max-turns 动态调整流程(执行续接)

```
executor 执行到达 max-turns
  │
  ▼
代码机械收集执行轨迹事实(不调 LLM):
  - 产出文件状态(不存在/内容少/在增长)
  - stream 最后 N 轮行为(搜索/写文件/重复)
  - 已用轮次 / 是否已 resume 过
  │
  ▼
Composer 复核(拿 spec + 执行轨迹事实)
  │
  ├─ resume → hermes --resume <session_id> --max-turns <上调值>
  │           ↓ 续接同一会话,执行完成后正常走 artifact contract → verifier
  │
  ├─ reframe → 拆分节点/调整 check → 交 scheduler 路由
  │
  └─ abandon → 交 scheduler 走正常 fail 路由(retry/materialize/human)

防呆:同一 run 最多 resume 1 次;累计上限 = 原值 × 2
```

### 3.3 Artifact Contract 链路(事实层,代码驱动)

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

### 3.4 SSE 事件流(控制面)

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
  ├─ max_turns_review → Composer 复核结果展示 + refresh
  ├─ human_required → 人审卡 + refresh
  └─ 未知事件 → refresh(不丢弃)
```

---

## 4. 名词配合关系

### 4.1 规划阶段配合

```
用户目标 → Clarifier → 澄清信息
  → Composer → spec(能力清单+护栏+blackboard schema+完成标准)
  → Sufficiency Checker → 通过?
     ├─ 是 → plan_review(人审)
     └─ 否 → 带问题重生成(机械循环)
```

### 4.2 执行阶段配合

```
Scheduler(看进度真相+blackboard) → 选节点
  → 软护栏检查 → Executor 执行 → claim+磁盘产物
  → Artifact Collector → 冻结+机械检查 → Artifact Report
  → (契约pass) Verifier 语义判定 → verdict
  → (verdict pass) 更新 blackboard → 快照 → 下一轮
  → (verdict fail) Diagnostician 归因 → 根因写入进度真相
  → 下一轮 Scheduler 看根因决策路由(retry/materialize/human)
```

### 4.3 关键铁律

1. scheduler 吃 verdict 事实,不吃 claim
2. verifier 只看 artifact snapshot,不看 claim
3. claim 永远不是 deliverable
4. materialize 是 scheduler 的 action,不是自动旁路
5. materialize 不算 retry,max_retries 只拦截 retry
6. 调度决策唯一出口是 scheduler
7. scaffold 不越界做规划(不帮 Composer 拆节点)
8. deliverable_contract 做不到通用就不硬做(没有 base 默认章节)
9. SSE 发 unnamed event,前端 onmessage 统一分发
10. max-turns hit 不直接判 fail,交 Composer 复核(机械事实+LLM判断)
11. resume 不从头开始,续接同一 executor 会话(hermes --resume)
12. 同一 run 最多 resume 1 次,max-turns 累计上限 = 原值 × 2

---

## 5. 待实现的设计方向(未锁定)

以下方向已讨论但未落地,记录在此供后续迭代:

### 5.1 节点拆细 + 精准重试

方向:
- Composer 按"功能"拆节点(不按产出物)
- 一个功能 = 一个节点 = 可被多次调度
- 例:collect_evidence(一个功能)被 scheduler 调6次,每次收集一个方案
- executor 看 blackboard 判断"这次做哪个没做的"

待解决:
- blackboard 里需要进度追踪结构(框架级固定 key,value 填业务值)
- Composer 输出 instance 清单(什么算一个 instance)
- executor 怎么知道"这次做哪个"(看 blackboard 已完成列表)

### 5.2 迭代提升输出质量

方向:
- verifier fail reason 写具体不足(不是"结构不完整"而是"缺对比表格")
- buildProgressTruth 保留完整 fail reason,按同节点连续展示
- scheduler 看连续 fail reason 判断"改善/停滞"
- 改善 → 继续 retry;停滞 → 换策略
- fail feedback 带上次产出 → executor 在基础上改进而非从头重写

待解决:
- 节点拆细是前提(粗节点产出大,放不进指令)
- "判断改善还是停滞"只能靠 LLM,代码提供信息不替 LLM 判断
