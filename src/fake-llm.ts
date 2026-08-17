import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { LlmClient, ModelRole } from "./llm.js";
import type { ExecutorAdapter, AgentRun } from "./executors.js";

export interface FakeResponse {
  complete?: string;
  json?: unknown;
}

export class FakeLlmClient implements LlmClient {
  readonly calls: Array<{ role: ModelRole; system: string; user: string }> = [];

  constructor(private readonly responder: (role: ModelRole, system: string, user: string) => FakeResponse) {}

  async complete(role: ModelRole, system: string, user: string, onDelta?: (delta: string) => void): Promise<string> {
    this.calls.push({ role, system, user });
    const response = this.responder(role, system, user);
    if (response.complete !== undefined) return response.complete;
    if (response.json !== undefined) return JSON.stringify(response.json);
    return "";
  }

  async completeJson<T = unknown>(role: ModelRole, system: string, user: string): Promise<T> {
    this.calls.push({ role, system, user });
    const response = this.responder(role, system, user);
    return (response.json ?? JSON.parse(response.complete ?? "{}")) as T;
  }
}

export function fakeClarifierQuestion() {
  return { dimension: "平台", question: "你要监控哪些平台?", risk: "不澄清会导致方案偏掉。" };
}

export function fakeExecutorContent() {
  return "# 交付内容\n\n这是 fake LLM 产出的交付物。";
}

