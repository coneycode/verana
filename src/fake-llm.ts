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

export class FakeExecutorAdapter implements ExecutorAdapter {
  readonly name = "fake-executor";
  readonly capabilities = { name: "fake-executor", capabilities: ["web", "browser", "long_running", "skills", "terminal", "file"] };

  async probe() { return { available: true, command: "fake" }; }
  async execute(prompt: string, _workdir: string, _opts?: { maxTurns?: number; toolsets?: string[]; timeoutMs?: number; onOutputLine?: (line: string) => void }): Promise<AgentRun> {
    return {
      claim: `# 调研产出(模拟)\n\n基于 prompt 完成调研。\n\n来源:\n1. https://example.com/source-1\n2. https://example.com/source-2\n\n要点:产品定义、功能、用户、定价、竞品均有覆盖。`,
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
    if (role === "composer" && system.includes("方案澄清助手")) return { json: fakeClarifierQuestion() };

    // Composer 规划(生成图工作流 spec)
    if (role === "composer" && system.includes("workflow 规划者")) {
      return { json: fakeComposerGraphSpec(user) };
    }

    // Capability gap review(执行中能力缺口复核)
    if (role === "composer" && system.includes("workflow 规划者(Composer)。调度大脑报告了")) {
      return { json: { reasonable: false, reason: "测试:不需要新能力" } };
    }

    // Scheduler(调度大脑)
    if (role === "composer" && system.includes("调度大脑")) {
      schedCount++;
      if (schedCount <= 2) {
        return { json: { next_node: "write_chapter", reason: "继续写下一章", capability_gap: "", is_complete: false, action: "execute" } };
      }
      return { json: { next_node: "", reason: "已写到目标章数", capability_gap: "", is_complete: true, action: "execute" } };
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

function fakeComposerGraphSpec(userPrompt: string): unknown {
  // 从 user prompt 提取 project_id(目标里没有,用固定结构)
  return {
    clarified: "写一部悬疑小说,约2章",
    deliverable_type: "creative",
    iterative: true,
    acceptance: ["每章3000字以上", "情节连贯"],
    capabilities: [
      {
        id: "write_chapter", kind: "agent", agent: "writer",
        desc: "根据大纲和已写内容写下一章",
        outputs: [{ path: "solution/chapters/", desc: "章节文件" }],
        checks: [{ method: "llm_rubric", desc: ">=3000字,情节连贯" }],
        updates: ["summary"],
      },
    ],
    guardrails: { max_iterations: 5, soft: [], human_checkpoint_every: 0 },
    blackboard_schema: { fields: [{ key: "summary", desc: "滚动摘要", bounded: true }] },
    entry_node: "write_chapter",
    completion_criteria: ["写到2章"],
    hard_constraints: ["输出纯正文,不含元描述"],
    soft_guidance: ["悬疑压抑基调"],
    agents: ["writer"],
    required_capabilities: ["web", "long_running"],
  };
}
