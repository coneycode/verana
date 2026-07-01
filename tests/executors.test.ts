import assert from "node:assert/strict";
import test from "node:test";

import { HermesAdapter, selectExecutor } from "../src/executors.js";

test("HermesAdapter declares the solution-workflow capabilities", () => {
  const adapter = new HermesAdapter();

  assert.equal(adapter.name, "hermes");
  assert.equal(adapter.capabilities.capabilities.includes("web"), true);
  assert.equal(adapter.capabilities.capabilities.includes("browser"), true);
  assert.equal(adapter.capabilities.capabilities.includes("long_running"), true);
});

test("selectExecutor returns the first adapter covering all required capabilities", () => {
  const hermes = new HermesAdapter();

  assert.equal(selectExecutor(["web", "browser", "long_running"], [hermes]), hermes);
  assert.equal(selectExecutor(["nonexistent"], [hermes]), null);
});
