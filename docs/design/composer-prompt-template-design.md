# Composer Prompt 按任务类型组装设计

[LOCKED] 2026-08-11

## 背景

现有 Composer 是一个固定 72 行 prompt，不管什么任务都用同一套模板。
导致创作型任务（如"输出PRD"）被加了 collect_evidence 节点（套了调研型模板）。

## 核心变化

把固定 prompt 拆成两层：
1. 通用部分（JSON 结构 + 基础规则）——所有任务都一样
2. 类型专属部分（能力链 + guidance）——按 task_type 动态注入

## 流程

```
planGraphWorkflow:
  1. 调 LLM 分类（classifyTask，轻量调用）
     输入: goal + conclusions
     输出: { task_type: "research" | "creative" | "implementation" }
  
  2. 按 task_type 选模板（TASK_TEMPLATES 字典）
     每个模板含: chain（能力链骨架）+ guidance（专属引导）
  
  3. 组装 Composer prompt
     COMPOSER_SYSTEM_BASE（通用） + 模板的 chain + guidance
  
  4. 调 Composer LLM 生成 spec
     Composer 拿到的是"你这个类型应该这样"，不是"你自己判断"
```

## 数据结构

```typescript
interface TaskTemplate {
  chain: string;       // 能力链骨架，如 "collect_evidence → plan_outline → write_report → polish_report → review_report"
  guidance: string;   // 专属引导，精简，告诉 Composer 该类型的关键注意事项
}

const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  research: {
    chain: "collect_evidence(×N instances, 按维度/方案拆分) → plan_outline(light) → write_report(agent) → polish_report(agent) → review_report(agent)",
    guidance: "调研型任务。需要先按维度收集证据，每个维度一个 instance，产出 evidence 文件。报告基于证据撰写。",
  },
  creative: {
    chain: "plan_outline(light) → write_report(agent) → polish_report(agent) → review_report(agent)",
    guidance: "创作型任务（PRD/方案/设计文档）。不需要收集证据，直接规划大纲后写。大纲规划根据目标要求生成章节结构和要点。",
  },
  implementation: {
    chain: "plan_tasks(light) → implement(×N instances, 按模块拆分) → test(agent) → review(agent)",
    guidance: "实现型任务。按模块拆分实现步骤，每个模块一个 instance。需要有测试节点验证实现正确性。",
  },
};
```

## Prompt 拆分

### COMPOSER_SYSTEM_BASE（通用部分，所有任务共用）

保留现有的：
- JSON 结构定义
- 基础规则（light/agent、checks、bounded、guardrails、hard_constraints、soft_guidance）
- instances 规则（目的、判定、{instance} 占位符）
- context_inputs 规则
- 报告写作链路校验说明（大纲→写→润色）
- entry_node、deliverable_contract 等

去掉：
- 第61行"能力清单要覆盖目标的完整交付链"里的两种链路示例（移到模板里）
- 第72行"research 类任务"的判断引导（移到模板里）

### 类型专属部分（注入到通用部分后面）

```
## 本次任务类型: {task_type}

### 能力链骨架（参考，在此基础上细化）:
{chain}

### 关键注意事项:
{guidance}
```

## 分类器

```typescript
const CLASSIFIER_SYSTEM = `根据用户目标判断任务类型。返回 JSON: {"task_type": "research | creative | implementation"}

判定标准:
- research: 目标含"调研/了解/分析/对比/综述/市场调查"
- creative: 目标含"输出/撰写/写/设计/PRD/方案/文档/规划"
- implementation: 目标含"开发/搭建/部署/实现/构建/编码"
拿不准的归 creative。`;
```

## 改动文件

1. pipeline.ts:
   - 拆 COMPOSER_SYSTEM 为 COMPOSER_SYSTEM_BASE + TASK_TEMPLATES
   - 新增 classifyTask 函数
   - 新增 buildComposerPrompt(goal, conclusions, taskType) 组装函数
   - planGraphWorkflow 里先调 classifyTask 再调 Composer

## 不变的部分

- workflow-validator.ts 不变（报告写作链路校验按产出特征匹配，不管任务类型）
- clarifyChat / server.ts 不变
- 执行引擎不变
