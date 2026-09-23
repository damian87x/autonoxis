import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import path from "node:path";

const MAX_NODES = 16;
const MAX_TERMINALS = 256;
export const SOL_ACTOR = "pi-autonoxis.sol-leaf";
export const SOL_BASE_MODEL = "openai-codex/gpt-5.6-sol";
export const SOL_RESOLVED_MODEL = "openai-codex/gpt-5.6-sol:off";
export function isApprovedSolIdentity(requestedModel, resolvedModel, thinking) {
  return requestedModel === SOL_BASE_MODEL && resolvedModel === SOL_RESOLVED_MODEL && (thinking === undefined || thinking === "off");
}
export function summarizeSessionEntries(entries) {
  return Array.isArray(entries) ? entries.map(entry => {
    if (entry?.type !== "message") return { type: entry?.type };
    const summary = { type: "message", role: entry.message?.role };
    if (entry.message?.role === "assistant") for (const key of ["provider", "model", "responseModel", "providerThinkingLevel"]) if (typeof entry.message[key] === "string") summary[key] = entry.message[key];
    return summary;
  }) : [];
}
export function isObservedSolAssistant(value) {
  return value?.provider === "openai-codex" && value?.model === "gpt-5.6-sol" && (value.responseModel === undefined || value.responseModel === "gpt-5.6-sol") && (value.providerThinkingLevel === undefined || value.providerThinkingLevel === "off");
}
export function isFreshChildStartupSummary(summary) {
  if (!Array.isArray(summary) || summary.length === 0) return false;
  const startup = new Set();
  for (const entry of summary) {
    if (!entry || !["model_change", "thinking_level_change", "session_info"].includes(entry.type) || startup.has(entry.type) || Object.hasOwn(entry, "role")) return false;
    startup.add(entry.type);
  }
  return true;
}
export function isFreshChildPostTurnSummary(summary) {
  if (!Array.isArray(summary) || summary.length < 3) return false;
  const messages = summary.slice(-2);
  return messages[0]?.type === "message" && messages[0]?.role === "user" && messages[1]?.type === "message" && messages[1]?.role === "assistant" && isObservedSolAssistant(messages[1]) && isFreshChildStartupSummary(summary.slice(0, -2));
}
export function isFreshChildObserverSnapshot(snapshot) {
  const startup = snapshot?.startupEntrySummary, postTurn = snapshot?.postTurnEntrySummary;
  return snapshot?.postTurnCaptureCount === 1 && isFreshChildStartupSummary(startup) && isFreshChildPostTurnSummary(postTurn) && startup.length < postTurn.length && startup.every((entry, index) => JSON.stringify(entry) === JSON.stringify(postTurn[index]));
}
const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const hash = value => createHash("sha256").update(value).digest("hex");
export function sha256(text) { return hash(text); }
export function delegationIdentity(value) {
  if (![value?.requestId, value?.ownerRunId, value?.nodeId].every(item => typeof item === "string" && item.length > 0)) fail("delegation_identity_invalid");
  return { requestId: value.requestId, ownerRunId: value.ownerRunId, nodeId: value.nodeId };
}
export function buildDelegationRequest(identity, request) {
  return { ...delegationIdentity(identity), ...request };
}
export function runIfAuthorized(controller, action) {
  controller.assertAuthority();
  return action();
}
export function emitIfAuthorized(controller, emit) {
  return runIfAuthorized(controller, emit);
}
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  const aKeys = Object.keys(a).sort(), bKeys = Object.keys(b).sort();
  return aKeys.length === bKeys.length && aKeys.every((key, index) => key === bKeys[index] && deepEqual(a[key], b[key]));
}

function fail(code) { throw new Error(code); }
function strictObject(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("contract_schema_invalid");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("contract_unknown_field");
}
function validJson(value, depth = 0) {
  if (depth > 16) return false;
  if (typeof value === "string") return !/[\u0000-\u001f\u007f]/.test(value);
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every(item => validJson(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.keys(value).every(key => !["__proto__", "prototype", "constructor"].includes(key) && !/[\u0000-\u001f\u007f]/.test(key) && validJson(value[key], depth + 1));
}

export function validateContract(contract) {
  strictObject(contract, new Set(["version", "authorityId", "expiresAt", "cwd", "model", "nodes", "agentDefinitionDigest", "agentDefinitionProjectionVersion"]));
  if (contract.version !== 2 || !safeId.test(contract.authorityId) || typeof contract.expiresAt !== "string" || typeof contract.cwd !== "string" || contract.model !== SOL_BASE_MODEL || !/^[a-f0-9]{64}$/.test(contract.agentDefinitionDigest) || contract.agentDefinitionProjectionVersion !== 2 || !Array.isArray(contract.nodes) || contract.nodes.length < 1 || contract.nodes.length > MAX_NODES) fail("contract_schema_invalid");
  const ids = new Set();
  const expiresAt = Date.parse(contract.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt - Date.now() > 15 * 60_000) fail("contract_cwd_or_expiry_invalid");
  for (const node of contract.nodes) {
    strictObject(node, new Set(["id", "actor", "task", "expectedJson", "timeoutMs"]));
    if (!safeId.test(node.id) || ids.has(node.id) || node.actor !== SOL_ACTOR || typeof node.task !== "string" || /[\u0000-\u001f\u007f]/.test(node.task) || Buffer.byteLength(node.task) > 8192 || !validJson(node.expectedJson) || !Number.isSafeInteger(node.timeoutMs) || node.timeoutMs < 1 || node.timeoutMs > 120000) fail("contract_schema_invalid");
    ids.add(node.id);
  }
  return Object.freeze(structuredClone(contract));
}

export function loadContract(contractPath, expectedHash, cwd) {
  const root = realpathSync(cwd);
  const resolved = path.resolve(root, contractPath);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("contract_path_outside_cwd");
  let walked = root;
  for (const segment of relative.split(path.sep)) {
    walked = path.join(walked, segment);
    if (lstatSync(walked).isSymbolicLink()) fail("contract_file_invalid");
  }
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.size > 65536) fail("contract_file_invalid");
  const bytes = readFileSync(resolved);
  const after = lstatSync(resolved);
  if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) fail("contract_file_changed");
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash) fail("contract_hash_mismatch");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("contract_utf8_invalid"); }
  const contract = validateContract(JSON.parse(text));
  if (realpathSync(contract.cwd) !== root) fail("contract_cwd_or_expiry_invalid");
  return { contract, hash: expectedHash, path: resolved };
}

