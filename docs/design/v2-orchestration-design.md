# Verana v2 — 项目制 Agent Workflow 交付脚手架 设计文档

状态: v1 方案交付闭环已实现并端到端验证通过(真实 LLM)
版本: v0.3(实现阶段同步 — LLM 切 Anthropic 原生 API、引导式 Web UI、端到端验证)
最后更新: 2026-07-01
本文记录已锁定的设计决策。每节标注:
[LOCKED] 已确认 · [DEFERRED] 推迟 · [PARTIAL] 第一版部分实现 · [OUTLINE] 仅预留接口

> 版本演进见 git log(每条设计决策一个 commit)。

---

## 0. 历史背景

仓库曾有一版 **spike**(单阶段、内存态、executor 硬编码 Claude Code:
refine → 提议任务 → 逐个执行 → 独立验证)。**该代码已清空**,v2 从零写
(见第 15 节代码策略)。

spike 验证过、本设计继承的经验:
- 平台拥有真相,agent self-report 只是 claim,平台的 verdict 才是真相
- 反黑盒门控 + 增量交付
- Fastify + SSE 实时事件流
- AgentReport / Verdict 双对象
- 隔离 workdir + 每任务 git 快照(implementation 阶段)
- LLM 当 planning brain、JSON 提取的鲁棒处理

v2 相对 spike 的演进:项目制(独占目录,非内存态)· 双阶段(方案 → 实现)·
动态合成 agent/skill/script(非硬编码)· 能力矩阵驱动多 executor · 允许长时间运行。

---

## 1. 核心概念与边界 [LOCKED]

### 对象定义

| 对象 | 定义 |
|------|------|
| Project | 一次完整交付诉求,独占一个目录,有粗粒度生命周期状态。**含多个 workflow** |
| Workflow | 一个项目某一阶段的框架无关执行规格 (`workflow.yaml`)。**一个项目多个 workflow**:`solution`(方案)和 `implementation`(实现),方案闭环是实现的前置门。每个 workflow 有自己的执行状态机 |
| Agent | 为项目合成的执行角色;**持久对象**,一个角色可被执行多次,每次是一个 run。含 prompt/模型/工具权限/挂载 skill,映射到某 executor |
| Skill | 可复用知识/能力包 (SKILL.md + 附件),开放标准;可临时生成,也可从 shared 库复用 |
| Script | 确定性可执行代码(调研抓取、验证、部署),agent 调用但不靠即兴发挥 |
| Task | 一个 workflow 内 DAG 的单个节点,有自己的状态机(见第 5 节) |
| Run | 一次 agent/script 的实际执行记录,含 self-report、日志、产物;结果为 passed/failed/needs_input |
| Verifier | 独立于 agent 的验收者,产出 verdict。agent 说"我完成了"只是 claim |

### 三层职责

- **L0 Scaffold** — 目录约定 + 状态机 + 规格,本身不交付
- **L1 Composer** — 编译目标 → workflow,动态合成 agent/skill/script
- **L2 Executor** — 调现成框架 (Hermes / Claude Code / OpenCode) 真正执行

---

## 2. 目录结构 [LOCKED]

```
<scaffold-root>/
├── projects/
│   └── <project-id>/
│       ├── project.yaml              # 静态元信息 + 项目级生命周期状态 [系统建]
│       ├── status.yaml               # 高频运行态:活动 workflow/task、阻塞、恢复点 [系统维护]
│       ├── goal.md                   # 原始诉求 + 澄清对话 [用户+系统]
│       ├── decisions.md              # 用户确认过的关键决策 [审批门写入]
│       │
│       ├── solution/                 # 方案阶段 workflow 产出
│       │   ├── workflow.yaml         # 方案阶段规格 [Composer]
│       │   ├── solution.md           # 方案交付物 [agent 产出,人审]
│       │   ├── research/
│       │   │   ├── findings.md
│       │   │   └── evidence/         # 网页快照/API 结果/样例数据
│       │   └── review.md             # 方案审查意见 [Critic]
│       │
│       ├── implementation/           # 实现阶段 [方案闭环后才创建]
│       │   ├── workflow.yaml
│       │   └── ...                   # 第二阶段细化(第 10 节)
│       │
│       ├── agents/                   # 项目私有 agent 定义 [Composer]
│       │   └── <agent-name>.yaml
│       ├── skills/                   # 项目私有 skill
│       │   └── <skill-name>/SKILL.md
│       ├── scripts/                  # 确定性脚本
│       │   └── <script>.py|sh
│       │
│       └── runs/                     # 扁平结构,meta.yaml 标 phase
│           └── <run-id>/
│               ├── meta.yaml         # agent/时间/executor/状态/phase/task
│               ├── claim.md          # agent 自报(unverified)
│               ├── verdict.yaml      # verifier 独立判定(source of truth)
│               ├── log.md
│               └── artifacts/
│
└── shared/                           # 跨项目公共组件库 [框架无关]
    ├── agents/
    ├── skills/
    └── scripts/
```

