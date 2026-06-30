# Verana v2 — 项目制 Agent Workflow 交付脚手架 设计文档

状态: 讨论中 (设计阶段)
最后更新: 2026-06-30
本文记录已锁定的设计决策。每条决策标注 [LOCKED] 表示已与产品负责人确认。

---

## 0. 与现有 spike 的关系

当前仓库 (`server/`, `client/`) 已有一版**单阶段 MVP**:
`refine → 提议任务 → 逐个执行 → 独立验证`,executor 硬编码为 Claude Code
(见 `server/src/types.ts`, `composer.ts`, `refiner.ts`, `verify.ts`, `runtime.ts`)。

它的核心哲学(平台拥有真相、agent self-report 只是 claim、反黑盒门控、增量交付)
**继续保留**。v2 在其之上演进为:

- 项目制(每个项目独占目录),而非单进程内存态
- 双阶段(方案交付闭环 → 代码/自动化交付闭环)
- 动态合成 agent/skill/script(不再硬编码角色)
- 能力矩阵驱动的多 executor 选择(不再绑死 Claude Code)
- 允许长时间运行

原则:grow it, not tear it down — 保留好骨架(状态机、verifier、SSE、门控),
替换硬编码部分。

---

## 1. 核心概念与边界 [LOCKED]

### 对象定义

| 对象 | 定义 |
|------|------|
| Project | 一次完整交付诉求,独占一个目录,有生命周期状态 |
| Workflow | 一个项目的框架无关执行规格 (`workflow.yaml`),系统编译目标后的中间表示。**一个项目多个 workflow**:`solution-workflow` 和 `implementation-workflow`,方案闭环是实现的前置门 |
| Agent | 为项目合成的执行角色;**持久对象**,一个角色可被执行多次,每次是一个 run。含 prompt/模型/工具权限/挂载 skill,映射到某 executor |
| Skill | 可复用知识/能力包 (SKILL.md + 附件),开放标准;可临时生成,也可从 shared 库复用 |
| Script | 确定性可执行代码(调研抓取、验证、部署),agent 调用但不靠即兴发挥 |
| Run | 一次 agent/script 的实际执行记录,含 self-report、日志、产物 |
| Verifier | 独立于 agent 的验收者,产出 verdict。agent 说"我完成了"只是 claim |

### 三层职责

- **L0 Scaffold** — 目录约定 + 状态机 + 规格,本身不交付
- **L1 Composer** — 编译目标 → workflow,动态合成 agent/skill/script
- **L2 Executor** — 调现成框架 (Hermes / Claude Code / OpenCode) 真正执行

---

## 2. Executor 适配机制 [LOCKED]

- skill 写**框架无关的开放标准** (SKILL.md);adapter 执行前放到目标 executor 的原生路径
- agent 写**自己的抽象定义**;adapter 翻译成 executor 启动配置
- **不写 executor 专用格式**,否则换框架就要重写,中间层失去意义
- script 完全框架无关

### Executor 选择:能力矩阵反向选 (选项 C) [LOCKED]

Composer 从 workflow 提取 `required_capabilities`,在能力矩阵里筛选最合适的 executor。

能力矩阵分工:
- **能力维度 (schema)**:脚手架中心定义,不可协商的词汇表
  (mcp / subagents / session_resume / cron / webhook / web / browser / terminal / file / long_running ...)
- **静态能力值**:adapter 作者手填声明 (`capabilities` 文件)
- **可用性**:脚手架启动时 probe 检测(装没装、版本、命令可用)
- **质量校准**:运行时根据 run 结果回填 —— **第一版留接口,不实现**

第一版做到 **B 档**(维度 schema + adapter 手填 + 启动 probe),质量校准留接口。

加新 executor = 加一个 adapter + 一份 capabilities 声明,不改核心。

---

## 3. 目录结构 [LOCKED]