export function validateWorkerJson(text, expected) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 16384) return { ok: false, reason: "output_size" };
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: "output_json" }; }
  if (!validJson(value) || !deepEqual(value, expected)) return { ok: false, reason: "output_mismatch" };
  if (text.trim() !== JSON.stringify(expected)) return { ok: false, reason: "output_format", format_canonical: false };
  return { ok: true, value, format_canonical: true };
}

export class RunController {
  constructor({ loaded, sessionId, now = () => Date.now(), monotonic = () => performance.now() }) {
    this.loaded = loaded; this.sessionId = sessionId; this.now = now; this.monotonic = monotonic; this.generation = randomUUID();
    this.startedWall = now(); this.startedMonotonic = monotonic(); this.epoch = 0; this.state = "READY"; this.terminals = new Set(); this.current = undefined; this.authorityRevoked = false;
  }
  assertAuthority() {
    const wallElapsed = this.now() - this.startedWall;
    const monotonicElapsed = this.monotonic() - this.startedMonotonic;
    if (wallElapsed + 1_000 < monotonicElapsed) fail("clock_rollback_detected");
    if (this.authorityRevoked || this.now() >= Date.parse(this.loaded.contract.expiresAt)) fail("authority_expired");
    if (sha256(readFileSync(this.loaded.path)) !== this.loaded.hash) fail("contract_drift");
  }
  begin(node) {
    this.assertAuthority();
    if (this.current || this.terminals.size >= MAX_TERMINALS) fail(this.current ? "run_busy" : "terminal_capacity_exhausted");
    this.current = { requestId: randomUUID(), ownerRunId: this.generation, nodeId: node.id, actor: node.actor, epoch: this.epoch };
    this.state = "POLICY_PENDING"; return this.current;
  }
  admit(decision) {
    this.assertAuthority();
    if (!this.current) fail("policy_not_authorized");
    if (this.state !== "POLICY_PENDING" || decision !== "DISPATCH") fail("policy_not_authorized");
    this.state = "AUTHORIZED"; return this.current;
  }
  markDispatched() {
    if (!this.current || this.state !== "AUTHORIZED") fail("dispatch_state_invalid");
    this.assertAuthority(); this.state = "DISPATCHED"; return this.current;
  }
  terminal(response, expected, digest, model) {
    const active = this.current;
    const invalid = response?.status === "invalid_request" && response.requestId === active?.requestId &&
      (response.ownerRunId === undefined || response.ownerRunId === active.ownerRunId) &&
      (response.nodeId === undefined || response.nodeId === active.nodeId);
    if (!active || (!invalid && (response.requestId !== active.requestId || response.ownerRunId !== active.ownerRunId || response.nodeId !== active.nodeId)) || active.epoch !== this.epoch || this.terminals.has(response.requestId)) return { ignored: true };
    this.terminals.add(response.requestId);
    let authorityCurrent = true;
    try { this.assertAuthority(); } catch { authorityCurrent = false; }
    const checked = authorityCurrent && this.state === "DISPATCHED" && response.status === "completed" && isApprovedSolIdentity(model, response.model, response.thinking) && response.launchContractDigest === digest && response.result?.kind === "text" ? validateWorkerJson(response.result.text, expected) : { ok: false, reason: authorityCurrent ? "terminal_evidence_invalid" : "authority_expired" };
    this.current = undefined; this.state = checked.ok ? "EVIDENCE_READY" : this.authorityRevoked ? "CANCELLED" : "ASK";
    return { ignored: false, ...checked };
  }
  stop() {
    this.authorityRevoked = true;
    const dispatched = this.current && this.state === "DISPATCHED";
    const identity = dispatched ? { requestId: this.current.requestId, ownerRunId: this.current.ownerRunId, nodeId: this.current.nodeId } : undefined;
    if (!dispatched) this.current = undefined;
    this.state = dispatched ? "CANCEL_PENDING" : "CANCELLED";
    return identity;
  }
  interruptUnknown() { this.current = undefined; this.epoch++; this.state = "INTERRUPTED_UNKNOWN"; }
}
