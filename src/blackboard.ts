import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function getBlackboardField(bb: Record<string, unknown>, key: string): unknown {
  return bb[key];
}

export function setBlackboardField(bb: Record<string, unknown>, key: string, value: unknown): void {
  bb[key] = value;
}

/** 渲染 blackboard 给 LLM 上下文用。
 *  onlyFields: 指定只渲染哪些字段(null=全量,用于 scheduler 等需要看全局的场景)
 *  executor 调用时传 onlyFields=node.context_inputs 做精准注入
 */
export function renderBlackboardForContext(
  bb: Record<string, unknown>,
  schema: { fields: Array<{ key: string; desc: string }> },
  onlyFields: string[] | null = null,
): string {
  const lines: string[] = ["当前 blackboard 状态:"];
  const fieldsToRender = onlyFields
    ? schema.fields.filter(f => onlyFields.includes(f.key))
    : schema.fields;
  for (const f of fieldsToRender) {
    const val = bb[f.key];
    if (val === undefined || val === null || val === "") {
      lines.push(`  ${f.key}: (空) — ${f.desc}`);
    } else {
      const s = typeof val === "string" ? val : JSON.stringify(val);
      const preview = s.length > 500 ? s.slice(0, 500) + " ...(已截断)" : s;
      lines.push(`  ${f.key}: ${preview}`);
    }
  }
  return lines.join("\n");
}

export function applyHumanEdit(bb: Record<string, unknown>, key: string, value: unknown): { bb: Record<string, unknown>; note: string } {
  const oldVal = bb[key];
  bb[key] = value;
  const note = `人手改了 ${key}: ${JSON.stringify(oldVal).slice(0,80)} -> ${JSON.stringify(value).slice(0,80)}`;
  return { bb, note };
}
