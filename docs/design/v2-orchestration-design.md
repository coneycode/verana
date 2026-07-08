# Verana — 项目制 Agent Workflow 交付脚手架 设计文档

状态: 核心执行模型重构为"图工作流 / 动态调度"(此前为静态 DAG,已推翻)
版本: v0.4(执行模型重构 — 能力+护栏预定义、路径运行时实时生成)
最后更新: 2026-07-02
本文记录已锁定的设计决策。每节标注:
[LOCKED] 已确认 · [DEFERRED] 推迟 · [PARTIAL] 部分实现 · [OUTLINE] 仅预留接口

> 版本演进见 git log(每条设计决策一个 commit)。
> 本版是对 v0.1-v0.3 静态 DAG 执行模型的重构。原线性 DAG 是新图模型的退化特例。
> 复用的旧设计:目录结构、Executor 适配、Clarifier 骨架、Verifier claim/verdict、
> 技术栈、进程无状态/磁盘即真相原则。推翻的旧设计:静态 workflow.yaml DAG、
> 线性 for 执行、预先画完整图、Composer 一次性生成静态 tasks[]。

---

## 0. 为什么重构

静态 DAG 模型(v0.1-v0.3)假设:目标 → 澄清 → Composer 一次性生成完整固定 DAG
→ 逐 task 线性执行 → 验证 → 闭环。这适合"一次性调研",但无法处理长任务与延续性任务
(小说续写、长文写作、迭代优化、批量处理)。根因:

- DAG 静态:执行前必须预判所有走向,不能动态加节点、不能循环
- task 是单次调用:无法承载"反复打磨"的迭代
- 无跨轮记忆:靠文件传数据,长任务上下文必然爆窗口
- DAG 无环:不允许"写→审→改→继续"的回路

重构的核心洞察(与产品负责人逐项锁定):
**不预先画完整图,图是执行走出来的轨迹。** 预先定义并经人审的是"能力清单 + 护栏"
(边界),执行中每一步基于真实状态动态决策下一步调哪个能力(路径)。既要动态决策的
灵活(带真实上下文做决策,不预判),又要反黑盒的可控(能力是硬边界、决策带理由留痕、
关键点停下问人)。

---

## 0.5 完备体系:事前保证 + 事后归因 [LOCKED 2026-07-07]

这一节是 2026-07-07 的重大架构升级,统领第 2-13 节。起因是一连串"执行失败"暴露出
线性"执行-验证-重试"模型的结构性缺陷。逐项锁定的推理链:

### 0.5.1 地基性事实(逐项确认)

1. **执行层(hermes/claude agent)是可靠的** —— 干具体、明确的任务很少出错。
2. **偏差的根源不在执行,在两处上游**:要么"指令不够具体导致模型自由发挥",
   要么"根本没有能干这件事的能力节点"。
3. **失败(verdict fail)不是单一事件,是一个信号** —— 它可能指向链路上任何一环
   (指令/能力/上下文/标准/目标)出了问题。
4. **plan 不可能预先完全完备** —— 但规划阶段解决问题成本最低,应尽量在规划阶段完备,
   动态补节点是兜底,不是主力。

### 0.5.2 由此确立的两道防线

**事前保证(阶段一~三):尽量把问题挡在执行之前。**
- 澄清编译成结构化输入:客观信息→硬约束(进 checks + 进指令,双向锁),
  主观信息→软引导(只进指令,保留 agent 自由度)。硬/软由 LLM 自动标注(保守:
  拿不准归软)+ 人审可调。
- 规划 = Composer 生成 + 独立检查器三层审查(路径完备性/指令具体性/验收对齐)+
  planGraphWorkflow 机械编排的重生成循环。力求规划阶段完备。
- plan_review 人可直接精修 spec(改节点/checks/硬软标注),不只通过/打回。

**事后归因(阶段四~六):堵不住的漏,靠闭环兜住。**
线性旧模型:执行 → 验证 → 盲目重试(重试同样不具体的指令,还是错)。
新闭环模型:执行 → 规整 → 验证(判对错)→ 归因(判根因)→ scheduler 路由到对症修复。

### 0.5.3 单一职责 + scheduler 唯一决策(铁律)

每个角色只做一件事,数据单向流经闭环:
- **executor**:只干活,产出 claim。不自评、不归因。
- **规整层**(轻 LLM):claim → deliverable,只清对话外壳/提取纯净产出,不改实质内容。
- **verifier**:只判对错。判 deliverable(非 claim),输出 verdict{passed, reasons}。
  不归因、不决定下一步。claim 保留供归因用。
- **diagnostician**(归因者,全新角色):只归因。拿 verdict fail + claim + deliverable +
  节点定义 + 指令 + 上下文 + 历史失败,输出**单一主根因**{类型, 说明}。不决策、不修复。
- **scheduler**:唯一决策出口。拿根因(强输入)+ 全局状态,自主决策路由,能纠正归因误判。
- **各修复节点**:各自单一职责,被 scheduler 调度。

规划阶段的"生成-检查-重生成"用**机械编排**(planGraphWorkflow 函数,不引入决策角色,
不归 scheduler);执行阶段的调度才归 scheduler。

### 0.5.4 五类根因 → 修复动作(分档)

