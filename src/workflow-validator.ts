import { validateRelativeOutputPath } from "./artifacts.js";
import type { GraphWorkflowSpec } from "./types.js";

export interface ValidationResult {
  passed: boolean;
  errors: string[];
}

export function validateGraphWorkflow(spec: GraphWorkflowSpec): ValidationResult {
  const errors: string[] = [];

  // 能力清单
  if (!spec.capabilities || spec.capabilities.length === 0) {
    errors.push("capabilities is empty");
  }
  const ids = new Set<string>();
  for (const cap of spec.capabilities ?? []) {
    if (ids.has(cap.id)) errors.push(`duplicate capability id: ${cap.id}`);
    ids.add(cap.id);
    if (!cap.desc) errors.push(`capability ${cap.id} has no desc`);
    if (!cap.checks || cap.checks.length === 0) errors.push(`capability ${cap.id} has no checks (no check no execute)`);
    if (cap.kind !== "light" && cap.kind !== "agent") errors.push(`capability ${cap.id} kind must be light|agent`);
    if (cap.kind === "agent" && (!cap.outputs || cap.outputs.length === 0)) {
      errors.push(`capability ${cap.id} is agent but has no outputs (artifact contract required)`);
    }
    const outputPaths = new Set<string>();
    for (const output of cap.outputs ?? []) {
      if (outputPaths.has(output.path)) errors.push(`capability ${cap.id} has duplicate output path: ${output.path}`);
      outputPaths.add(output.path);
      for (const failure of validateRelativeOutputPath(output.path)) {
        errors.push(`capability ${cap.id} ${failure.message}`);
      }
    }
    // instances: 有非空 instances 的节点,每个 output path 必须含 {instance} 占位符
    if (cap.instances && cap.instances.length > 0) {
      for (const output of cap.outputs ?? []) {
        if (!output.path.includes("{instance}")) {
          errors.push(`capability ${cap.id} has instances but output path "${output.path}" missing {instance} placeholder — each instance writes to a different file`);
        }
      }
    }
    if (cap.instances && cap.instances.length > 0) {
      const remainingKey = `${cap.id}_remaining`;
      const hasRemainingField = spec.blackboard_schema?.fields?.some(f => f.key === remainingKey);
      if (!hasRemainingField) {
        errors.push(`capability ${cap.id} has instances but blackboard_schema missing field "${remainingKey}"`);
      }
    }
    // context_inputs: 声明的字段名必须在 blackboard_schema 里存在
    if (cap.context_inputs && cap.context_inputs.length > 0) {
      const bbFields = new Set((spec.blackboard_schema?.fields ?? []).map(f => f.key));
      for (const field of cap.context_inputs) {
        if (!bbFields.has(field)) {
          errors.push(`capability ${cap.id} context_inputs references unknown blackboard field "${field}"`);
        }
      }
    }
  }

  // 报告写作链路完整性:有产出 deliverable 的节点,必须有 draft_outline 在前 + polish 在后
  // 不按固定 ID 匹配(Composer 可能用 write_ppt_report 等不同 ID),按产出特征匹配
  const caps = spec.capabilities ?? [];
  const deliverableNodes = caps.filter(c => c.outputs?.some(o => (o.role ?? "deliverable") === "deliverable"));
  if (deliverableNodes.length > 0) {
    const writeNode = deliverableNodes[0]; // 第一个产出 deliverable 的节点是写作节点
    // 检查有没有 light 节点在它前面(大纲规划)
    const writeIdx = caps.indexOf(writeNode);
    const hasDraftOutline = caps.slice(0, writeIdx).some(c => c.kind === "light");
    if (!hasDraftOutline) {
      errors.push(`${writeNode.id} produces deliverable but no light node (draft_outline) precedes it — report writing requires a structure planning step before writing`);
    }
    // 检查有没有 agent 节点在它后面(润色修订)
    const hasPolish = caps.slice(writeIdx + 1).some(c => c.kind === "agent" && c.outputs?.some(o => (o.role ?? "deliverable") === "deliverable" || (o.role ?? "") === "intermediate"));
    if (!hasPolish) {
      errors.push(`${writeNode.id} produces deliverable but no polish/revise agent node follows it — report writing requires a polish step after writing`);
    }
  }

  // 审校类节点 checks 口径(2026-10-12 RRSI 事故):审校节点的 outputs 是审校意见
  // (intermediate),checks 必须验收审校意见本身。若 checks 照抄了 deliverable_contract
  // 的 required_sections/字数等被审对象的标准,该节点机械上必现 fail — 拦在规划期。
  // 判定:节点 desc/id 含审校语义 且 outputs 全是 intermediate → 检查其 checks 是否
  // 与 deliverable_contract 的章节/结构要求高度重叠(出现≥2个必需章节名 或 出现
  // "全部X个必需章节"句式 且 checks 里没有"审校/核对/结论"类措辞)。
  const reviewSemantic = /审校|审阅|评审|复核|review/i;
  for (const cap of caps) {
    const isReviewNode = reviewSemantic.test(cap.id) || reviewSemantic.test(cap.desc.slice(0, 30));
    const allIntermediate = (cap.outputs ?? []).length > 0 && cap.outputs!.every(o => (o.role ?? "") === "intermediate");
    if (!isReviewNode || !allIntermediate) continue;
    const contract = spec.deliverable_contract;
    const sections = contract?.required_sections ?? [];
    const checksText = (cap.checks ?? []).map(c => c.desc).join("\n");
    const sectionHits = sections.filter(s => s && checksText.includes(s)).length;
    const hasReviewPhrasing = /审校|核对|逐项|结论|通过\/不通过|检查了/.test(checksText);
    if (sections.length >= 2 && sectionHits >= 2 && !hasReviewPhrasing) {
      errors.push(`capability ${cap.id} 是审校节点但 checks 照抄了被审对象的标准(命中 ${sectionHits}/${sections.length} 个必需章节名,且无审校口径措辞) — 审校节点的 checks 应验收审校意见本身(如:审校覆盖全部验收标准并给出明确通过/不通过结论),不能要求审校意见包含报告全文/章节结构`);
    }
  }

  // 入口节点存在
  if (spec.entry_node && !ids.has(spec.entry_node)) {
    errors.push(`entry_node ${spec.entry_node} not in capabilities`);
  }

  // 护栏
  if (!spec.guardrails?.hard?.max_iterations) {
    errors.push("guardrails.hard.max_iterations missing (no safety valve)");
  }
  if (!spec.completion_criteria || spec.completion_criteria.length === 0) {
    errors.push("completion_criteria is empty");
  }

  // blackboard schema
  if (!spec.blackboard_schema?.fields || spec.blackboard_schema.fields.length === 0) {
    errors.push("blackboard_schema.fields is empty");
  }
  // 每个字段至少有一个节点负责更新(bounded 的字段尤其要)
  // 但 _remaining 字段是代码维护的(graph-engine 初始化 + verdict pass 后代码移除),
  // 不应该由节点 updates,豁免校验
  const updateableFields = new Set<string>();
  for (const cap of spec.capabilities ?? []) {
    for (const f of cap.updates ?? []) updateableFields.add(f);
  }
  for (const f of spec.blackboard_schema?.fields ?? []) {
    if (f.bounded && !updateableFields.has(f.key)) {
      // _remaining 字段由 graph-engine 代码维护,不由 LLM 节点 updates
      if (f.key.endsWith("_remaining")) continue;
      errors.push(`blackboard field ${f.key} is bounded but no node updates it`);
    }
  }

  // goal
  if (!spec.goal?.clarified) errors.push("goal.clarified is empty");
  if (!spec.goal?.acceptance || spec.goal.acceptance.length === 0) errors.push("goal.acceptance is empty");

  return { passed: errors.length === 0, errors };
}
