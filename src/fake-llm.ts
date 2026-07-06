import type { LlmClient, ModelRole } from "./llm.js";

export interface FakeResponse {
  complete?: string;
  json?: unknown;
}

export class FakeLlmClient implements LlmClient {
  readonly calls: Array<{ role: ModelRole; system: string; user: string }> = [];

  constructor(private readonly responder: (role: ModelRole, system: string, user: string) => FakeResponse) {}

  async complete(role: ModelRole, system: string, user: string): Promise<string> {
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
  return { question: "你要监控哪些平台?", risk: "不澄清会导致方案偏掉。" };
}

export function fakeExecutorContent() {
  return "# 交付内容\n\n这是 fake LLM 产出的交付物。";
}

/**
 * buildSmartFakeClient — 支持图工作流引擎的各类 LLM 响应:
 * - clarifier(澄清问题)
 * - scheduler(调度大脑:选节点+理由)
 * - executor(节点执行:产出内容)
 * - cross_check(轻节点交叉验证)
 * - verifier(重节点验证)
 * - guardrail(软护栏检查)
 * - blackboard_update(记忆更新)
 */
export function buildSmartFakeClient(): FakeLlmClient {
  let callCount = 0;
  return new FakeLlmClient((role, system, user) => {
    // Clarifier
    if (role === "composer" && system.includes("方案澄清助手")) return { json: fakeClarifierQuestion() };

    // Scheduler(调度大脑)
    if (role === "composer" && system.includes("调度大脑")) {
      // 第一次选入口节点,之后判断完成
      callCount++;
      if (callCount <= 2) {
        return { json: { next_node: "write_chapter", reason: "继续写下一章", capability_gap: "", is_complete: false } };
      }
      return { json: { next_node: "", reason: "已写到目标章数", capability_gap: "", is_complete: true } };
    }

    // Capability gap review
    if (role === "composer" && system.includes("workflow 规划者")) {
      return { json: { reasonable: false, reason: "测试:不需要新能力" } };
    }

    // Cross check(轻节点交叉验证)
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
