import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAssistedChildRow, PilotAccounting } from "./pilot-accounting.mjs";
import { resolvePinnedPiEntry } from "./pi-entry.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");

test("misspelled status command reaches the plugin without inference", async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const anchor = path.join(agentDir, "npm", "package.json"), { entry: piEntry } = resolvePinnedPiEntry();
  const jiti = createRequire(anchor)("jiti")(anchor, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piEntry } });
  const plugin = (await jiti.import(path.resolve("index.ts"))).default;
  const commands = {}, notices = [];
  plugin({ registerCommand: (name, command) => { commands[name] = command; }, on: () => {}, events: { on: () => () => {}, emit: () => {} }, appendEntry: () => { throw new Error("unexpected_entry"); } });
  assert.deepEqual(Object.keys(commands).sort(), ["atonoxis", "autonoxis"]);
  assert.equal(commands.atonoxis.handler, commands.autonoxis.handler);
  await commands.atonoxis.handler("status", { ui: { notify: (message, level) => notices.push({ message, level }) } });
  assert.deepEqual(notices, [{ message: "No active Autonoxis run.", level: "info" }]);
});

test("actual plugin terminal preserves the correlated identity through accounting artifacts", { timeout: 20_000 }, async () => {
  const pluginRoot = path.resolve(".");
  const runRoot = mkdtempSync(path.join(os.tmpdir(), "autonoxis-producer-"));

  const harness = path.join(pluginRoot, "test", "native-harness.mjs");
  const env = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENTS_HERDR_BRIDGE: "0" };
  const identityResult = spawnSync(process.execPath, [harness, "print-agent-identity", "--run-root", runRoot], { env, encoding: "utf8" });
  assert.equal(identityResult.status, 0, identityResult.stderr);
  const agent = JSON.parse(identityResult.stdout);
  const task = 'Return compact JSON only, with exactly two keys: order, an array of record IDs sorted ascending, and total, the sum of all amounts. Do not return record objects or additional keys. Records: [{"id":"c","amount":7},{"id":"a","amount":2},{"id":"b","amount":5}].';
  const contract = { version: 2, authorityId: "producer-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), cwd: runRoot, model: "openai-codex/gpt-5.6-sol", agentDefinitionDigest: agent.definitionDigest, agentDefinitionProjectionVersion: 2, nodes: [{ id: "sort", actor: "pi-autonoxis.sol-leaf", task, expectedJson: { order: ["a", "b", "c"], total: 14 }, timeoutMs: 10_000 }] };
  const contractText = JSON.stringify(contract), contractPath = path.join(runRoot, "contract.json");
  writeFileSync(contractPath, contractText);

  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const anchor = path.join(agentDir, "npm", "package.json");
  const { entry: piEntry } = resolvePinnedPiEntry();
  const jiti = createRequire(anchor)("jiti")(anchor, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piEntry } });
  const [pluginModule, delegation, preflight, ceiling] = await Promise.all([
    jiti.import(path.join(pluginRoot, "index.ts")),
    jiti.import("pi-subagents/delegation"),
    jiti.import("pi-subagents/preflight"),
    jiti.import("pi-subagents/capability-ceiling")
  ]);

  const handlers = new Map(), commands = {}, entries = [], notices = [], requests = [], terminals = [];
  const sessionId = "producer-parent", availableModels = [{ provider: "openai-codex", id: "gpt-5.6-sol" }];
  const observerPath = path.join(pluginRoot, "test", "observer.ts"), observerHash = sha256(readFileSync(observerPath));
  const events = {
    on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => handlers.set(name, (handlers.get(name) ?? []).filter(value => value !== handler)); },
    emit(name, value) {
      for (const handler of [...(handlers.get(name) ?? [])]) handler(value);
      if (name !== delegation.SUBAGENT_DELEGATION_REQUEST_EVENT) return;
      requests.push(value);
      for (const handler of [...(handlers.get(delegation.SUBAGENT_DELEGATION_STARTED_EVENT) ?? [])]) handler({ requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId });
      queueMicrotask(async () => {
        const resolved = await preflight.resolveSubagentLaunchContract({ agent: value.agent, task: value.task, cwd: value.cwd, context: value.context, model: value.model, thinking: value.thinking, skill: value.skill, artifacts: value.artifacts, parentSessionId: sessionId, sessionDir: path.join(runRoot, ".pi", "autonoxis-preflight"), availableModels, capabilityCeiling: ceiling.resolveCurrentSubagentCapabilityCeiling(sessionId), intercomBridge: value.intercomBridge });
        const collector = globalThis[Symbol.for("pi-autonoxis.observer.v1")];
        collector.snapshots.push({ sessionId: "producer-child", tools: [], cwd: runRoot, startupEntrySummary: [{ type: "model_change" }, { type: "thinking_level_change" }], postTurnEntrySummary: [{ type: "model_change" }, { type: "thinking_level_change" }, { type: "session_info" }, { type: "message", role: "user" }, { type: "message", role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", responseModel: "gpt-5.6-sol", providerThinkingLevel: "off" }], postTurnCaptureCount: 1, bridgeActive: false, observerId: "autonoxis-observer", observerHash });
        const response = { requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId, status: "completed", model: "openai-codex/gpt-5.6-sol:off", thinking: "off", launchContractDigest: resolved.contract.launchContractDigest, result: { kind: "text", text: '{"order":["a","b","c"],"total":14}' }, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
        terminals.push(response);
        for (const handler of [...(handlers.get(delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT) ?? [])]) handler(response);
      });
    }
  };
  const pi = { registerCommand: (name, command) => { commands[name] = command; }, on: (name, handler) => events.on(name, handler), events, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  pluginModule.default(pi);
  const priorCounters = { before: 7, after: 3 };
  globalThis[Symbol.for("pi-autonoxis.observer.v1")] = { providerRequests: priorCounters };
  const ctx = { cwd: runRoot, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, modelRegistry: { getAvailable: () => availableModels }, ui: { notify: (message, level) => notices.push({ message, level }) } };

  const originalFetch = globalThis.fetch;
  let policyCalls = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: ++policyCalls === 1 ? "DECISION: DISPATCH" : "ACTION: ACCEPT" }, eval_count: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  try { await commands.autonoxis.handler(`run ${contractPath} ${sha256(contractText)}`, ctx); }
  finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for("pi-autonoxis.observer.v1")]; }

  assert.equal(notices.some(value => value.level === "error"), false, JSON.stringify(notices));
  assert.equal(requests.length, 1); assert.equal(terminals.length, 1);
  const terminalEntry = entries.find(entry => entry.customType === "autonoxis-terminal");
  const nodeEntry = entries.find(entry => entry.customType === "autonoxis-node");
  assert.ok(terminalEntry); assert.ok(nodeEntry);
  assert.deepEqual(terminalEntry.data.providerRequests, priorCounters);
  const triple = { requestId: requests[0].requestId, ownerRunId: requests[0].ownerRunId, nodeId: requests[0].nodeId };
  assert.deepEqual({ requestId: terminalEntry.data.requestId, ownerRunId: terminalEntry.data.ownerRunId, nodeId: terminalEntry.data.nodeId }, triple);
  const built = buildAssistedChildRow({ terminalEntry, transport: { requests, terminals }, contractHash: sha256(contractText), node: nodeEntry, hashText: sha256 });
  assert.equal(built.identityMatch, true);
  assert.deepEqual({ requestId: built.row.requestId, ownerRunId: built.row.ownerRunId, nodeId: built.row.nodeId }, triple);

  const accountingPath = path.join(mkdtempSync(path.join(os.tmpdir(), "autonoxis-producer-accounting-")), "pilot.json");
  const accounting = new PilotAccounting({ evidencePath: accountingPath, limits: { maxPremiumAttempts: 8, maxMinutes: 15, admissionTokens: 32_000 } });
  await accounting.reserve();
  const attempt = await accounting.issue({ arm: "assisted", phase: "child", premium: true, requestedModel: contract.model, requestedThinking: "off", nodeId: triple.nodeId });
  await accounting.terminal(attempt, { ...built.row, unresolved: false });
  await accounting.outcome(attempt, { accepted: true, unresolved: false, validation: { ok: true, format_canonical: true } });
  const terminalArtifact = JSON.parse(readFileSync(attempt.terminal.path, "utf8"));
  const outcomeArtifact = JSON.parse(readFileSync(attempt.outcome.path, "utf8"));
  for (const artifact of [terminalArtifact, outcomeArtifact]) assert.deepEqual({ requestId: artifact.requestId, ownerRunId: artifact.ownerRunId, nodeId: artifact.nodeId }, triple);
  pluginModule.default(pi);
  await commands.autonoxis.handler(`run ${contractPath} ${sha256(contractText)}`, ctx);
  assert.ok(notices.some(value => value.message === "authority_already_used" && value.level === "error"), JSON.stringify(notices));
  assert.equal(requests.length, 1);
});

