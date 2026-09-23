import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateWorkerJson } from "../controller.mjs";
import { buildAssistedChildRow, buildBaselineChildRow, countersEqual, persistIssuesBeforeForward, persistTerminalBeforeAcceptance, PilotAccounting, providerCountersValid, usageTotal, validUsage, validatePilotFixture } from "./pilot-accounting.mjs";

const limits = { maxPremiumAttempts: 8, maxMinutes: 15, admissionTokens: 32_000 };
const usage = (input = 1) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
const fresh = () => path.join(mkdtempSync(path.join(os.tmpdir(), "autonoxis-pilot-accounting-")), "pilot.json");
async function issued(accounting, record = {}) { const state = await accounting.issue({ premium: true, arm: "baseline", phase: "child", ...record }); await accounting.terminal(state, { status: "completed", model: "openai-codex/gpt-5.6-sol:off", usage: usage(), ...record }); await accounting.outcome(state, { accepted: false, validation: "output_mismatch" }); return state; }

test("pilot fixture gates a single schema-matched node before any accounting issue", () => {
  const task = "Return order and total.";
  const fixture = { model: "openai-codex/gpt-5.6-sol", nodes: [{ task }], pilot: { baselineInstruction: task, ...limits } };
  assert.equal(validatePilotFixture(fixture), fixture);
  assert.throws(() => validatePilotFixture({ ...fixture, nodes: [fixture.nodes[0], fixture.nodes[0]] }), /pilot_requires_exactly_one_node/);
  assert.throws(() => validatePilotFixture({ ...fixture, pilot: { ...fixture.pilot, baselineInstruction: "different" } }), /pilot_baseline_schema_mismatch/);
});

test("baseline builder derives verifier-valid observer registration from harness path/hash", () => {
  const row = buildBaselineChildRow({ arm: "baseline", terminal: { model: "openai-codex/gpt-5.6-sol:off", status: "completed", usage: usage(), launchContractDigest: "d" }, outputHash: "a".repeat(64), observer: { observerHash: "h" }, observerPath: "/tmp/observer.ts", observerHash: "h", preflight: { agent: {} }, requestId: "r", ownerRunId: "o", nodeId: "n" });
  assert.deepEqual(row.observerRegistration, { id: "autonoxis-observer", path: "/tmp/observer.ts", hash: "h" });
  assert.equal(row.observer.observerHash, row.observerRegistration.hash);
});

test("assisted producer row carries node policy and collector counters fail closed", () => {
  const identity = { requestId: "r", ownerRunId: "o", nodeId: "n" };
  const terminal = { ...identity, model: "openai-codex/gpt-5.6-sol:off", status: "completed", usage: usage(), launchContractDigest: "d", outputHash: "a".repeat(64) };
  const localPolicy = { conductor: { decision: "DISPATCH", durationMs: 1, promptBytes: 1, responseEvalCount: null }, manager: { decision: "ACCEPT", durationMs: 1, promptBytes: 1, responseEvalCount: null } };
  const built = buildAssistedChildRow({ terminalEntry: { data: terminal }, transport: { requests: [identity], terminals: [terminal] }, contractHash: "h", node: { data: { localPolicy } } });
  assert.deepEqual(built.row.localPolicy, localPolicy); assert.equal(built.matching.length, 1); assert.equal(built.identityMatch, true);
  assert.equal(buildAssistedChildRow({ terminalEntry: { data: { ...terminal, ownerRunId: undefined } }, transport: { requests: [identity], terminals: [terminal] }, contractHash: "h", node: { data: { localPolicy } } }).identityMatch, false);
  assert.equal(buildAssistedChildRow({ terminalEntry: { data: { ...terminal, ownerRunId: "wrong" } }, transport: { requests: [identity], terminals: [terminal] }, contractHash: "h", node: { data: { localPolicy } } }).identityMatch, false);
  assert.equal(countersEqual({ before: 1, after: 2 }, { before: 1, after: 2 }), true);
  assert.equal(countersEqual({ before: 1, after: 2 }, {}), false);
});

