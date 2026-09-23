import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createHostDisposer, settleHostDisposals } from "./host-lifecycle.mjs";

test("host disposal awaits shutdown before invalidation and is idempotent", async () => {
  const order = [], errors = [];
  const runtime = {
    session: { dispose: () => order.push("forced") },
    dispose: async () => { order.push("shutdown-start"); await Promise.resolve(); order.push("shutdown-end"); order.push("invalidate"); }
  };
  const dispose = createHostDisposer({ runtime, errors, timeoutMs: 50 });
  await Promise.all([dispose(), dispose()]);
  assert.deepEqual(order, ["shutdown-start", "shutdown-end", "invalidate"]);
});

test("host disposal fails closed without bypassing session_shutdown", async () => {
  let forced = 0;
  const hanging = createHostDisposer({ runtime: { session: { dispose: () => forced++ }, dispose: () => new Promise(() => {}) }, errors: [], timeoutMs: 5 });
  await assert.rejects(hanging(), /host_shutdown_timeout/);
  assert.equal(forced, 0);

  const errors = [];
  const rejected = createHostDisposer({ runtime: { session: { dispose: () => {} }, dispose: async () => { errors.push("shutdown handler failed"); } }, errors, timeoutMs: 50 });
  await assert.rejects(rejected(), /extension_shutdown_failed/);
});

test("host cleanup attempts every constructed host when another cleanup fails", async () => {
  const calls = [];
  const failures = await settleHostDisposals([{ dispose: async () => { calls.push("first"); throw new Error("first_failed"); } }, undefined, { dispose: async () => { calls.push("second"); } }]);
  assert.deepEqual(calls, ["first", "second"]); assert.equal(failures.length, 1); assert.match(String(failures[0]), /first_failed/);
});

test("awaited shutdown clears a referenced resource and permits natural subprocess exit", () => {
  const helper = new URL("./host-lifecycle.mjs", import.meta.url).href;
  const source = `import { createHostDisposer } from ${JSON.stringify(helper)};\nconst timer = setInterval(() => {}, 1000);\nconst runtime = { session: { dispose() {} }, async dispose() { clearInterval(timer); } };\nawait createHostDisposer({ runtime, errors: [], timeoutMs: 50 })();`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8", timeout: 500 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.signal, null);
});