决策要点:
- `solution/` 和 `implementation/` 各自独立 workflow.yaml;implementation 方案闭环后才创建
- `agents/ skills/ scripts/` 放项目根级,两阶段共享
- `runs/` 扁平,meta.yaml 里标 `phase`(solution/implementation)+ `task` 字段
- `project.yaml`(静态)与 `status.yaml`(运行态)分开,避免频繁写大文件
- **解析优先级:项目私有 > shared**;Composer 先找项目目录,再找 shared,没有才临时生成
- shared/ 用脚手架自己的库(框架无关);adapter 执行时把 skill 同步到目标 executor 目录
- **可复用提升 = 系统筛选提议 + 人工确认拍板**(第 14 节;第一版手动)

---

## 3. Executor 适配机制 [LOCKED]

- skill 写**框架无关的开放标准** (SKILL.md);adapter 执行前放到目标 executor 的原生路径
- agent 写**自己的抽象定义**;adapter 翻译成 executor 启动配置
- **不写 executor 专用格式**,否则换框架就要重写,中间层失去意义
- script 完全框架无关

### Executor 选择:能力矩阵反向选

Composer 从 workflow 提取 `required_capabilities`,在能力矩阵里筛选最合适的 executor。

能力矩阵分工:
- **能力维度 (schema)**:脚手架中心定义,不可协商的词汇表
  (mcp / subagents / session_resume / cron / webhook / web / browser / terminal / file / long_running ...)
- **静态能力值**:adapter 作者手填声明 (`capabilities` 文件)
- **可用性**:脚手架启动时 probe 检测(装没装、版本、命令可用)
- **质量校准**:运行时根据 run 结果回填 —— **第一版留接口,不实现**

第一版做到 **B 档**(维度 schema + adapter 手填 + 启动 probe),质量校准留接口。
加新 executor = 加一个 adapter + 一份 capabilities 声明,不改核心。

### adapter 接口

```
interface ExecutorAdapter {
  name: string                       // "hermes" | "claude-code" | "opencode"
  capabilities: CapabilityDecl       // 能力声明(手填)
  probe(): ProbeResult               // 启动时检测:装没装、版本、可用性
  prepare(agentCfg, workdir): void   // 翻译:skill 放原生路径、拼启动参数、注入权限
  execute(agentCfg, workdir): AgentRun  // 启动 executor,跑一个 task
  collect(run): AgentClaim           // 收集产物 + agent 自我汇报(claim)
}
```

### 执行一个 task 的流程

1. Composer 已选定 executor
2. `prepare`:把 task 需要的 skill 同步到 executor 原生路径(如 ~/.hermes/skills/),
   把 agent 的 system prompt / 工具权限 / 模型拼成启动参数,**权限提前注入**
3. `execute`:在隔离 workdir 启动 executor 跑一次性命令(非交互)
4. `collect`:收产物 + agent claim(写 claim.md)
5. 交 verifier 独立判定(第 7 节);verifier 不信 adapter 收上来的 claim

### workdir:项目级

- workdir 以**项目为单位**(`projects/<id>/` 即 workdir),task 产物按 outputs 路径写入
- research 阶段**不强制 git**;implementation 阶段再引入 git 隔离

### 调用方式:一次性命令

- adapter 统一用一次性命令模式(`hermes chat -q` / `claude -p`),非交互
- 长任务靠 executor 自身机制(后台/长会话),adapter 轮询或等待

### 交互处理(两层,分清)

**层面1:executor 内部工具批准** → **不交互**。prepare 阶段提前注入权限;
授权内自己跑,不弹窗;超范围操作**直接拒绝**(不等人批)。

**层面2:任务级缺信息**(agent 需用户决策才能继续)→ executor **不挂起等 stdin**,而是:
1. agent 把"需要什么信息才能继续"作为 run 产出汇报(写进 claim),run **正常结束**,标记 `needs_input`
2. adapter.collect 发现 needs_input → task 进 `awaiting_input`,workflow 在此暂停
3. 系统把所需信息推给用户(第 12 节控制面 + 主动提醒)
4. 用户补充 → 写进 task inputs/上下文
5. 重跑该 task(新 run),带上补充信息

为什么不让 executor 真交互式等待:长任务可能等几小时/几天,进程挂着等 stdin 脆弱
(崩溃/重启就丢);run 结束 + 状态暂停 + 信息落盘(status.yaml 记在等什么),可跨重启恢复(第 9 节)。
前提:system prompt 约束 agent "遇到必须用户定的信息就停下汇报,不要臆测"。

### 第一版

主攻 **Hermes**(覆盖 web/browser/cron/长任务/skills,正好对应方案阶段);
Claude Code 留作第二个(implementation 阶段代码交付更合适)。

---

## 4. workflow.yaml 中间规格 v0.1 [LOCKED]