```
<scaffold-root>/
├── projects/
│   └── <project-id>/
│       ├── project.yaml              # 静态元信息+生命周期状态 [系统建]
│       ├── status.yaml               # 高频运行态:当前阶段/阻塞/恢复点 [系统维护]
│       ├── goal.md                   # 原始诉求+澄清对话 [用户+系统]
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
│       │   └── ...                   # 第二阶段细化
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
│               ├── meta.yaml         # agent/时间/executor/状态/phase
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
- `runs/` 扁平,meta.yaml 里标 `phase` 字段
- `project.yaml`(静态)与 `status.yaml`(运行态)分开,避免频繁写大文件
- **解析优先级:项目私有 > shared**;Composer 先找项目目录,再找 shared,没有才临时生成
- shared/ 用脚手架自己的库(框架无关);adapter 执行时把 skill 同步到目标 executor 目录
- **可复用提升 = 系统筛选提议 + 人工确认拍板**(细节见第 14 项,待讨论)

---

## 4. workflow.yaml 中间规格 v0.1 [LOCKED]

结构性决策:
- **显式 DAG**(`depends_on`),不把编排权交给黑盒 agent
- task 用**自然语言详细描述**:做什么事、输出什么数据
- **数据流 inputs/outputs** 与顺序依赖 depends_on 分开表达
- **两层验收**:`goal.acceptance`(总验收)+ `task.checks`(局部验收)
- **一个 workflow 一个 executor**(选项 A);需要不同能力就拆 workflow
- verifier 声明细节留第 7 项
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
  acceptance:                         # 整个方案闭环的总验收
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
      - 覆盖 >= 3 类数据源方案
      - 每个方案有费用和合规结论

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
      - 有推荐方案及理由
      - 有实施任务清单

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
      - 列出关键假设与风险

gates:
  - after: t3
    type: human_approval              # 方案闭环必须人确认
    writes: decisions.md

policies:
  long_running:
    idle_watchdog: 30m
    max_wall: 4h
  on_failure: stop_and_report
```

inputs vs depends_on 分工:
- `depends_on` — 控制执行顺序(DAG 边),解决"什么时候能跑"
- `inputs` — 声明数据来源(path 或 ref),解决"跑的时候吃什么";可并行但传数据,也可有序但不传数据

---

## 5. 方案阶段状态机 [LOCKED]

```
主流程:
created
  → clarifying          Clarifier 多轮澄清
  → goal_confirm        输出目标确认摘要,用户点头 ← 门控①(轻)
  → composing           Composer 生成 workflow + agent/skill/script
  → plan_review         人审任务拆解 ← 门控②
  → executing           按 DAG 跑 tasks
  → solution_review     人审最终方案 solution.md ← 门控③
  → approved            方案闭环
  → handoff             移交实现阶段 workflow

旁路状态(主要从 executing 进出):
  awaiting_input        等用户提供信息/做决策 → 补充后回 executing
  blocked               技术障碍(网络/报错/外部依赖)→ 重试或诊断后回 executing
  failed                失败且不可恢复
  cancelled             用户取消
```

决策要点:
- 保留**两道重门**:plan_review(审拆解)+ solution_review(审方案);
  外加 goal_confirm 轻确认。早审省成本
- 卡住状态**分开**:awaiting_input(等人,可主动推送提醒)vs blocked(技术障碍,可触发重试/诊断)。
  长任务里两者处理方式差别大,必须区分

---

## 待讨论清单(按依赖顺序)

核心设计:
- [x] 1. 概念边界
- [x] 2. 目录 Schema
- [x] 3. workflow.yaml
- [x] 4. 方案阶段状态机
- [ ] 11. 审批门 Gates(下一项)

执行机制:
- [ ] 5. Clarifier 澄清对话机制
- [ ] 6. Composer 动态合成机制
- [ ] 7. Verifier / 方案闭环判定
- [ ] 8. Executor 适配层(核心已在第 2 项锁定,接口细节待补)

支撑能力:
- [ ] 12. 控制面 / 交互入口
- [ ] 13. 权限与安全边界
- [ ] 9. 长任务运行与恢复
- [ ] 14. 跨项目知识沉淀

落地:
- [ ] 15. 技术栈与实现形态
- [ ] 10. 第二阶段:代码/自动化交付闭环
