import test from "node:test";
import assert from "node:assert";
import { renderHomePage } from "../src/web.js";

test("Web: renderHomePage 输出 HTML 包含合法 JS(node --check)", () => {
  const html = renderHomePage();
  // 提取 <script> 标签内容(不含 src 的)
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, "should have inline <script>");
  const js = m[1];
  // 用 Function 构造器检查语法(不执行)
  // 注意:Function 构造器不允许 return 在顶层,但我们的代码没有顶层 return
  assert.doesNotThrow(() => {
    new Function(js);
  }, "inline JS should be syntactically valid");
});

test("Web: renderHomePage 包含基本 HTML 结构", () => {
  const html = renderHomePage();
  assert.ok(html.includes("<!doctype html>"), "should have doctype");
  assert.ok(html.includes("</html>"), "should close html");
  assert.ok(html.includes("createBtn"), "should have create button");
  assert.ok(html.includes("loadProjects"), "should have loadProjects call");
});