test("session shutdown settles an in-flight delegation and removes its listeners", { timeout: 10_000 }, async () => {
  const pluginRoot = path.resolve("."), runRoot = mkdtempSync(path.join(os.tmpdir(), "autonoxis-shutdown-")), harness = path.join(pluginRoot, "test", "native-harness.mjs"), env = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENTS_HERDR_BRIDGE: "0" };
  const identityResult = spawnSync(process.execPath, [harness, "print-agent-identity", "--run-root", runRoot], { env, encoding: "utf8" });
  assert.equal(identityResult.status, 0, identityResult.stderr);
  const agent = JSON.parse(identityResult.stdout), task = "Return compact JSON only: {\"ok\":true}.", contract = { version: 2, authorityId: "shutdown-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), cwd: runRoot, model: "openai-codex/gpt-5.6-sol", agentDefinitionDigest: agent.definitionDigest, agentDefinitionProjectionVersion: 2, nodes: [{ id: "shutdown", actor: "pi-autonoxis.sol-leaf", task, expectedJson: { ok: true }, timeoutMs: 5_000 }] }, contractText = JSON.stringify(contract), contractPath = path.join(runRoot, "contract.json");
  writeFileSync(contractPath, contractText);
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), anchor = path.join(agentDir, "npm", "package.json"), { entry: piEntry } = resolvePinnedPiEntry(), jiti = createRequire(anchor)("jiti")(anchor, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piEntry } }), pluginModule = await jiti.import(path.join(pluginRoot, "index.ts")), delegation = await jiti.import("pi-subagents/delegation");
  const commands = {}, hooks = {}, handlers = new Map(), notices = [], entries = [], sessionId = "shutdown-parent", availableModels = [{ provider: "openai-codex", id: "gpt-5.6-sol" }];
  let requestResolve;
  const requested = new Promise(resolve => { requestResolve = resolve; });
  const events = { on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => handlers.set(name, (handlers.get(name) ?? []).filter(value => value !== handler)); }, emit(name, value) { for (const handler of [...(handlers.get(name) ?? [])]) handler(value); if (name === delegation.SUBAGENT_DELEGATION_REQUEST_EVENT) { for (const handler of [...(handlers.get(delegation.SUBAGENT_DELEGATION_STARTED_EVENT) ?? [])]) handler({ requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId }); requestResolve(value); } } };
  const pi = { registerCommand: (name, command) => { commands[name] = command; }, on: (name, handler) => { hooks[name] = handler; }, events, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  pluginModule.default(pi);
  globalThis[Symbol.for("pi-autonoxis.observer.v1")] = { providerRequests: { before: 0, after: 0 } };
  const ctx = { cwd: runRoot, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, modelRegistry: { getAvailable: () => availableModels }, ui: { notify: (message, level) => notices.push({ message, level }) } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: "DECISION: DISPATCH" }, eval_count: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const running = commands.autonoxis.handler(`run ${contractPath} ${sha256(contractText)}`, ctx);
    await requested;
    await commands.autonoxis.handler("status", ctx);
    assert.ok(notices.some(value => /^DISPATCHED [0-9a-f-]+$/.test(value.message)), JSON.stringify(notices));
    assert.equal(notices.some(value => value.message === "STARTING"), false);
    hooks.session_shutdown({}, ctx);
    await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown_did_not_settle")), 500))]);
  } finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for("pi-autonoxis.observer.v1")]; }
  assert.ok(notices.some(value => value.message === "session_shutdown" && value.level === "error"), JSON.stringify(notices));
  for (const channel of [delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, delegation.SUBAGENT_DELEGATION_STARTED_EVENT, delegation.SUBAGENT_DELEGATION_UPDATE_EVENT]) assert.equal((handlers.get(channel) ?? []).length, 0, channel);
  assert.ok(entries.some(entry => entry.customType === "autonoxis-state" && entry.data.state === "INTERRUPTED_UNKNOWN"));
});