test("provider counter policy accepts WebSocket/SSE response subsets and rejects malformed counts", () => {
  for (const after of [0, 1, 2]) assert.equal(providerCountersValid({ before: 2, after }, 2), true);
  for (const after of [0, 1]) assert.equal(providerCountersValid({ before: 1, after }, 1), true);
  for (const value of [{ before: 2, after: 3 }, { before: 1, after: 2 }, { before: 1, after: -1 }, { before: 1, after: 0.5 }, { before: Number.MAX_SAFE_INTEGER + 1, after: 0 }, { before: 0, after: 0 }, {}, null]) assert.equal(providerCountersValid(value, 1), false, JSON.stringify(value));
});

test("pilot fixture schema rejects the recovered shape and accepts the stated shape", () => {
  const expected = { order: ["a", "b", "c"], total: 14 };
  assert.equal(validateWorkerJson('{"records":[{"id":"a","amount":2},{"id":"b","amount":5},{"id":"c","amount":7}],"total":14}', expected).ok, false);
  assert.equal(validateWorkerJson('{"order":["a","b","c"],"total":14}', expected).ok, true);
});

test("harness ordering primitives persist before parent, baseline, and assisted forwarding or acceptance", async () => {
  const accounting = new PilotAccounting({ evidencePath: fresh(), limits }); await accounting.reserve();
  const events = [];
  const parent = await persistIssuesBeforeForward(accounting, [{ premium: true, arm: "baseline", phase: "parent-1" }], async ([attempt]) => { events.push(`parent-forward-${!!attempt.issued}`); return "parent"; });
  const baseline = await persistIssuesBeforeForward(accounting, [{ premium: true, arm: "baseline", phase: "child" }], async ([attempt]) => { events.push(`baseline-forward-${!!attempt.issued}`); return "child"; });
  const assisted = await persistIssuesBeforeForward(accounting, [{ premium: false, arm: "assisted", phase: "command" }, { premium: true, arm: "assisted", phase: "child" }], async ([command, child]) => { events.push(`assisted-forward-${!!command.issued && !!child.issued}`); return "command"; });
  assert.deepEqual(events, ["parent-forward-true", "baseline-forward-true", "assisted-forward-true"]);
  for (const state of [...parent.attempts, ...baseline.attempts, ...assisted.attempts]) {
    const accepted = await persistTerminalBeforeAcceptance(accounting, state, { usage: usage(), status: "completed" }, () => { assert.ok(state.terminal); return true; });
    await accounting.outcome(state, { accepted });
  }
  assert.doesNotThrow(() => accounting.assertResolved());
  let writes = 0;
  const failed = new PilotAccounting({ evidencePath: fresh(), limits, fs: { lstat: async () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; }, mkdir, writeFile: async (...args) => { if (++writes === 1) return await writeFile(...args); throw new Error("persist_failed"); } } });
  await failed.reserve(); let forwarded = false;
  await assert.rejects(() => persistIssuesBeforeForward(failed, [{ premium: true }], async () => { forwarded = true; }), /persist_failed/);
  assert.equal(forwarded, false);
  let timedOut;
  await assert.rejects(() => persistIssuesBeforeForward(accounting, [{ premium: true, arm: "baseline", phase: "child", requestId: "timeout-r", ownerRunId: "timeout-o", nodeId: "timeout-n" }], async () => { throw new Error("timeout"); }, ([attempt]) => { timedOut = attempt; }), /timeout/);
  await accounting.terminal(timedOut, { arm: "baseline", phase: "child", premium: true, status: "unresolved", usage: null, usageMissing: true, requestId: "timeout-r", ownerRunId: "timeout-o", nodeId: "timeout-n", unresolved: true });
  await accounting.outcome(timedOut, { accepted: false, unresolved: true });
  assert.ok(timedOut.terminal); assert.ok(timedOut.outcome);
});

test("terminal evidence is durable before output, model, digest, or observer rejection", async () => {
  for (const rejection of ["output_mismatch", "model_mismatch", "digest_mismatch", "observer_rejected", "manager_rejected", "no_wake_missing"]) {
    const accounting = new PilotAccounting({ evidencePath: fresh(), limits }); await accounting.reserve();
    const state = await issued(accounting, { arm: rejection.includes("manager") || rejection.includes("wake") ? "assisted" : "baseline" });
    assert.ok(state.terminal); assert.ok(state.outcome); assert.equal(state.outcomeRecord.accepted, false, rejection);
  }
});