结构性决策:
- **显式 DAG**(`depends_on`),不把编排权交给黑盒 agent
- task 用**自然语言详细描述**:做什么事、输出什么数据
- **数据流 inputs/outputs** 与顺序依赖 depends_on 分开表达
- **两层验收**:`goal.acceptance`(总验收)+ `task.checks`(局部验收)
- **一个 workflow 一个 executor**;需要不同能力就拆 workflow
- 触发方式第一版手动,后续探索自动化

```yaml
version: "0.1"
project_id: "2026-06-30-influencer-monitoring"
phase: solution                      # solution | implementation

goal:
  raw: "帮我调研做一个海外红人监控系统"
  clarified: |
    监控 YouTube/TikTok 指定红人,周期采集粉丝数与互动数据,
    每周输出一份结构化报告。
  deliverable_type: research          # research | implementation
  acceptance:                         # 整个 workflow 闭环的总验收
    - 覆盖至少 3 类候选数据源方案
    - 每个方案有成本/合规/可行性评估
    - 有明确推荐方案和理由
    - 有下一阶段实施任务拆解

clarifications:
  - q: "监控哪些平台?"
    a: "YouTube 和 TikTok"
  - q: "数据更新频率?"
    a: "每周一次"

required_capabilities: [web, browser, long_running]
selected_executor: hermes

agents: [researcher, analyst, critic]
skills: [web-research, api-feasibility]
scripts: [fetch_platform_sample.py]

tasks:
  - id: t1
    desc: |
      调研海外红人监控的数据获取方案,覆盖官方 API、
      第三方数据服务、自建爬虫三类。每个方案查清字段、
      调用限制、费用、合规风险、接入难度。
    agent: researcher
    skills: [web-research, api-feasibility]
    outputs:
      - path: solution/research/findings.md
        desc: "三类方案详细调研记录"
      - path: solution/research/evidence/
        desc: "文档截图、定价快照、API 样例"
    checks:
      - method: file_exists
        target: solution/research/findings.md
        desc: "调研记录非空"
      - method: llm_rubric
        desc: "覆盖 >= 3 类数据源方案,每个有费用和合规结论"

  - id: t2
    desc: |
      基于 t1 调研,做可行性与成本对比分析,给出
      推荐方案和理由,并拆解下一阶段实施任务。
    agent: analyst
    depends_on: [t1]                  # 顺序依赖
    inputs:                           # 数据输入(path 或 ref)
      - path: solution/research/findings.md
        desc: "t1 产出的调研记录"
      - ref: goal.clarified
        desc: "澄清后的目标"
    outputs:
      - path: solution/solution.md
        desc: "方案交付物:对比表+推荐+实施任务拆解"
    checks:
      - method: llm_rubric
        desc: "有推荐方案及理由,有实施任务清单"

  - id: t3
    desc: |
      审查 solution.md,检查假设是否成立、是否有遗漏、
      推荐是否站得住,产出审查意见。
    agent: critic
    depends_on: [t2]
    inputs:
      - path: solution/solution.md
        desc: "待审查的方案"
    outputs:
      - path: solution/review.md
        desc: "方案审查意见"
    checks:
      - method: llm_rubric
        desc: "列出关键假设与风险"

gates:
  - id: g1
    after: t3
    type: human_approval              # 方案闭环必须人确认
    title: "方案审查确认"
    presents: [solution/solution.md, solution/review.md]
    options: [approve, reject]
    on_approve:
      writes: decisions.md
      next: approved
    on_reject:
      bounce_to: t2
      cascade: downstream
      feedback_to_context: true
    timeout: { after: 7d, action: hold, notify: true }
    audit: true

policies:
  long_running:
    idle_watchdog: 30m
    max_wall: 4h
  on_failure: stop_and_report
```

inputs vs depends_on 分工:
- `depends_on` — 控制执行顺序(DAG 边),解决"什么时候能跑"
- `inputs` — 声明数据来源(path 或 ref),解决"跑的时候吃什么";可并行但传数据,也可有序但不传数据

> gate 的完整字段语义见第 11 节;此处示例已与第 11 节模型对齐。
> check 的 method 取值见第 7 节。

---

## 5. 状态机:三层 [LOCKED]

状态分三层,职责清晰:**Project(大阶段)→ Workflow(阶段内执行)→ Task(DAG 节点)**,
加上 **Run 结果**作为 task 状态转移的输入。

### 5.1 Project 状态(粗粒度生命周期)

```
created → solutioning → solution_approved → implementing → delivered
                                                              ↘ cancelled(任意处)
```

- created — 项目刚建,目录初始化
- solutioning — 方案 workflow 进行中
- solution_approved — 方案闭环(solution workflow 跑完且人审通过)
- implementing — 实现 workflow 进行中(第一版不实现)
- delivered — 全部交付完成
- cancelled — 用户取消

Project 状态只表达"走到哪个大阶段",细节在 workflow 状态里。

### 5.2 Workflow 状态(每个 workflow 一套,solution / implementation 各跑一遍)