function extractOutputPaths(prompt: string): string[] {
  const block = prompt.match(/产出文件路径\(必须写到这些路径\):\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
  const paths = block
    .split("\n")
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .map((line) => line.match(/^([^:]+):/)?.[1]?.trim())
    .filter((path): path is string => Boolean(path));
  return [...new Set(paths)];
}

export class FakeExecutorAdapter implements ExecutorAdapter {
  readonly name = "fake-executor";
  readonly capabilities = { name: "fake-executor", capabilities: ["web", "browser", "long_running", "skills", "terminal", "file"] };

  async probe() { return { available: true, command: "fake" }; }
  async execute(prompt: string, workdir: string, _opts?: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun> {
    const outputPaths = extractOutputPaths(prompt);
    const effectivePaths = outputPaths.length > 0 ? outputPaths : (prompt.includes("solution/chapters") ? ["solution/chapters/"] : []);
    for (const outputPath of effectivePaths) {
      const target = outputPath.endsWith("/") ? join(workdir, outputPath, "content.md") : join(workdir, outputPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `# 正式交付物(模拟)\n\n## 正文\n\n这是 fake executor 写入声明 output 的正式正文,用于模拟创作类交付物。\n\n## 产品概览\n\n产品定义、核心功能、目标用户、定价和竞品定位均有覆盖。\n\n## 评测3维\n\n- 自动化测试:覆盖核心流程和回归场景。\n- 效果评估:基于任务完成率、准确率和用户反馈评估。\n- 评分体系:使用可复现的多维评分表。\n\n## 可观测5维\n\n- 链路追踪:记录请求和任务执行链路。\n- 日志:保留关键输入、输出和异常。\n- 指标:统计延迟、错误率和吞吐。\n- 告警:对失败率和超时设置阈值。\n- Dashboard:集中展示运行状态和质量趋势。\n\n## 问题\n\n需要确保交付物不是执行过程日志。\n\n## 方案\n\n通过结构契约和 artifact 校验约束正式正文。\n\n## 实现细节\n\n声明 output 被写入独立文件,后续由 artifact snapshot 冻结并验证。\n\n## 验证\n\n验证包括结构检查、禁止模式检查和语义验收。\n\n## 结论与建议\n\n建议继续保持结构契约作为运行时硬约束。\n\n## 来源\n\n1. https://example.com/source-1\n2. https://example.com/source-2`, "utf8");
    }
    return {
      claim: `# Claim\n\n已完成节点执行,正式正文已写入声明 output。`,
      exitCode: 0,
      raw: "fake executor output",
    };
  }
}

/**
 * buildSmartFakeClient — 支持图工作流引擎的各类 LLM 响应:
 * - clarifier(澄清问题)
 * - composer 规划(生成能力+护栏+schema)
 * - scheduler(调度大脑:选节点+理由)
 * - executor(节点执行:产出内容)
 * - cross_check(轻节点交叉验证)
 * - verifier(重节点验证)
 * - guardrail(软护栏检查)
 * - blackboard_update(记忆更新)
 */
export function buildSmartFakeClient(): FakeLlmClient {
  let schedCount = 0;
  return new FakeLlmClient((role, system, user) => {
    // Clarifier
    // 对话式澄清
    if (role === "composer" && system.includes("方案澄清助手")) {
      return { complete: "[DONE]\n[通用] 测试目标\n[/DONE]" };
    }
    // 任务分类器
    if (role === "composer" && system.includes("判断任务类型")) {
      return { json: { task_type: "creative" } };
    }
    // 澄清二次校验(旧,兼容)
    if (role === "evaluator" && system.includes("澄清审核者")) {
      return { json: { need_followup: false } };
    }

    // Composer 规划(生成图工作流 spec)
    if (role === "composer" && system.includes("workflow 规划者")) {
      return { json: fakeComposerGraphSpec(user) };
    }

    // Composer 复核 max-turns hit
    if (role === "composer" && system.includes("max-turns")) {
      return { json: { verdict: "abandon", reason: "测试:放弃 max-turns hit", reframe_action: null } };
    }

    // Capability gap review(执行中能力缺口复核)
    if (role === "composer" && system.includes("workflow 规划者(Composer)。调度大脑报告了")) {
      return { json: { reasonable: false, reason: "测试:不需要新能力" } };
    }

    // Scheduler(调度大脑)
    if (role === "composer" && system.includes("调度大脑")) {
      schedCount++;
      // 检测进度真相里是否有 artifact fail
      if (user.includes("F_artifact_contract_failure") || user.includes("artifact_contract")) {
        const recentLines = user.split("\n").slice(-4).join("\n");
        const recentPassed = /passed\b/.test(recentLines) && !/passed=false|passed: false/i.test(recentLines);
        if (!recentPassed) {
          if (user.includes("declared_output_missing") || user.includes("declared_output_empty")) {
            return { json: { tasks: [{ next_node: "write_chapter", reason: "executor 没产出内容,重跑", action: "retry_with_feedback" }], is_complete: false, capability_gap: "" } };
          }
          return { json: { tasks: [{ next_node: "write_chapter", reason: "artifact 形态不对,让 materializer 整理", action: "materialize" }], is_complete: false, capability_gap: "" } };
        }
      }
      if (schedCount <= 2) {
        return { json: { tasks: [{ next_node: "write_chapter", reason: "继续写下一章", action: "execute" }], is_complete: false, capability_gap: "" } };
      }
      return { json: { tasks: [], is_complete: true, capability_gap: "" } };
    }

    // 充分性检查器
    if (role === "evaluator" && system.includes("规划充分性检查器")) {
      return { json: { passed: true, issues: [] } };
    }
    // Artifact materializer — 从 prompt 提取目标路径和章节要求,生成对应内容
    if (role === "evaluator" && system.includes("artifact materializer")) {
      const match = user.match(/- (solution\/[^:]+):/);
      const path = match?.[1] ?? "solution/report.md";
      // 从 prompt 提取必需章节,生成对应内容
      const sectionsMatch = user.match(/必需章节: (.+)/);
      const sections = sectionsMatch?.[1]?.split(" / ").filter(Boolean) ?? ["产品概览", "主要发现", "结论与建议"];
      const content = generateFakeDeliverable(sections);
      return { json: { artifacts: [{ path, content, reason: "测试:基于提供证据生成结构化正文" }] } };
    }
    // 规整层
    if (role === "evaluator" && system.includes("产出规整器")) {
      return { json: { deliverable: user.slice(user.indexOf("Agent 原始输出:") + "Agent 原始输出:".length).trim(), cleaned: true } };
    }
    // Diagnostician(归因者)
    if (role === "evaluator" && system.includes("归因者")) {
      return { json: { root_cause: "A_instruction_vague", explanation: "指令不够具体,executor 自由发挥偏了" } };
    }
    // Cross check(轻节点交叉验证)
    if (role === "evaluator" && system.includes("语义重复检测器")) {
      return { json: { duplicate: false, reason: "不重复" } };
    }
    if (role === "evaluator" && system.includes("独立验证者") && system.includes("判断另一个模型")) {
      return { json: { agree: true, reason: "独立判断一致" } };
    }

    // Verifier(重节点验证)
    if (role === "evaluator" && system.includes("独立的验收者")) {
      return { json: { passed: true, reasons: ["内容满足验收"], evidence: [] } };
    }

    // Soft guardrail
    if (role === "evaluator" && system.includes("安全护栏检查者")) {
      return { json: { hit: false } };
    }

    // Blackboard update
    if (role === "composer" && system.includes("记忆维护者")) {
      return { json: { updates: { summary: "第1章摘要:主角登场" } } };
    }

    // Executor(节点执行)
    if (role === "composer") return { complete: fakeExecutorContent() };

    // Fallback
    return { json: { passed: true, reasons: ["ok"], evidence: [] } };
  });
}

function generateFakeDeliverable(sections: string[]): string {
  const parts = ["# 结构化调研报告", ""];
  for (const section of sections) {
    parts.push(`## ${section}`, "");
    parts.push(`${section}相关的正文内容,基于执行器收集的证据和来源整理。`);
    parts.push("");
  }
  return parts.join("\n").trim();
}

function fakeComposerGraphSpec(userPrompt: string): unknown {
  return {
    clarified: "写一部悬疑小说,约2章",
    deliverable_type: "creative",
    iterative: true,
    acceptance: ["每章3000字以上", "情节连贯"],
    capabilities: [
      {
        id: "draft_outline", kind: "light",
        desc: "规划小说大纲",
        outputs: [],
        checks: [{ method: "llm_rubric", desc: "大纲完整" }],
        updates: ["report_outline"],
      },
      {
        id: "write_chapter", kind: "agent", agent: "writer",
        desc: "根据大纲和已写内容写下一章",
        outputs: [{ path: "solution/chapters/", desc: "章节文件", role: "deliverable" }],
        checks: [{ method: "llm_rubric", desc: ">=3000字,情节连贯" }],
        updates: ["summary"],
        context_inputs: ["report_outline"],
      },
      {
        id: "polish_report", kind: "agent", agent: "writer",
        desc: "润色修订",
        outputs: [{ path: "solution/final.md", desc: "最终稿", role: "deliverable" }],
        checks: [{ method: "llm_rubric", desc: "通顺无错" }],
        context_inputs: ["report_outline"],
      },
    ],
    guardrails: { max_iterations: 5, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [
      { key: "summary", desc: "滚动摘要", bounded: true },
      { key: "report_outline", desc: "报告大纲", bounded: true },
    ] },
    entry_node: "draft_outline",
    completion_criteria: ["写到2章"],
    hard_constraints: ["输出纯正文,不含元描述"],
    soft_guidance: ["悬疑压抑基调"],
    agents: ["writer"],
    required_capabilities: ["web", "long_running"],
  };
}
