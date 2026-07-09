import test from "node:test";
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { renderHomePage } from "../src/web.js";

test("Web: renderHomePage 输出 HTML 引用外部 app.js", () => {
  const html = renderHomePage();
  assert.ok(html.includes("<!doctype html>"), "should have doctype");
  assert.ok(html.includes("</html>"), "should close html");
  assert.ok(html.includes('src="/app.js"'), "should reference external app.js");
  assert.ok(!html.includes("<script>\nlet selectedId"), "should NOT have inline JS");
});

test("Web: public/app.js 语法合法(Function 检查)", async () => {
  const js = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.doesNotThrow(() => {
    new Function(js);
  }, "app.js should be syntactically valid JS");
});

test("Web: public/app.js 包含核心函数", async () => {
  const js = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.ok(js.includes("function selectProject"), "should have selectProject");
  assert.ok(js.includes("function loadProjects"), "should have loadProjects");
  assert.ok(js.includes("function renderTimelineBlocks"), "should have renderTimelineBlocks");
  assert.ok(js.includes("function setViewMode"), "should have setViewMode");
  assert.ok(js.includes("markdownToHtml"), "should have markdownToHtml");
});
