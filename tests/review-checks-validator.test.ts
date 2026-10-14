import assert from "node:assert/strict";
import test from "node:test";

import { validateGraphWorkflow } from "../src/workflow-validator.js";
import type { GraphWorkflowSpec } from "../src/types.js";

/** 最小可过校验的 spec 骨架(测试用) */
function baseSpec(): GraphWorkflowSpec {
  return {
    goal: { original: "写报告", clarified: "写一份调研报告", deliverable_type: "report", acceptance: ["内容完整"] },
    entry_node: "plan",
    capabilities: [
      { id: "plan", desc: "规划大纲", kind: "light", checks: [{ method: "llm_rubric", desc: "大纲合理" }] },
      {
        id: "write_report", desc: "写报告", kind: "agent", agent: "writer",
        outputs: [{ path: "solution/report.md", desc: "报告", role: "deliverable" }],
        checks: [{ method: "file_exists", desc: "报告存在", target: "solution/report.md" }],
      },
      {
        id: "polish_report", desc: "润色报告", kind: "agent", agent: "writer",
        outputs: [{ path: "solution/report.md", desc: "润色后报告", role: "deliverable" }],
        checks: [{ method: "llm_rubric", desc: "语言流畅" }],
      },
    ],
    guardrails: { hard: { max_iterations: 20 } },
    completion_criteria: ["报告交付"],
    blackboard_schema: { fields: [{ key: "draft_status", desc: "状态", bounded: false }] },
    agents: ["writer"],
  } as unknown as GraphWorkflowSpec;
}

/** 审校节点:checks 照抄被审对象的标准(章节名命中≥2 且无审校措辞) → 必须拦截 */
test("审校节点 checks 照抄报告标准(required_sections 高重叠)被硬校验拦截", () => {
  const spec = baseSpec();
  spec.deliverable_contract = {
    required_sections: ["引言/背景", "核心原理", "方法优势", "实验重点", "总结"],
    forbidden_patterns: [],
  };
  (spec.capabilities as never as Array<Record<string, unknown>>).push({
    id: "review_report",
    desc: "审校最终报告是否满足全部验收标准",
    kind: "agent",
    agent: "reviewer",
    outputs: [{ path: "solution/review.md", desc: "审校意见", role: "intermediate" }],
    checks: [
      { method: "llm_rubric", desc: "全文明确包含全部5个必需章节：引言/背景、核心原理、方法优势、实验重点、总结" },
      { method: "llm_rubric", desc: "全文字数在1000-2000字范围内" },
      { method: "llm_rubric", desc: "未深入代码实现细节，聚焦原理和优势讲解" },
    ],
  });
  const result = validateGraphWorkflow(spec);
  assert.equal(result.passed, false);
  const hit = result.errors.find(e => e.includes("审校节点") && e.includes("review_report"));
  assert.ok(hit, `必须给出 review_report 口径错误,实际 errors: ${result.errors.join(" | ")}`);
});

/** 审校节点:checks 是审校口径(覆盖标准+给结论) → 放行 */
test("审校节点 checks 为审校口径时放行", () => {
  const spec = baseSpec();
  spec.deliverable_contract = {
    required_sections: ["引言/背景", "核心原理", "方法优势", "实验重点", "总结"],
    forbidden_patterns: [],
  };
  (spec.capabilities as never as Array<Record<string, unknown>>).push({
    id: "review_report",
    desc: "审校最终报告是否满足全部验收标准",
    kind: "agent",
    agent: "reviewer",
    outputs: [{ path: "solution/review.md", desc: "审校意见", role: "intermediate" }],
    checks: [
      { method: "llm_rubric", desc: "审校覆盖全部验收标准并给出明确通过/不通过结论" },
      { method: "llm_rubric", desc: "审校报告中明确检查了过程自述模式" },
    ],
  });
  const result = validateGraphWorkflow(spec);
  const hit = result.errors.find(e => e.includes("review_report") && e.includes("审校节点"));
  assert.equal(hit, undefined, `审校口径不应拦截,实际 errors: ${result.errors.join(" | ")}`);
});

/** 审校节点无 deliverable_contract 时(required_sections 为空)不误伤 */
test("无 deliverable_contract 时不触发审校口径校验", () => {
  const spec = baseSpec();
  (spec.capabilities as never as Array<Record<string, unknown>>).push({
    id: "review",
    desc: "复核结果",
    kind: "agent",
    agent: "reviewer",
    outputs: [{ path: "solution/review.md", desc: "复核意见", role: "intermediate" }],
    checks: [{ method: "llm_rubric", desc: "给出结论" }],
  });
  const result = validateGraphWorkflow(spec);
  const hit = result.errors.find(e => e.includes("复核") && e.includes("审校节点"));
  assert.equal(hit, undefined);
});

/** 非审校节点(如写作节点)包含章节名 checks 不受影响 */
test("写作节点的章节 checks 不被误伤", () => {
  const spec = baseSpec();
  spec.deliverable_contract = {
    required_sections: ["引言/背景", "核心原理", "方法优势"],
    forbidden_patterns: [],
  };
  (spec.capabilities[1] as unknown as Record<string, unknown>).checks = [
    { method: "llm_rubric", desc: "全文包含引言/背景、核心原理、方法优势三个章节" },
  ];
  const result = validateGraphWorkflow(spec);
  const hit = result.errors.find(e => e.includes("审校节点"));
  assert.equal(hit, undefined, `write_report 不是审校节点不应拦截,errors: ${result.errors.join(" | ")}`);
});