```
主流程:
clarifying          Clarifier 多轮澄清(solution workflow 首个必经;implementation 按需——
                    方案 handoff 来的目标通常无需澄清,但若执行中发现方案有问题可触发澄清)
  → goal_confirm    输出目标确认摘要,用户点头 ← 门:goal_confirm(轻)
  → composing       Composer 生成 workflow + agent/skill/script
  → plan_review     人审任务拆解 ← 门:plan_review
  → executing       按 DAG 跑 tasks(task 有自己的状态,见 5.3)
  → final_review    人审最终交付物(solution: solution.md;implementation: 代码) ← 门:final_review
  → approved        本 workflow 闭环

旁路状态:
  awaiting_input    有 task 在等用户输入(由 task 的 awaiting_input 冒泡)→ 补充后回 executing
  blocked           技术障碍(网络/报错/外部依赖)→ 重试或诊断后回 executing
  failed            失败且不可恢复
  cancelled         用户取消
```

- solution workflow 的 approved → 触发 Project 进入 solution_approved,再 handoff 创建 implementation workflow
- 三道门:goal_confirm(轻)、plan_review(审拆解)、final_review(审交付物)
- 卡住状态分开:awaiting_input(等人,可主动推送)vs blocked(技术障碍,可重试/诊断)

### 5.3 Task 状态(DAG 内单节点)

```
pending → running → verifying → delivered
                       ↘ failed
running → (run 返回 needs_input) → awaiting_input → (补充后) → running(新 run)
```

- pending — 已批准,未开始(上游依赖未就绪也停在此)
- running — adapter 正在执行(一个 run 进行中)
- verifying — run 结束,verifier 独立判定中
- delivered — verdict 通过
- failed — verdict 不通过且重跑用尽(第 7 节);冒泡为 workflow 的 blocked/failed
- awaiting_input — run 返回 needs_input,等用户补充

### 5.4 Run 结果 → Task 状态映射

一个 run 结束时返回三种结果之一:
- `passed` 倾向 → 进 verifying(仍由 verifier 独立判定,run 自报不算数)
- `failed` → verifying 判 FAIL → 重跑或 failed
- `needs_input` → task 进 awaiting_input(正常结束,非失败)

> run 自报的 passed 不等于通过;**一切以 verifier 的 verdict 为准**(第 7 节)。

---

## 6. 审批门 Gates [LOCKED]

Gate 的本质:执行流在某点暂停,等一个判定(人或机器),判定结果决定往哪走。
通用机制,方案阶段和实现阶段共用。

### 两种门类型

- **human_approval** — 暂停等人(方案确认、进入实现、危险操作);
  timeout 默认 hold + 主动提醒,**不自动拒绝**(避免丢失长任务成果)
- **auto_check** — 机器判定,check 条件满足(如 verifier 结果)自动放行,不烦人。
  **自动放行也必须留痕**:记日志(谁/何时/基于什么 check/放行了哪个门),
  和人工审批一样可追溯 —— 自动决策也不是黑盒

### 打回机制 (reject → bounce)

- `bounce_to` 指定打回的 task
- `cascade: downstream` 自动重跑该 task **及其所有下游依赖**(顺 DAG 往下,保证数据一致)
- reject 反馈写进重跑 task 的上下文,让 agent 知道为什么被打回、要改什么
- 每次重跑 = 一个新 run,记录到 runs/(agent 持久,执行多次=多个 run)

### Gate 模型

```yaml
gates:
  - id: g1
    after: t3                    # 触发点:某 task 后(或某状态进入时)
    type: human_approval         # human_approval | auto_check
    title: "方案审查确认"
    presents:                    # 决策依据(给审批人/自动判定看什么)
      - solution/solution.md
      - solution/review.md
    check:                       # 仅 type=auto_check:放行条件
      all_tasks_passed: true
    options: [approve, reject]
    on_approve:
      writes: decisions.md
      next: approved
    on_reject:
      bounce_to: t2              # 打回到哪个 task
      cascade: downstream        # 重跑它 + 所有下游依赖
      feedback_to_context: true  # reject 意见写进重跑上下文
    timeout:
      after: 7d
      action: hold               # 默认 hold,不自动拒绝
      notify: true               # 主动提醒
    audit: true                  # 所有放行(含 auto_check)留痕到日志
```

---

## 7. Clarifier 澄清对话机制 [LOCKED]

流程入口。把用户的流程目标从"太粗"变成"可执行"。

### 固定澄清维度(方案交付场景)

| 维度 | 澄清什么 |
|------|---------|
| 目标产出 | 要调研方案,还是直接落地实现?(决定 deliverable_type) |
| 范围边界 | 覆盖什么、不覆盖什么 |
| 输入来源 | 已知数据源/约束/资料 |
| 验收标准 | 什么样算"做好了" |
| 约束 | 预算、合规、时间、技术栈偏好 |

### 完整度评估 = 选项 3(混合)