test("delegation timeout cancels the exact child and settles the run", { timeout: 10_000 }, async () => {
  const pluginRoot = path.resolve("."), runRoot = mkdtempSync(path.join(os.tmpdir(), "autonoxis-timeout-")), harness = path.join(pluginRoot, "test", "native-harness.mjs"), env = { ...process.env, PI_SUBAGENT_CHILD: "1", PI_SUBAGENTS_HERDR_BRIDGE: "0" };
  const identityResult = spawnSync(process.execPath, [harness, "print-agent-identity", "--run-root", runRoot], { env, encoding: "utf8" }); assert.equal(identityResult.status, 0, identityResult.stderr);
  const agent = JSON.parse(identityResult.stdout), task = "Return compact JSON only: {\"ok\":true}.", contract = { version: 2, authorityId: "timeout-test", expiresAt: new Date(Date.now() + 60_000).toISOString(), cwd: runRoot, model: "openai-codex/gpt-5.6-sol", agentDefinitionDigest: agent.definitionDigest, agentDefinitionProjectionVersion: 2, nodes: [{ id: "timeout", actor: "pi-autonoxis.sol-leaf", task, expectedJson: { ok: true }, timeoutMs: 20 }] }, contractText = JSON.stringify(contract), contractPath = path.join(runRoot, "contract.json"); writeFileSync(contractPath, contractText);
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), anchor = path.join(agentDir, "npm", "package.json"), { entry: piEntry } = resolvePinnedPiEntry(), jiti = createRequire(anchor)("jiti")(anchor, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": piEntry } }), pluginModule = await jiti.import(path.join(pluginRoot, "index.ts")), delegation = await jiti.import("pi-subagents/delegation");
  const commands = {}, handlers = new Map(), notices = [], entries = [], requests = [], cancellations = [], sessionId = "timeout-parent", availableModels = [{ provider: "openai-codex", id: "gpt-5.6-sol" }];
  const events = { on(name, handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); return () => handlers.set(name, (handlers.get(name) ?? []).filter(value => value !== handler)); }, emit(name, value) { for (const handler of [...(handlers.get(name) ?? [])]) handler(value); if (name === delegation.SUBAGENT_DELEGATION_REQUEST_EVENT) { requests.push(value); for (const handler of [...(handlers.get(delegation.SUBAGENT_DELEGATION_STARTED_EVENT) ?? [])]) handler({ requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId }); } if (name === delegation.SUBAGENT_DELEGATION_CANCEL_EVENT) cancellations.push(value); } };
  const pi = { registerCommand: (name, command) => { commands[name] = command; }, on: () => {}, events, appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) }; pluginModule.default(pi);
  globalThis[Symbol.for("pi-autonoxis.observer.v1")] = { providerRequests: { before: 0, after: 0 } };
  const ctx = { cwd: runRoot, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries }, modelRegistry: { getAvailable: () => availableModels }, ui: { notify: (message, level) => notices.push({ message, level }) } }, originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ message: { content: "DECISION: DISPATCH" }, eval_count: 1 }), { status: 200, headers: { "content-type": "application/json" } });
  try { await Promise.race([commands.autonoxis.handler(`run ${contractPath} ${sha256(contractText)}`, ctx), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout_did_not_settle")), 500))]); }
  finally { globalThis.fetch = originalFetch; delete globalThis[Symbol.for("pi-autonoxis.observer.v1")]; }
  assert.ok(notices.some(value => value.message === "delegation_timeout" && value.level === "error"), JSON.stringify(notices)); assert.equal(requests.length, 1); assert.equal(cancellations.length, 1); assert.deepEqual(cancellations[0], { requestId: requests[0].requestId, ownerRunId: requests[0].ownerRunId, nodeId: requests[0].nodeId }); assert.ok(entries.some(entry => entry.customType === "autonoxis-state" && entry.data.state === "INTERRUPTED_UNKNOWN"));
  for (const channel of [delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, delegation.SUBAGENT_DELEGATION_STARTED_EVENT, delegation.SUBAGENT_DELEGATION_UPDATE_EVENT]) assert.equal((handlers.get(channel) ?? []).length, 0, channel);
});
