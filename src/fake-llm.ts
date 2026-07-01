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

export function fakeComposerWorkflow() {
  return {
    clarified: "调研海外红人监控系统,覆盖数据源和合规",
    acceptance: ["覆盖 3 类方案", "有推荐和理由"],
    tasks: [
      {
        id: "t1",
        desc: "调研数据源方案",
        agent: "researcher",
        skills: ["web-research"],
        depends_on: [],
        outputs: [{ path: "solution/research/findings.md", desc: "调研记录" }],
        checks: [{ method: "file_exists" as const, target: "solution/research/findings.md", desc: "非空" }],
      },
      {
        id: "t2",
        desc: "分析推荐",
        agent: "analyst",
        depends_on: ["t1"],
        inputs: [{ path: "solution/research/findings.md", desc: "调研记录" }],
        outputs: [{ path: "solution/solution.md", desc: "方案" }],
        checks: [{ method: "llm_rubric" as const, desc: "有推荐" }],
      },
    ],
  };
}

export function fakeVerifierPassed() {
  return { passed: true, reasons: ["内容满足验收"], evidence: ["solution/research/findings.md"] };
}

export function fakeExecutorContent() {
  return "# 交付内容\n\n这是 fake LLM 产出的交付物。";
}

export function buildSmartFakeClient(): FakeLlmClient {
  return new FakeLlmClient((role, system) => {
    if (role === "composer" && system.includes("workflow 架构师")) return { json: fakeComposerWorkflow() };
    if (role === "composer" && system.includes("方案澄清助手")) return { json: fakeClarifierQuestion() };
    if (role === "composer") return { complete: fakeExecutorContent() };
    return { json: fakeVerifierPassed() };
  });
}