固定维度做骨架,LLM 判断每个维度是否已满足,并补充场景特有的问题。
缺失或模糊的维度触发对应澄清问题。

### 提问方式

- **一次问一个**(不一口气甩多个问题)
- 每个问题附"**为什么问**" + 可选默认建议,降低用户负担
- 用户可回答,也可说"你来定 / 用默认"

### 风险告知(关键)

每当提一个澄清问题、或用户想跳过某维度时,Clarifier 必须附上
"**如果这块不明确,后果是什么**"。例:
- 不澄清"更新频率" → 可能按实时设计,成本高估/架构过重
- 不澄清"合规要求" → 推荐的数据源可能违反 ToS,实施阶段才返工
- 不澄清"预算上限" → 可能推荐昂贵第三方 API,不符成本预期

用户跳过 = **知情跳过**,风险**留痕**(写进 clarifications + decisions.md)。

### 软上限与收敛

- 澄清轮数软上限 **5-7 轮**
- 到顶提示"信息够了,我先生成方案摘要,你看了再补",强制收敛
- 退出条件:关键维度都有答案(或用户授权默认)→ 生成**目标确认摘要**
  → 进 `goal_confirm` 门让用户点头

### deliverable_type 可调整

`deliverable_type`(research / implementation)是**澄清的产出**,不是用户开口定死。
聊的过程中发现用户其实要实现而非调研,Clarifier 可调整它。
它决定后续 agent roster、验收标准、executor 选择。

---

## 8. Composer 动态合成机制 [LOCKED]

最核心也最难的一层。把澄清后的目标编译成一套可交付的执行资源。

### 输入 / 输出

输入:澄清后的目标(goal.clarified + clarifications + deliverable_type)、
shared/ 已有 agents/skills/scripts、能力矩阵(可用 executors)。