diagnostician 输出五类根因之一(覆盖链路每一环,不重叠):

| 根因 | 含义 | 对症修复 |
|------|------|---------|
| A 指令不具体 | 节点对、能力对,但指令模糊致 executor 自由发挥偏了 | 具体化指令后重跑同节点 |
| B 能力缺口 | 根本没有能干这件事的节点,之前靠现有节点硬顶 | 返回规划,Composer 补节点 |
| C 上下文缺失/错误 | 节点对、指令对,但输入(blackboard/inputs)不对 | 修正上下文后重跑 |
| D 验收标准不合理 | executor 没错,是 verifier 的 checks 定歪了 | 回规划修正该节点 checks |
| E 目标/规划有问题 | 目标本身不清晰/矛盾,或规划方向错 | 回澄清 / 重大重规划 |

scheduler 路由动作分两档:
- **高频自动路由**(scheduler 自主决策):具体化指令重跑(A)、修正上下文重跑(C)、
  换一个现有节点、补节点(B,经 Composer 复核)、改 checks(D)、跳过非必要节点继续。
- **低频重大决策 → 转人审**:删/改现有节点、回澄清/重规划(E)、调整完成标准、终止任务。

**执行资源/配置问题(429/超时/max_turns 不足)不进根因分类** —— 它是脚手架自己的配置
问题,不是任务链路根因。由脚手架层确定性兜底(自动放宽参数/限流等待),不占决策,
跟"429 等 60 秒"同类。

### 0.5.5 归因错误的处理

diagnostician 也是 LLM,可能判错。不额外加"归因校验"(避免套娃),靠**循环兜底**:
按错根因修复后还是 fail,会再次归因(带上"上次按 X 修了没用"),自我纠正;
同一节点归因-修复循环超上限 → 转人审。scheduler 也能凭全局状态纠正归因误判。

### 0.5.6 每次 fail 都归因

不做"第一次先简单重试"—— 既然执行可靠、fail 基本是结构性的,盲目重试大概率浪费。
每次 fail 直接归因,对症修复。

### 0.5.7 完整数据流(新闭环)

```
[事前保证]
用户目标 → 澄清(→硬约束/软引导/任务性质/交付物定义)
  → Composer 生成 spec → 独立检查器三层审查 → 机械重生成循环(力求完备)
  → plan_review(人精修 spec)

[事后归因,执行循环每轮]
buildProgressTruth(带 verdict 的轨迹摘要)
  → scheduler 决策下一节点(吃 verdict 事实,不吃 claim)
  → 指令组装(desc + checks含硬约束 + 软引导 + blackboard/inputs + 失败反馈)
  → executor 执行 → claim
  → 规整层 → deliverable
  → verifier 判对错 → verdict
  → pass: blackboard 更新 → 下一轮
  → fail: diagnostician 归因 → 根因写进度真相 → scheduler 路由到对症修复 → 闭环
```

以下第 2-13 节的局部描述,凡与本节冲突的,以本节为准。实现落地时逐节对齐。

---

## 1. 核心概念与边界 [LOCKED]

### 对象定义

| 对象 | 定义 |
|------|------|
| Project | 一次完整交付诉求,独占一个目录,有粗粒度生命周期状态。含多个 workflow |
| Workflow | 项目某阶段的执行规格。不再是静态 DAG,而是"能力清单 + 护栏 + blackboard schema" |
| Capability(能力节点) | 一个可被反复调用的执行单元。轻节点(单次调用)或重节点(自主 agent)。规划时列全,执行时被调度大脑动态选择 |
| Scheduler(调度大脑) | 执行中每步跑一次,基于当前状态从能力清单选下一个节点,带理由。系统的运行时"大脑" |
| Blackboard | 跨轮运行时记忆。结构由 Composer 定制,由更新记忆节点压缩维护,保持有界。调度与节点只吃它,不吃全历史 |
| Guardrail(护栏) | 预定义的红线。硬护栏(数字上限,代码判)+ 软护栏(语义红线,独立模型检查) |
| Agent | 重节点背后的执行角色;持久对象,可执行多次,每次一个 run。含 prompt/模型/工具权限/skill |
| Skill | 可复用知识/能力包(SKILL.md + 附件),开放标准;可临时生成或从 shared 复用 |
| Script | 确定性可执行代码,agent 调用但不靠即兴发挥 |
| Run | 一次节点的实际执行记录,含 claim、日志、产物 |
| Verifier | 独立于 agent 的验收者,产出 verdict。agent 说"完成"只是 claim |
| Event Log | append-only 事件日志,执行轨迹 + 留痕 + 恢复依据三合一 |
| Snapshot | 状态快照,每个节点完成打一次,存游标 + blackboard 当前值,用于快速恢复 |

### 三层职责

- L0 Scaffold — 目录约定 + 状态机 + 执行引擎(调度/router/日志/快照),本身不交付
- L1 Composer — 编译目标 → 能力清单 + 护栏 + blackboard schema,动态合成 agent/skill/script
- L2 Executor — 调现成框架(Hermes / Claude Code / OpenCode)真正执行重节点

---

## 2. 执行模型:图工作流 [LOCKED]

### 2.1 核心结构

一个 workflow 不再是静态 tasks[],而是三部分:

```
capabilities: [...]     # 能力清单(节点),规划时列全,人审过,执行中可动态扩展
guardrails: {...}       # 护栏(红线),预定义
blackboard_schema: {...} # 跨轮记忆结构,由 Composer 定制
```

执行时没有预设的边和完整图。调度大脑每步从 capabilities 里选一个节点执行,
走过的路径事后回看才是一张图(执行轨迹)。循环 = 调度大脑反复选中同一个节点。

### 2.2 节点(能力单元)—— 轻/重混合

**轻节点**:单次 LLM 调用或一段确定性代码,无自主循环。
- 典型:判断类("故事是否完结")、转换类("把这章压进摘要 / 更新记忆")、辅助决策
- 验证:所有轻节点判断都过 evaluator 模型交叉验证(生成模型 ≠ 验证模型),
  不一致 → 转人审(人裁决记入 blackboard)。
  [注:此为反黑盒的严格默认;跑一段时间有数据后再评估是否放宽]

**重节点**:派一个 agent 完成一件完整的事,内部可多次调模型/工具/自我迭代。
- 典型:创作类("写一章")、调研类("查清三类数据源")、分析类
- 验证:走 claim/verdict(agent 自报 vs 独立验证),复用第 6 节机制

**更新记忆是显式轻节点**(不藏在重节点副产品里,不藏在引擎黑箱里)。它负责把
blackboard 压缩维持在有界大小(滚动摘要:老内容压成粗概要,近内容留细节),
使 blackboard 不随任务变长而无限膨胀。

节点显式声明 kind(light | agent),引擎据此分流:重节点起 executor、走 verdict、
受 watchdog 兜底;轻节点直接调模型/代码拿结果。

### 2.3 blackboard(跨轮记忆,长任务命门)

- **结构由 Composer 定制**:不同任务记不同东西(小说记人物弧线/伏笔/摘要,
  调研记已覆盖方案/缺口)。通用固定字段会丢关键信息、导致语义判断失真。
- **由更新记忆节点维护**:显式、可见、可审、可验证(轻节点也过 evaluator)。
- **只增不爆**:更新节点负责压缩,保持有界。
- **调度大脑和节点只吃 blackboard**(有界),不吃全历史 → 第 5 节恢复也据此不爆。
- 含一个"人工指令"字段:人审时下的方向指令写这里,持续影响后续调度直到再改。

---

## 3. 调度大脑(运行时核心) [LOCKED]

执行中每完成一个节点,调度大脑跑一次,决定下一步。

### 3.0 铁律:调度决策的唯一出口是 scheduler

调度决策(下一步做什么)只能由 scheduler 输出。任何其他环节(验证、护栏、强制规则)
都**不能自己做调度决策**——它们只能作为 scheduler 的输入或校验环节:
- 需要"选择"的事 → 走 scheduler 决策
- 必然发生、无需选择的事(如"节点执行后必验证")→ 走强制规则自动执行,产出事实喂给 scheduler

推论:验证(verdict)不是被调度的节点,而是节点执行后自动强制发生的环节;它产出 verdict
事实,事实进入进度真相,由 scheduler 消费。验证这个动作自动发生,但"基于验证结果做什么决策"
必须回到 scheduler。

### 3.1 决策

- 输入:**进度真相(带 verdict 的执行轨迹摘要)** + blackboard 内容摘要 + 能力清单 + 护栏
- 输出:下一步调哪个节点 + **理由**(留痕、对人可见)
- **只能从能力清单选**(硬边界):不临时创造清单外的节点
- 决策本身先不做交叉验证(太重,每步 double);靠护栏点人审 + 留痕兜底
  [注:同样是"先简单,跑出问题再收紧"]

**关键:scheduler 吃 verdict 事实,不吃 claim(反黑盒铁律)。**
- 死循环根因(2026-07-07 修复):曾经 scheduler 的输入是"上一个节点的 claim(agent 自报)",
  它从 claim 文字里猜进度,与 verdict 结论脱节 —— verdict 说 report 通过了,但 scheduler
  看到 claim 里"被截断"字样又反复选 report,无限循环。
- 根本缺陷:执行做成了动态的(scheduler 实时决策),但进度判断还靠 LLM 从 claim 猜,
  没有由 verdict 驱动的单一进度真相。verdict 被降格成局部质检章,没进入调度决策。
- 修正:scheduler 的决策输入必须是进度真相(已验证的 verdict 事实汇总),不是 claim。
  scheduler 看到"research/analyze/report 都 verified passed",自然不会重选,死循环消失。

反黑盒定位:调度不是黑箱跳转,而是"系统提议下一步 + 理由",人随时能看、能介入。

### 3.2 停下 / 分流的所有情况

| 情况 | 处理 |
|------|------|
| 能力缺口(需要清单里没有的能力) | 带理由返回规划阶段 → Composer 复核合理性 → 合理就动态新增节点继续(事后留痕可见)/ 不合理才停下问人 |
| 信心不足(多个节点都沾边) | 不停,选置信度最高的走(置信度是 LLM 自报,不可靠,不拿它当停的开关) |
| 状态异常(blackboard 矛盾 / verdict fail 且重试耗尽) | 停,转人审 |
| 碰硬护栏 | 引擎级强制停 |
| 碰软护栏 | 停,转人审 |