test("parent exceptions and unexpected command inference retain available usage and block continuation", async () => {
  const accounting = new PilotAccounting({ evidencePath: fresh(), limits }); await accounting.reserve();
  const parent = await accounting.issue({ premium: true, arm: "baseline", phase: "parent-1" });
  await accounting.terminal(parent, { status: "failed", usage: usage(3), rawMessageCount: 1 }); await accounting.outcome(parent, { accepted: false, error: "parent_failed" });
  assert.equal(accounting.assertAdmissible({ elapsedMs: 1 }), 3);
  const command = await accounting.issue({ premium: false, arm: "assisted", phase: "command" });
  await accounting.terminal(command, { status: "completed", usage: usage(4), rawMessageCount: 1 }); await accounting.outcome(command, { accepted: false, error: "unexpected_parent_inference" });
  assert.equal(accounting.assertAdmissible({ elapsedMs: 1 }), 3);
});

test("missing terminals, missing usage, duplicates, limits, and overflow fail closed", async () => {
  const unresolved = new PilotAccounting({ evidencePath: fresh(), limits }); await unresolved.reserve(); await unresolved.issue({ premium: true }); assert.throws(() => unresolved.assertAdmissible({ forNextRequest: true }), /pilot_usage_incomplete/); assert.throws(() => unresolved.assertResolved(), /pilot_attempt_unresolved/);
  const incomplete = new PilotAccounting({ evidencePath: fresh(), limits }); await incomplete.reserve(); const state = await incomplete.issue({ premium: true }); await incomplete.terminal(state, { usage: null }); await incomplete.outcome(state, { accepted: false }); assert.throws(() => incomplete.assertAdmissible(), /pilot_usage_incomplete/);
  await assert.rejects(() => incomplete.terminal(state, { usage: usage() }), /pilot_terminal_identity_invalid/);
  const identities = new PilotAccounting({ evidencePath: fresh(), limits }); await identities.reserve(); await identities.issue({ premium: true, requestId: "r", ownerRunId: "o", nodeId: "n" }); await assert.rejects(() => identities.issue({ premium: true, requestId: "r", ownerRunId: "o", nodeId: "n" }), /pilot_attempt_identity_duplicate/);
  assert.equal(usageTotal([{ usage: usage(32_000) }]), 32_000); assert.equal(usageTotal([{ usage: usage(32_001) }]), null); assert.equal(usageTotal([{ usage: { input: 16_000, output: 16_001, cacheRead: 0, cacheWrite: 0 } }]), null);
  assert.equal(validUsage({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }), true); assert.equal(validUsage({ input: 1, output: 0, cacheRead: 0 }), false);
});

test("evidence reservation collisions prevent issue writes", async () => {
  const evidence = fresh(), attempts = path.join(path.dirname(evidence), "attempts"); await mkdir(attempts);
  const collision = new PilotAccounting({ evidencePath: evidence, limits }); await assert.rejects(() => collision.reserve());
  const occupied = fresh(); await writeFile(occupied, "prior evidence", { flag: "wx" }); await assert.rejects(() => new PilotAccounting({ evidencePath: occupied, limits }).reserve(), /pilot_evidence_collision/);
  const reservedCollision = fresh(), runtime = path.join(path.dirname(reservedCollision), "runtime-contract.json"); await writeFile(runtime, "prior runtime", { flag: "wx" }); await assert.rejects(() => new PilotAccounting({ evidencePath: reservedCollision, limits, reservePaths: [runtime] }).reserve(), /pilot_evidence_collision/);
  const accounting = new PilotAccounting({ evidencePath: fresh(), limits }); await accounting.reserve(); const state = await issued(accounting); const issuedPath = state.issued.path; await assert.rejects(() => writeFile(issuedPath, "rewrite", { flag: "wx" })); assert.match(readFileSync(issuedPath, "utf8"), /issued/);
});
