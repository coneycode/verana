import { test } from "node:test";
import assert from "node:assert";
import { rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createProject } from "../src/project-store.js";

const TMP = join(process.cwd(), "tmp-test-remaining");

/** LLM 故意不写 _remaining 字段 — assembleSpec 应自动补全,硬校验通过 */
function buildForgettingClient() {
  return {
    async complete(role: string, system: string, _user: string): Promise<string> {
      if (system.includes("判断任务类型")) {
        return JSON.stringify({ task_type: "research" });
      }
      if (system.includes("workflow 规划者")) {
        return JSON.stringify({
          clarified: "调研某产品并写报告",
          deliverable_type: "research",
          iterative: true,
          acceptance: ["覆盖核心维度"],
          capabilities: [
            {
              id: "plan_outline", kind: "light", desc: "规划大纲",
              outputs: [], checks: [{ method: "llm_rubric", desc: "大纲完整" }],
              updates: ["report_outline"], instances: [],
            },
            {
              id: "search", kind: "agent", agent: "researcher", desc: "按维度搜索",
              outputs: [{ path: "solution/search/{instance}.md", desc: "原始搜索", role: "evidence" }],
              checks: [{ method: "llm_rubric", desc: "有结果有来源" }],
              instances: [
                { name: "product", scope: "产品形态", excludes: "商业模式" },
                { name: "market", scope: "商业模式", excludes: "产品形态" },
              ],
            },
            {
              id: "write_evidence", kind: "agent", agent: "writer", desc: "整理证据",
              outputs: [{ path: "solution/evidence/{instance}.md", desc: "结构化证据", role: "intermediate" }],
              checks: [{ method: "llm_rubric", desc: "结构化" }],
              context_inputs: ["report_outline"],
              instances: [
                { name: "product", scope: "产品形态", excludes: "商业模式" },
                { name: "market", scope: "商业模式", excludes: "产品形态" },
              ],
            },
            {
              id: "synthesize", kind: "agent", agent: "writer", desc: "综合报告",
              outputs: [{ path: "solution/report.md", desc: "调研报告", role: "deliverable" }],
              checks: [{ method: "llm_rubric", desc: "结构完整" }],
              context_inputs: ["report_outline"],
            },
            {
              id: "polish_report", kind: "agent", agent: "writer", desc: "润色",
              outputs: [{ path: "solution/final_report.md", desc: "最终报告", role: "deliverable" }],
              checks: [{ method: "llm_rubric", desc: "通顺" }],
              context_inputs: ["report_outline"],
            },
          ],
          guardrails: { max_iterations: 10, soft: [], human_checkpoint_every: 0 },
          // 故意漏掉 search_remaining / write_evidence_remaining
          blackboard_schema: { fields: [
            { key: "report_outline", desc: "报告大纲", bounded: true },
          ] },
          entry_node: "plan_outline",
          completion_criteria: ["报告通过验收"],
          hard_constraints: [],
          soft_guidance: [],
          agents: ["researcher", "writer"],
          required_capabilities: ["web"],
        });
      }
      if (system.includes("规划充分性检查器")) {
        return JSON.stringify({ passed: true, issues: [] });
      }
      return JSON.stringify({ passed: true, issues: [] });
    },
    async completeJson<T>(_role: string, system: string, user: string): Promise<T> {
      return JSON.parse(await this.complete(_role, system, user)) as T;
    },
  } as any;
}

test("LLM 忘写 _remaining 字段时 assembleSpec 自动补全,硬校验通过", async () => {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  const p = await createProject(TMP, "调研某产品", "调研");
  const { planGraphWorkflow } = await import("../src/pipeline.js");
  const spec = await planGraphWorkflow(TMP, p.id, buildForgettingClient());

  // 自动补全的字段存在且 bounded
  const keys = spec.blackboard_schema.fields.map(f => f.key);
  assert.ok(keys.includes("search_remaining"), `search_remaining missing, got: ${keys.join(",")}`);
  assert.ok(keys.includes("write_evidence_remaining"), `write_evidence_remaining missing, got: ${keys.join(",")}`);
  for (const f of spec.blackboard_schema.fields) {
    if (f.key.endsWith("_remaining")) assert.equal(f.bounded, true);
  }
  // 不重复:LLM 写了的不加第二份
  assert.equal(spec.blackboard_schema.fields.filter(f => f.key === "search_remaining").length, 1);
  // 规划完成进入 plan_review(说明硬校验+充分性都过了)
  const { getProject } = await import("../src/project-store.js");
  const state = await getProject(TMP, p.id);
  assert.equal(state.status.workflows.solution?.workflow_status, "plan_review");
});