输出:workflow.yaml、agents/*.yaml、skills/*、scripts/*、selected_executor。

### 合成驱动 = 选项 3(LLM + 代码分工)

- **LLM 负责创造性**:任务分解、角色推导、生成 skill 内容
- **代码负责确定性**:DAG 校验、资源查找、能力匹配

内部步骤:
1. 任务分解:目标 → 任务 DAG(desc/inputs/outputs/checks)
2. 角色推导:每个 task 需要什么角色 → agent roster
3. 能力推导:workflow 需要哪些 capabilities → 选 executor
4. 资源匹配:每个 agent/skill/script,**先查项目私有,再查 shared,没有才临时生成**
5. 自检(见下)

### 三层自检(自检不轻,需自动化评测)

**第一层:确定性硬校验(代码,必过项;不过直接打回 Composer,不浪费人/LLM)**
- DAG 无环
- 每个 task.inputs 引用的 path 都有上游 outputs 产出(或来自 goal/已有文件)—— 数据流闭合
- 每个 task 有 checks(无验收不执行,铁律)
- 引用的 agent/skill/script 真实存在(项目私有/shared/已生成)
- selected_executor 能力覆盖 required_capabilities
- 每个 gate 的 bounce_to 指向真实 task

**第二层:质量评测(独立评测模型,产出评分+理由)**
- **必须用独立模型,不能既当裁判又当运动员**(评测模型 ≠ 生成模型,最好不同源)
- 评分维度(先暂定,后续迭代):
  - 任务分解合理性(粒度、是否覆盖 goal.acceptance 每条)
  - 验收充分性(checks 是否真能验证 deliverable,而非空泛)
  - 角色匹配度(agent prompt/权限/skill 是否匹配其 task)
  - 覆盖度(goal.acceptance 每条是否有 task 支撑)
  - skill 质量(临时生成的 SKILL.md 是否有实质内容)
- 每项给分+理由,低于阈值的项打回重生成或标记给人审重点看

**第三层:人审(plan_review 门,必过)**
- 人看到 workflow + 自检评分报告(哪些高分/被标记/临时生成需重点看)
- 让人审有的放矢,而非从零读
- **Composer 产出必须经人审,不直接执行**

### 重生成上限

自检打回重生成**上限 3 次**;超限带低分报告强制交人审(人决定手动改或放弃),
避免 LLM 反复刷不过卡死。

### 模型角色(脚手架的"大脑")

系统配置区分三类模型角色:
- **composer model** — 生成(分解、角色、写 skill)
- **evaluator model** — 评分(独立,最好不同厂商/模型,避免同源偏见)
- executor — Hermes/Claude Code 等,由能力矩阵选,是"手"不是"脑"

第一版默认配两个不同模型(composer / evaluator),允许用户覆盖。

---

## 9. Verifier / 方案闭环判定 [LOCKED]

产品灵魂:**agent 说"完成"只是 claim,verifier 的 verdict 才是真相**。

特殊性:方案阶段交付 research(文档/调研),不是代码,没法跑单元测试。
这是方案阶段 verifier 的核心难点 —— 主力靠 llm_rubric。

### 验证方法(task.checks 每条的 method,对应 goal.acceptance)

| method | 怎么验 | 适合 |
|--------|--------|------|
| command | 跑命令,exit 0 = 过 | 脚本产物、PoC、数据 schema 校验 |
| file_exists | 产物文件/目录真实存在且非空 | 确认 findings.md、evidence/ 非空壳 |
| llm_rubric | 独立 evaluator 模型按 rubric 打分 | research 质量验收(主力) |
| manual | 人工判定,人点头才是 verdict | 最终方案确认、主观质量 |

- **llm_rubric 用独立 evaluator 模型**(同 Composer 评测那套),
  verdict 必附"**判定理由 + 引用证据**"(指出报告哪段满足/不满足),不只给 pass/fail,可复核
- 一个 task 的 checks **支持多方法组合**,每条声明自己的 method,**全过才算 task 过**

### claim vs verdict(反黑盒核心)

- `runs/<run-id>/claim.md` — agent 自我汇报(原话,UNVERIFIED)
- `runs/<run-id>/verdict.yaml` — verifier 独立判定(pass/fail + 理由 + 证据,source of truth)
- **UI 并排展示**两者,把差距显式暴露:"agent 说做到 X / verifier 判定 Y"
- 黑盒 = agent 说完成你就信;白盒 = 它说的和真相摆一起给人看

### FAIL 后自动重跑(有上限,会升级)

FAIL 分两种性质:
- **可重跑**:agent 偷懒/漏做/质量不够 → 重跑能补齐
- **重跑也没用**:任务本身设计有问题(如要求调研一个根本不开放的 API)→ 重跑空转

机制:
1. FAIL → 带 verdict 的差距说明作为**反馈写进上下文**,自动重跑
2. **重跑上限 2 次**(比 Composer 的 3 次小,因为跑 agent 更耗时耗钱)
3. 超限仍 FAIL → **不再自动重跑,升级到人工**(task→failed,workflow→blocked):
   人判断 —— 任务设计错了改 workflow / 目标不现实回 Clarifier / 放弃该 task
4. 每次重跑是一个**新 run**(claim/verdict 各存一份),留痕可见"为什么还不过"

原则:自动重跑解决"质量不够",人工升级解决"任务本身有问题";不无限重跑(否则又成黑盒)。

---

## 10. 控制面 / 交互入口 [LOCKED]

决定产品形态:用户怎么交互、长任务怎么看进度和介入。

### 形态 = 选项 C(CLI 优先,Web 留接口)

- 第一版**纯 CLI** 验证闭环
- 后端从一开始做成 **API + 事件流(SSE)** 架构,逻辑不写死在 CLI 里
- 继承 spike 的 **Fastify + SSE** 架构思路(从零写,见第 15 节),Web UI 以后无缝接入

### Web 试用页面(第一版可视化入口)

为便于试用效果,第一版增加一个轻量 Web UI,由 Fastify 直接提供静态页面,不引入 React/Vite。
目标不是完整产品界面,而是把现有 CLI/API 闭环可视化:

- 新建项目(goal 输入)
- 项目列表 + 当前状态
- 澄清问题/风险提示 + 输入回答
- 生成 plan、审批 plan_review、执行 run、审批 final_review
- 展示 workflow task 状态、claim/verdict 日志入口
- 连接 SSE,收到项目事件后刷新

**实现状态(v0.3):** Web UI 已做成引导式步骤界面 —— 顶部步骤条(创建→澄清→合成→审Plan→执行→审方案→完成),
按当前 workflow 阶段动态渲染操作面板(按钮、输入框、风险提示),下方 Clarifier 问答记录 + Tasks 表 + Claim/Verdict 详情。
后端 API 已覆盖完整闭环(create/clarify/input/plan/approve/reject/run/runs/events)。

原则:Web UI 只调用后端 API,不复制业务逻辑;后续可替换成正式前端。

### 长任务推送

- 第一版:CLI 主动查(`verana status`)+ 本地事件流
- 推送通道(Telegram/邮件等)留到有需要再加(避免早期过度集成)

### 多项目总览

项目制 + 长任务 → 必然多项目并行,需要 `verana list` 总览所有项目状态。

### CLI 命令草案(实现时会调)

```
verana new [目标]          # 创建项目,进入澄清对话
verana clarify <id>        # 继续澄清(回答 Clarifier 的问题)
verana list                # 所有项目状态总览
verana status <id>         # 单项目详情:当前阶段/阻塞/进度/在等什么
verana plan <id>           # 查看 Composer 生成的 workflow + 自检评分报告
verana approve <id> [gate] # 通过一道门
verana reject <id> [gate]  # 打回(带反馈,触发 bounce 重跑)
verana input <id> [信息]   # 给 awaiting_input 的项目补充信息
verana run <id>            # 启动/继续执行(跑 DAG;自动检测中断点续跑)
verana logs <id> [run]     # 看某 run 的 claim/verdict/日志
verana cancel <id>         # 取消项目
```

后端 API 一一对应这些动作 + 一条 SSE 事件流(参考 spike 的 ProjectEvent:
status_changed / task_updated / approval_required / verdict / log 等)。

---

## 11. 长任务运行与恢复 [LOCKED]

"自动化流程根据任务复杂度,允许长时间运行"。两种"长"分开处理:

- **单 run 内部的长**(一个 task 跑很久):executor 自管,`policies` 的
  idle_watchdog / max_wall 兜底(借鉴 Multica:看活动而非墙钟,**静默才杀**)
- **跨 run / 跨时间的长**(多 task、卡在 awaiting_input 等人、机器重启):靠下面的恢复机制

### 恢复模型

核心原则:**进程无状态,磁盘是唯一真相**。任何时刻进程挂掉/机器重启,都能从磁盘恢复到中断点继续。

- 单一真相在磁盘:project.yaml(静态)+ status.yaml(运行态:活动 workflow/task、各 task 状态、在等什么、DAG 进度)+ runs/ 各 run 状态
- 内存不存权威状态,**内存只是磁盘的缓存**
- **每个 task 完成(verdict 出来)是天然检查点**:产物已落盘,状态已更新
- 恢复时:读 status.yaml,**跳过已完成 task,从未完成处继续**(已完成的不重跑)

### 中断点恢复策略

| 中断在 | 恢复后 |
|--------|--------|
| awaiting_input | 仍等用户补充(信息需求已落盘) |
| executing(run 半截挂掉) | 该 task **整体重跑**(新 run,丢弃半成品) |
| gate 等审批 | 仍等审批 |
| blocked | 重试或等人 |

### 重跑粒度

run 跑一半进程挂了 → 该 task **整体重跑**,不做 task 内部断点续传
(现成框架做不到;task 拆够细则重跑一个 task 代价可接受)。

### 恢复触发

第一版 **手动**:用户 `verana run <id>` 时系统自动检测中断点并续。
守护进程式自动恢复留到以后(符合人在环——恢复前用户能先看状态再决定)。

---

## 12. 权限与安全边界 [DEFERRED — 推迟到闭环跑通后]

**推迟理由**:权限是"加固"环节,不是闭环本身。第一版要先证明
"目标 → 方案 → 验证"这条链能跑通。过早设计权限会拖慢核心验证,
且现在定的边界等真跑起来很可能推翻重来。

**第一版最低安全底线(现有设计已自带,无需额外工作):**
- workdir 隔离:agent 只在 `projects/<id>/` 里跑(第 3 节已定)
- secrets 不进 git:`.env` 已在 `.gitignore` 排除

**推迟的细节(闭环跑通后再设计):**
- 工具权限白名单(per-task allowedTools,最小权限、按需提权)
- 文件系统边界强约束
- secrets 注入机制(.env → 环境变量,或 keychain/外部 secrets manager)
- 危险操作拦截(命令黑白名单,长任务无人值守时尤其重要)

---

## 13. 跨项目知识沉淀 [PARTIAL — 第一版手动,自动沉淀推迟]

飞轮:项目里临时生成的 agent/skill,好用的提升成 shared/ 公共组件。

**第一版只做手动:**
- shared/ 目录保留,解析优先级 项目私有 > shared(第 2 节已定)
- 用户/开发者手动把好用的 agent/skill 复制进 shared/,Composer 资源匹配即可查到复用
- 复用通路通,飞轮靠"手动转动"

**推迟到后续迭代:**
- 自动筛选(信号:复用频次 / 质量分 / 验证通过 / 通用性)
- 提升提议(独立异步动作,如 `verana distill`,借鉴 Hermes curator)
- 泛化改写(LLM 去掉项目特定内容)
- shared 组件版本管理(更新不影响已跑完项目)

以后加自动筛选不需改结构。

---

## 14. 技术栈与实现形态 [LOCKED]

### 语言 / 运行时:Node / TypeScript

擅长本产品都要的事:CLI + Web + 调外部 CLI(executor)+ SSE 事件流。
LLM 对本产品只是 HTTP 调用,不需要 Python 生态。

### 状态存储:纯文件(yaml/json)

- 项目目录即真相,契合"透明可审计"卖点;状态用 yaml 落在目录里,人可直接看、可 git
- 多项目列表靠扫描目录;SQLite 索引留到项目多了再加

### LLM 调用层:薄 client 抽象

- 配 base_url + model + key;composer model 与 evaluator model 各配各的,支持不同源(第 8 节要求)
- **实现:HttpLlmClient 用 Anthropic 原生 Messages API**(/v1/messages,x-api-key,anthropic-version);
  配置文件 verana.config.yaml(gitignored)填 base_url/model/api_key,两个角色必须不同模型
- 接口抽象为 LlmClient(complete / completeJson),换协议(如 OpenAI 兼容)只需换实现类

### 代码策略:从零写,不复用旧 spike 代码

- 旧 spike 是单阶段/内存态/硬编码 Claude Code,数据模型、状态机、存储全变了;
  在旧地基上改比从零写更慢
- 代码从**设计文档**长出来(符合文档驱动工作流),不从旧代码长出来
- 只**借鉴验证过的架构思路**(一行旧代码不抄),清单见第 0 节

---

## 15. 第二阶段:代码/自动化交付闭环 [OUTLINE — 第一版不实现,仅预留接口]

方案闭环后的延伸。第一版不实现,此处记录轮廓 + 衔接点 + 差异,确保方案阶段设计能平滑接入,不返工。

### 同一 project 下两个 workflow(根基)

方案阶段(solution/)和实现阶段(implementation/)是**同一个 project 下的两个 workflow**,
共享 goal / agents / skills / scripts / 上下文。实现阶段大量引用方案产出,不另起 project
(割裂上下文)。(第 1 节已定)

### handoff(方案 → 实现)

- 方案 approved 后,Project 进入 solution_approved;solution.md 已含"下一阶段实施任务拆解"
- handoff 动作:基于拆解创建 implementation/ 目录 + 生成 deliverable_type=implementation 的 workflow.yaml
- 然后 Project 进入 implementing

### 与方案阶段的差异(机制已埋好)

| 维度 | 方案阶段 | 实现阶段 |
|------|---------|---------|
| executor | Hermes | Claude Code(能力矩阵自动切) |
| agent roster | researcher/analyst/critic | planner/builder/reviewer |
| verifier 主力 | llm_rubric | command/tests + anti-cheat(检测改测试文件作弊) |
| workdir | 不强制 git | git 隔离 + 每任务 diff + 检查点提交 |
| gate | plan/final review | 增加 per-task diff 审批 |

### 通用复用(不用重做)

workflow schema、DAG、三层状态机、gates、claim/verdict、长任务恢复、Composer 三层自检 —— 全通用。

---

## 附录:设计项状态总览

核心设计:
- [x] 1. 核心概念与边界
- [x] 2. 目录结构
- [x] 3. Executor 适配机制
- [x] 4. workflow.yaml
- [x] 5. 状态机(三层)
- [x] 6. 审批门 Gates

执行机制:
- [x] 7. Clarifier 澄清对话机制
- [x] 8. Composer 动态合成机制
- [x] 9. Verifier / 方案闭环判定

支撑能力:
- [x] 10. 控制面 / 交互入口
- [x] 11. 长任务运行与恢复
- [~] 12. 权限与安全边界(推迟)
- [~] 13. 跨项目知识沉淀(第一版手动)

落地:
- [x] 14. 技术栈与实现形态
- [~] 15. 第二阶段:代码/自动化交付闭环(轮廓预留,第一版不实现)

---

第一版实现范围:方案交付闭环
Clarifier(澄清)→ Composer(动态合成 + 三层自检)→ Executor/Hermes(执行)
→ Verifier(独立判定)→ 三道门人审,CLI + 文件状态 + SSE 后端。
推迟/预留:12 权限安全、13 自动沉淀、15 实现阶段。

---

## 附录 B:实现状态(v0.3, 2026-07-01)

已实现并端到端验证通过(真实 LLM,非 mock):

| 模块 | 文件 | 状态 |
|------|------|------|
| 项目存储(文件状态) | project-store.ts | done — create/list/get/save + gate 审批 |
| Clarifier 澄清 | clarifier.ts | done — LLM 多轮提问 + 风险告知 + 软上限 |
| Composer 合成 | pipeline.ts | done — LLM 生成 workflow DAG + 硬校验 + 资源写入 |
| Verifier 验证 | pipeline.ts | done — 独立 evaluator 模型 + claim/verdict |
| Executor 适配 | executors.ts | stub — HermesAdapter.probe() 占位,实际执行由 pipeline 内 LLM 直跑 |
| LLM Client | llm.ts | done — Anthropic 原生 Messages API,config 文件驱动 |
| CLI | cli.ts | done — new/list/status/clarify/input/plan/approve/reject/run/logs/cancel |
| Fastify + SSE | server.ts | done — 全闭环 REST API + SSE 事件流 |
| Web UI | web.ts | done — 引导式步骤界面,覆盖完整闭环 |
| Workflow 校验 | workflow-validator.ts | done — DAG 无环 + checks 存在 + 依赖闭合 + gate bounce |
| 测试 | tests/ | 19 tests pass — 覆盖 store/clarifier/composer/verifier/server/validator |

已知 gap(设计已定但实现未跟上):
- Executor 适配层:设计第 3 节的 prepare/execute/collect 接口未实现,pipeline 内直接调 LLM 代替 executor
- Composer 三层自检:只做了第一层(代码硬校验),第二层(独立模型评分)和第三层(人审报告)未实现
- Verifier 自动重跑:FAIL 即停,未实现带反馈重跑(上限 2 次)
- goal_confirm 门:未实现(澄清后直接可 plan,无目标确认摘要门)
- 实现阶段:完全未实现(第 15 节,仅预留)