**能力动态扩展**:调度大脑不能自己造节点,只能提出需求;扩展权在 Composer(要过合理性
复核)。Composer 复核合理 → 直接新增节点、继续执行,人事后在留痕里可见("执行中新增了
X 能力、缺口理由、Composer 凭什么判定合理" 必须完整留痕)。不合理 → 停下问人。
[这保持了"能力清单是人审过的边界",但用 Composer 复核 + 留痕换执行流畅,不频繁打断]

### 3.3 完成判定

有了进度真相(带 verdict 的执行轨迹),完成判定 = scheduler 看轨迹摘要 + completion_criteria
自己判断"该做的都做了且都验证通过了吗"。
- 不预设"必要节点集合",不区分节点类型
- 轨迹里有几条 write_chapter verified passed,scheduler 就知道写了几章,据此判断够不够
- 完成判定基于 verdict 事实(轨迹里的 passed 记录),不再靠 scheduler 从 claim 猜

---

## 4. 护栏 [LOCKED]

预定义,让引擎/调度识别"碰线了"。

### 硬护栏(确定性,代码判,引擎级强制闸)
- 轮次上限、成本/token 上限、时间上限、重试次数上限
- 数字,代码直接判,碰到强制停,不依赖任何模型判断

### 软护栏(语义,独立模型独立检查)
- 典型:不可逆操作前(删文件/对外发布)、偏离原始目标太远、用户预设的特定关注点出现
- **独立检查**:每步决策后单独过一遍软护栏(独立模型),**不并进调度决策**
  —— 安全判断不能和干活决策共用一个模型调用被稀释;盯红线要专门一道关
- 代价:每步多一次护栏检查(很轻),换安全,值得

---

## 5. 落盘 + 恢复 [LOCKED]

原则(沿用):**进程无状态,磁盘是唯一真相,内存只是缓存**。任何时刻挂掉能从磁盘恢复。

### 5.1 两类数据

**静态(规划产出,plan_review 后锁定)**:能力清单、护栏、blackboard schema、完成标准。

**动态(执行中变,恢复关键)**:blackboard 当前值、执行轨迹、当前游标(走到哪、等什么)、
各 run 的 claim/verdict/留痕。

### 5.2 事件日志 + 快照(分离)

- **事件日志(append-only)**:权威真相 + 完整留痕。每发生一件事追加一条
  (调度决策了X+理由 / 节点X开始 / run产出 / verdict / blackboard更新 / 碰护栏停 /
  人审裁决)。只增不改。可以很长,按需翻页读,不必一次全读。
  → 你要的"事后可见、可回溯、每步理由",本质就是这个日志。
- **状态快照**:每个节点完成打一次,存游标 + blackboard 当前值。是日志的物化视图。
  恢复只读最近快照 + 重放之后少量事件,数据量恒定小。

**三处都不爆**(规模关键):
- 恢复系统状态 → 读快照(游标 + blackboard 大小恒定,与日志长度无关,不过 LLM)
- 审计/留痕 → 按需翻日志(长但不一次全读)
- 喂给模型的上下文 → 只吃 blackboard(有界且被压缩维护)

### 5.3 进度真相(带 verdict 的执行轨迹) [LOCKED 2026-07-07]

进度真相是喂给 scheduler 的核心输入(见 3.1)。本质:**它不是"按节点类型汇总的状态",
而是按发生顺序的执行时间线** —— 已执行(带 verdict 结果)+ 当前执行 + 下一步(scheduler 输出)。
它就是事件日志的核心内容,不另造数据源。

**喂给 scheduler 的形态 = 轨迹摘要(机械折叠,不用 LLM)**:
- 早期折叠:超过阈值(如 8 条)的旧记录,按"节点名 × verdict 通过次数"聚合
- 近期明细:保留最近 5-8 条(节点 + run + verdict + 简短理由)
- 当前:正在执行的节点 + run + 状态
- 进度信号:把轨迹事实换算成完成度提示(如 write_chapter 已通过 N 次)

样例(长任务写 50 章):
```
【已执行轨迹摘要】
早期(已折叠): outline✓ | write_chapter×47✓ | review×47✓ (第1-47章均通过)
近期明细:
  - write_chapter (run-0192) passed — 第48章
  - review_chapter (run-0193) passed — 第48章审查通过
  - update_memory (run-0194) passed
  - write_chapter (run-0195) passed — 第49章
  - review_chapter (run-0196) passed — 第49章审查通过
【当前】write_chapter (run-0197) executing — 第50章
【进度信号】write_chapter 已通过 49 次 / 目标约 50 章
```

**折叠用代码机械聚合,不用 LLM**:轨迹摘要是结构化事实(谁执行、结果、几次),
机械聚合(计数 + 保留近期)就够,确定、可复现、不花钱。LLM 的"理解"在这里用不上。

**两个摘要分工(都喂 scheduler,职责不同)**:
- 轨迹摘要 → 回答"执行到哪了"(进度真相,机械折叠,本节)
- blackboard rolling_summary → 回答"产出了什么"(内容记忆,第 2.3 节)

### 5.4 中断态恢复

读最近快照定位游标,按所处中断态续:

| 中断在 | 恢复后 |
|--------|--------|
| 正在跑某节点(半截) | 丢弃半成品,该节点整体重跑(新 run) |
| 等人审(异常/护栏/检查点) | 仍停在人审,重新呈现,继续等 |
| 等 Composer 复核(能力缺口回流) | 重新触发复核(无副作用,重跑安全) |
| 正常步间 | 从这里正常继续,调度大脑基于当前 blackboard 决定下一步 |

**重跑无需显式回滚**:快照打在"节点完成"点,半截挂掉时最近快照就是该节点执行前的
干净状态,blackboard 天然是执行前的。这正是快照打在节点完成点的原因。

恢复触发第一版手动(`verana run <id>` 自动检测中断点续)。

---

## 6. Verifier / 验证 [LOCKED]

产品灵魂:**agent 说"完成"只是 claim,verifier 的 verdict 才是真相**。

### 6.0 验证是强制自动发生的,不占调度决策 [LOCKED 2026-07-07]

所有节点执行后必须验证 —— 这是强制规则里自动发生的既定流程,不是"要不要做"的选择,
因此不占用 scheduler 决策(见 3.0)。验证方式按节点类型分(下方),但"必验"统一强制。

验证产出的 verdict 事实进入**进度真相**(第 5.3 节),成为 scheduler 下一步决策的地基。
scheduler 吃 verdict 事实、不吃 claim —— 这是死循环修复的根本(见 3.1)。

### 两类节点的验证
- **重节点**:claim/verdict 独立验证(下方机制)
- **轻节点**:判断过 evaluator 交叉验证(第 2.2 节),不一致转人审

### 验证方法(节点 checks 每条的 method)

| method | 怎么验 | 适合 |
|--------|--------|------|
| command | 跑命令,exit 0 = 过 | 脚本产物、PoC、schema 校验 |
| file_exists | 产物文件/目录真实存在且非空 | 确认产物非空壳 |
| llm_rubric | 独立 evaluator 模型按 rubric 打分 | 创作/research 质量验收(主力) |
| manual | 人工判定 | 最终确认、主观质量 |

- llm_rubric 用独立 evaluator 模型;verdict 必附"判定理由 + 引用证据",可复核
- 一个节点 checks 支持多方法组合,全过才算过

### claim vs verdict(反黑盒核心)
- `runs/<run-id>/claim.md` — agent 自报(原话,UNVERIFIED)
- `runs/<run-id>/verdict.yaml` — verifier 独立判定(pass/fail + 理由 + 证据,真相)
- UI 并排展示两者,显式暴露差距

### FAIL 后自动重跑(有上限,会升级)
- FAIL → verdict 差距说明作为反馈写进上下文,自动重跑
- 重跑上限 2 次(比 Composer 的 3 次小,跑 agent 更耗时)
- 超限仍 FAIL → 不再自动重跑,升级人工(此即调度大脑的"状态异常"→ 停,转人审)
- 每次重跑一个新 run,留痕可见"为什么还不过"

---

## 7. 人审 [LOCKED]

所有"停下等人"的共同出口。粒度 = 中粒度(B):对当前步表态 + 改运行时状态,
但不动结构(能力清单/护栏/节点定义要回规划阶段改,执行中不动地基)。

### 统一界面骨架(四场景共享)
- 为什么停(场景 + 理由)+ 当前状态快照(blackboard 关键字段 / 走到第几步 / 刚完成产出)
- blackboard 可编辑区(人直接改摘要/人物/状态)
- 动作区(表态按钮 + 给调度大脑的方向指令输入框)
- 执行轨迹留痕可回看

### 四场景(默认呈现 + 动作)
| 场景 | 重点呈现 | 动作 |
|------|---------|------|
| 状态异常/失败 | 错误 verdict、卡点、前几步 | 重试(可先改再试)/给方向/放弃 |
| 碰护栏 | 碰哪条线、进展相对上限位置 | 放行/叫停/改方向 |
| 能力缺口不合理 | 调度与 Composer 两方理由并陈 | 人定夺(可强制批准回规划加)/确认不需要给方向/放弃 |
| 阶段检查点 | 这段干了什么、累积产出、blackboard 现状 | 继续/回头改/结束/调整后续方向 |

### 三个回流机制
- **人改 blackboard** → 直接覆盖生效,留痕"人在此手改了 X"
- **方向指令** → 写进 blackboard 的"人工指令"字段,持续影响后续调度直到再改
  (不是一次性,能持续导向)
- **不可逆操作放行** → 二次确认(最后一道防线)

---

## 8. Clarifier 澄清对话机制 [LOCKED]

流程入口。把"太粗"的目标变成"可执行"。骨架沿用,新增"是否迭代"维度。

### 澄清维度
| 维度 | 澄清什么 |
|------|---------|
| 目标产出 | 要调研方案,还是直接落地实现?(决定 deliverable_type) |
| **任务性质** | **一次性产出,还是需分多轮逐步完成/反复打磨?(决定 flow:线性 vs 迭代)** |
| 范围边界 | 覆盖什么、不覆盖什么 |
| 输入来源 | 已知数据源/约束/资料 |
| 验收标准 | 什么样算"做好了" |
| 约束 | 预算、合规、时间、技术栈偏好 |

- 任务性质靠语义推断(目标含"续写/多章/反复优化/逐个处理"→ 疑似迭代)+ 必要时问用户
- 结果写进 goal.iterative,传给 Composer,作为规划输入
- 提问:一次一个 + 附"为什么问" + 可选默认;风险告知(不澄清的后果);
  软上限 5-7 轮;知情跳过留痕
- deliverable_type 是澄清产出,不是用户开口定死

---

## 9. Composer 规划机制 [LOCKED]

规划 = 预先定义能力与护栏(人审),而非画完整图。规划变轻,调度大脑变重。

### 输入 / 输出
- 输入:澄清后目标(clarified + clarifications + deliverable_type + iterative)、
  shared/ 已有资源、能力矩阵
- 输出:能力清单 + 护栏 + blackboard schema + 完成标准 + agents/skills/scripts + selected_executor

### 规划步骤
1. 判断任务性质(iterative 信号)→ 决定规划形态
2. 列能力清单:任务需要哪些功能节点,每个干什么、轻/重、怎么验证
3. 定护栏:硬上限(轮次/成本/时间/重试)+ 软护栏描述(不可逆/偏离/关注点)
4. 设计 blackboard schema:这个任务要记住什么,哪个节点负责更新哪些字段
5. 资源匹配:agent/skill/script 先查项目私有 → shared → 没有才临时生成
6. 三层自检(见下)

### 三层自检
**第一层:确定性硬校验(代码,必过)**
- 能力清单每个节点有 checks(无验收不执行,铁律)
- 引用的 agent/skill/script 真实存在(私有/shared/已生成)
- selected_executor 能力覆盖 required_capabilities
- 护栏完整:至少有硬上限(防失控),完成标准明确
- blackboard schema 里,每个字段有节点负责更新;语义护栏/判断所需信息在 schema 里有对应字段
- [注:不再校验"DAG 无环"——没有预设图;改为校验"能力/护栏/记忆"的完备性]

**第二层:质量评测(独立 evaluator 模型)**
- 能力覆盖度(完成 goal.acceptance 每条是否都有能力支撑)
- 护栏充分性(红线是否覆盖真实风险)
- blackboard 设计合理性(记的东西够不够支撑调度和语义判断)
- 角色匹配度、skill 质量
- 每项给分 + 理由,低于阈值打回重生成或标记人审重点

**第三层:人审(plan_review 门,必过)**
- 人审的是**能力边界 + 护栏**(不是死流程)+ 自检评分报告
- Composer 产出必过人审,不直接执行

### 重生成上限
自检打回上限 3 次,超限带低分报告强制交人审。

### 模型角色
- composer model — 规划(列能力、定护栏、写 skill)
- evaluator model — 评分/交叉验证(独立,最好不同源,避免自证)
- executor — Hermes/Claude Code 等,能力矩阵选,是"手"不是"脑"

### 执行中的角色
Composer 不只执行前跑一次;调度大脑触发"能力缺口"时,Composer 复核合理性、
动态新增节点(第 3.2 节)。

---

## 10. 状态机 [LOCKED]

三层:Project(大阶段)→ Workflow(阶段内执行)→ Node/Run(执行单元)。

### 10.1 Project
```
created → solutioning → solution_approved → implementing → delivered
                                                          ↘ cancelled(任意处)
```

### 10.2 Workflow
```
clarifying → goal_confirm → composing → plan_review → executing → final_review → approved
旁路:awaiting_human(调度停下等人,含各场景)/ blocked(技术障碍)/ failed / cancelled
```
- executing 内部不再是"按 DAG 跑",而是"调度大脑驱动的图遍历"(第 11 节)
- 门:goal_confirm(轻)、plan_review(审能力+护栏)、final_review(审交付物)
- executing 阶段的游标(当前节点、iteration、等什么)记在 status.yaml + 快照

### 10.3 Node / Run
```
selected(调度选中) → running → verifying → done
                                    ↘ failed(重跑耗尽)→ 升级人审
```
轻节点:running → 交叉验证 → done / 不一致转人审
重节点:running → verdict → done / failed

---

## 11. 执行引擎:router 驱动 [LOCKED]

替代原线性 for 循环。伪代码:

```
current = 入口节点(Composer 指定或调度大脑首选)
loop:
  run = execute(current, blackboard)          # 跑节点,产出 claim(重)或结果(轻)
  verdict = verify(run)                        # 重节点独立验证 / 轻节点交叉验证
  append_event(...); snapshot()                # 落盘:日志追加 + 节点完成打快照
  if 轻节点交叉验证不一致: 转人审; continue
  if 重节点 verdict fail: 重跑(上限2)或升级人审
  check_hard_guardrails()                      # 碰硬护栏 → 强制停
  check_soft_guardrails(独立模型)               # 碰软护栏 → 停,转人审
  decision = scheduler(blackboard, run产出, 能力清单, 护栏)  # 调度大脑:下一步+理由
  append_event(decision)
  switch decision:
    能力缺口 → Composer 复核 → 新增节点继续 / 停问人
    选中节点 → current = 该节点
    完成标准满足 → workflow → final_review; break
    状态异常 → 停,转人审; break
```

关键:每个节点完成 + verdict + 落盘 = 检查点。进程挂了从快照 + 日志恢复(第 5 节)。

---

## 12. 目录结构 [LOCKED]

```
<scaffold-root>/
├── projects/<project-id>/
│   ├── project.yaml           # 静态元信息 + 项目生命周期状态
│   ├── status.yaml            # 运行态:活动 workflow、当前游标、等什么
│   ├── goal.md                # 原始诉求 + 澄清对话
│   ├── decisions.md           # 人确认过的关键决策 + 人审裁决
│   ├── solution/
│   │   ├── workflow.yaml       # 能力清单 + 护栏 + blackboard schema [Composer]
│   │   ├── blackboard.yaml     # 跨轮记忆当前值(快照的一部分)[更新节点维护]
│   │   ├── events.log          # append-only 事件日志(轨迹+留痕+恢复)
│   │   ├── snapshots/          # 状态快照(每节点完成一份)
│   │   ├── solution.md         # 交付物 [agent 产出,人审]
│   │   └── ...                 # 其他产物(章节、research 等,由能力节点产出)
│   ├── implementation/         # 实现阶段 [方案闭环后创建]
│   ├── agents/ skills/ scripts/  # 项目私有资源 [Composer],两阶段共享
│   └── runs/<run-id>/          # 扁平,meta.yaml 标 phase/node
│       ├── meta.yaml
│       ├── claim.md            # agent 自报(unverified)
│       ├── verdict.yaml        # verifier 独立判定(真相)
│       ├── log.md
│       └── artifacts/
└── shared/                     # 跨项目公共组件库(框架无关)
    ├── agents/ skills/ scripts/
```

- 解析优先级:项目私有 > shared;Composer 先找私有再找 shared,没有才临时生成
- events.log + snapshots/ 是新增(图执行模型的恢复基础)
- workflow.yaml 内容变了(能力+护栏+schema,非静态 tasks[]),文件位置不变

---

## 13. Executor 适配机制 [LOCKED]

(与执行模型无关,沿用)

- skill 写框架无关开放标准(SKILL.md);adapter 执行前放到目标 executor 原生路径
- agent 写自己的抽象定义;adapter 翻译成 executor 启动配置
- script 完全框架无关

### Executor 选择:能力矩阵反向选
Composer 从 required_capabilities 在能力矩阵筛选最合适 executor。
维度 schema(中心定义)+ 静态能力值(adapter 手填)+ 可用性(启动 probe)。
第一版 B 档,质量校准留接口。

### adapter 接口
```
interface ExecutorAdapter {
  name; capabilities; probe();
  prepare(agentCfg, workdir);   // skill 放原生路径、拼启动参数、注入权限
  execute(agentCfg, workdir);   // 启动 executor 跑一个重节点
  collect(run);                 // 收产物 + agent claim
}
```

### 重节点执行流程
1. Composer 已选定 executor
2. prepare:skill 同步到原生路径,agent prompt/权限/模型拼成启动参数(权限提前注入)
3. execute:隔离 workdir 启动 executor 跑一次性命令(非交互)
4. collect:收产物 + claim
5. 交 verifier 独立判定

### 交互处理
- 层1 executor 内部工具批准 → 不交互,prepare 提前注入权限,超范围直接拒绝
- 层2 任务级缺信息 → agent 汇报 needs_input,run 正常结束,workflow 停下等人(第 7 节),
  不让 executor 挂起等 stdin(长任务脆弱)

第一版主攻 Hermes(覆盖 web/browser/cron/长任务/skills)。

---

## 14. 控制面 / 交互入口 [LOCKED]

- 形态:CLI 优先,后端 API + SSE 架构,Web 无缝接入
- Web UI:Fastify 直供静态页,不引 React/Vite;执行阶段展示"轮次时间线"
  (节点图 + 当前游标 + iteration)、右侧实时 LLM 输出(SSE stream)、
  人审卡(四场景)、blackboard 面板
- CLI 命令草案:
```
verana new [目标]          # 创建项目,进澄清
verana clarify <id>        # 继续澄清
verana list / status <id>  # 总览 / 单项目详情(当前游标/等什么/进度)
verana plan <id>           # 查看能力清单 + 护栏 + 自检报告
verana approve/reject <id> [gate]
verana input <id> [信息]   # 补充信息 / 人审裁决
verana run <id>            # 启动/继续(自动检测中断点续)
verana logs <id> [run]     # 看 claim/verdict/日志 / 事件轨迹
verana cancel <id>
```
- SSE 事件:status_changed / node_selected(+理由)/ run_updated / verdict /
  blackboard_updated / guardrail_hit / human_required / llm_stream

---

## 15. 技术栈与实现形态 [LOCKED]

- 语言:Node / TypeScript(CLI + Web + 调 executor CLI + SSE)
- 状态存储:纯文件(yaml/json + append-only log),目录即真相,可 git、人可读
- LLM 调用层:薄 client。composer / evaluator 各配各的,支持不同源。
  实现:HttpLlmClient 用 Anthropic 原生 Messages API,配置 verana.config.yaml(gitignored)
- 接口抽象 LlmClient(complete / completeJson),换协议只需换实现类

---

## 16. 权限与安全边界 [DEFERRED — 闭环跑通后]

第一版最低底线(已自带):workdir 隔离、secrets 不进 git。
推迟:工具权限白名单、文件系统强约束、secrets 注入、危险操作拦截
(软护栏的"不可逆操作前停 + 二次确认"已是第一版的部分安全兜底)。

---

## 17. 跨项目知识沉淀 [PARTIAL — 第一版手动]

shared/ 保留,解析优先级 私有 > shared。第一版手动把好用的 agent/skill 复制进 shared/。
推迟:自动筛选/提升提议/泛化改写/版本管理。

---

## 18. 第二阶段:代码/自动化交付闭环 [OUTLINE — 第一版不实现]

同一 project 下 solution 与 implementation 两个 workflow,共享 goal/agents/skills/上下文。
handoff:方案 approved → 基于 solution.md 的实施拆解创建 implementation workflow。
差异:executor 切 Claude Code、agent roster 换 planner/builder/reviewer、
verifier 主力 command/tests + anti-cheat、workdir git 隔离 + 每节点 diff 审批。
通用复用:能力/护栏/blackboard/调度/router/日志快照/claim-verdict/Composer 自检 全通用。

---

## 附录 A:设计项状态总览

核心执行模型(本次重构):
- [x] 0. 重构动机
- [x] 1. 核心概念与边界
- [x] 2. 执行模型:图工作流(能力清单 + 护栏 + blackboard)
- [x] 3. 调度大脑(运行时核心)
- [x] 4. 护栏(硬 + 软)
- [x] 5. 落盘 + 恢复(事件日志 + 快照)
- [x] 6. Verifier / 验证
- [x] 7. 人审(中粒度,四场景)

规划与入口:
- [x] 8. Clarifier(加"任务性质"维度)
- [x] 9. Composer(规划能力+护栏,非画图;执行中动态扩展)
- [x] 10. 状态机(三层)
- [x] 11. 执行引擎:router 驱动
- [x] 12. 目录结构(加 events.log + snapshots)

支撑:
- [x] 13. Executor 适配(沿用)
- [x] 14. 控制面(执行阶段轮次时间线)
- [x] 15. 技术栈
- [~] 16. 权限安全(推迟)
- [~] 17. 知识沉淀(手动)
- [~] 18. 实现阶段(轮廓)

完备体系升级(0.5 节,2026-07-07 锁定,统领 2-13):
事前保证:
- [x] 澄清编译结构化输入(硬约束/软引导分离,LLM 标注+人审可调)—— 已实现
- [x] 规划充分性检查(独立检查器:路径完备/指令具体/验收对齐)—— 已实现
- [x] planGraphWorkflow 机械重生成循环 —— 已实现
- [x] plan_review 人可编辑 spec(改节点/checks/硬软标注)—— 已实现
事后归因:
- [x] 进度真相层(scheduler 吃 verdict 不吃 claim,buildProgressTruth 机械折叠)—— 已实现
- [x] 重节点走 hermes CLI(带 web 工具)+ 执行过程实时流 —— 已实现
- [x] 人审 failure 场景展示原因+最近产出+重试 —— 已实现
- [x] diagnostician 归因环节(五类根因)—— 已实现
- [x] 指令组装五要素(desc+checks+软引导+上下文+失败反馈)—— 已实现
- [x] 规整层(claim→deliverable,轻 LLM 清洗)—— 已实现
- [x] scheduler 路由(五类根因→修复动作,高频自动/低频人审)—— 已实现
- [x] verifier 判 deliverable(非 claim),轻节点不一致也走归因 —— 已实现

---

## 附录 B:与旧实现(v0.3 静态 DAG)的差异 / 迁移

旧实现(见 git 历史 v0.3)是静态 DAG:Composer 一次性生成 tasks[] + depends_on + gates,
pipeline 线性 for 跑。已端到端验证,但只适合一次性调研。

本次重构要改的代码:
- types.ts — workflow schema:tasks[]/depends_on/gates → capabilities[]/guardrails/blackboard_schema;
  加 event log / snapshot / 游标类型
- workflow-validator — 去掉"DAG 无环";改为"能力/护栏/记忆完备性"校验
- pipeline.ts — 线性 for → 调度大脑 + router 驱动的图遍历 + 事件日志 + 快照
- composer — prompt:生成静态 DAG → 判断任务性质 + 列能力清单 + 定护栏 + 设计 blackboard schema;
  加执行中"能力缺口复核 + 动态新增节点"
- clarifier — 加"任务性质(是否迭代)"维度,产出 goal.iterative
- 新增 scheduler(调度大脑)、guardrails(护栏检查)、blackboard(记忆维护)、
  event-log + snapshot(落盘恢复)模块
- web.ts — 执行阶段 UI:线性 task 列表 → 轮次时间线 + blackboard 面板 + 四场景人审卡

可直接复用:LLM client、claim/verdict 验证、evaluator 模型角色、Executor adapter 接口、
目录结构骨架、SSE 架构、Clarifier 骨架、进程无状态/磁盘即真相。

落地顺序建议:先手写一个 workflow.yaml 样例(能力+护栏+schema),把
调度大脑 + router + blackboard + 事件日志/快照的执行引擎跑通,再回头做 Composer 自动规划。
