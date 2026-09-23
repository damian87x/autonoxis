import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite"];
const hash = value => createHash("sha256").update(value).digest("hex");

export function validatePilotFixture(fixture) {
  if (!fixture?.pilot || !Array.isArray(fixture.nodes) || fixture.nodes.length !== 1) throw new Error("pilot_requires_exactly_one_node");
  if (fixture.pilot.baselineInstruction !== fixture.nodes[0].task) throw new Error("pilot_baseline_schema_mismatch");
  if (fixture.pilot.maxPremiumAttempts !== 8 || fixture.pilot.maxMinutes !== 15 || fixture.pilot.admissionTokens !== 32_000 || fixture.model !== "openai-codex/gpt-5.6-sol") throw new Error("pilot_fixture_limits_invalid");
  return fixture;
}

const validCounter = value => Number.isSafeInteger(value) && value >= 0;

export function countersEqual(before, after) {
  return validCounter(before?.before) && validCounter(before?.after) && validCounter(after?.before) && validCounter(after?.after) && before.before === after.before && before.after === after.after;
}

export function providerCountersValid(value, expectedBefore) {
  return validCounter(value?.before) && value.before === expectedBefore && validCounter(value?.after) && value.after <= value.before;
}

export function buildBaselineChildRow({ arm, terminal, outputHash, formatCanonical, observer, observerPath, observerHash, preflight, requestId, ownerRunId, nodeId }) {
  return { arm, phase: "child", model: terminal?.model, thinking: terminal?.thinking, status: terminal?.status, usage: terminal?.usage ?? null, usageMissing: terminal?.usage == null, outputHash, formatCanonical, launchContractDigest: terminal?.launchContractDigest, observer, observerRegistration: { id: "autonoxis-observer", path: observerPath, hash: observerHash }, preflight, agent: preflight?.agent, requestId, ownerRunId, nodeId };
}

export function buildAssistedChildRow({ terminalEntry, transport, contractHash, node, hashText }) {
  const terminalData = terminalEntry?.data;
  const request = transport.requests.length === 1 ? transport.requests[0] : undefined;
  const matching = request ? transport.terminals.filter(value => value?.requestId === request.requestId && value?.ownerRunId === request.ownerRunId && value?.nodeId === request.nodeId) : [];
  const transportTerminal = matching.length === 1 ? matching[0] : undefined;
  const rawTerminal = terminalData ?? transportTerminal;
  const identityMatch = !!terminalData && !!request && !!transportTerminal && ["requestId", "ownerRunId", "nodeId"].every(key => typeof terminalData[key] === "string" && terminalData[key].length > 0 && terminalData[key] === request[key] && terminalData[key] === transportTerminal[key]);
  return { request, matching, transportTerminal, identityMatch, row: { arm: "assisted", phase: "child", model: rawTerminal?.model, thinking: rawTerminal?.thinking, status: rawTerminal?.status, usage: rawTerminal?.usage ?? null, usageMissing: rawTerminal?.usage == null, outputHash: rawTerminal?.outputHash ?? (typeof rawTerminal?.result?.text === "string" ? hashText?.(rawTerminal.result.text) : undefined), formatCanonical: terminalData?.formatCanonical, launchContractDigest: rawTerminal?.launchContractDigest, observer: terminalData?.observer, observerRegistration: terminalData?.observerRegistration, preflight: terminalData?.preflight, agent: terminalData?.agent, localPolicy: node?.data?.localPolicy, requestId: rawTerminal?.requestId, ownerRunId: rawTerminal?.ownerRunId, nodeId: rawTerminal?.nodeId, contractHash, transportRequestCount: transport.requests.length, transportTerminalCount: matching.length, transportTerminal: !!transportTerminal, autonoxisTerminal: !!terminalEntry } };
}

export async function persistIssuesBeforeForward(accounting, records, forward, onIssued) {
  const attempts = [];
  for (const record of records) attempts.push(await accounting.issue(record));
  await onIssued?.(attempts);
  return { attempts, result: await forward(attempts) };
}

export async function persistTerminalBeforeAcceptance(accounting, attempt, record, accept) {
  await accounting.terminal(attempt, record);
  return await accept();
}

export function validUsage(value) {
  return !!value && USAGE_KEYS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
}

export function usageTotal(rows, limit = 32_000) {
  let total = 0;
  for (const row of rows) {
    if (!validUsage(row?.usage)) return null;
    for (const key of USAGE_KEYS) {
      const value = row.usage[key];
      if (value > limit || total > limit - value) return null;
      total += value;
    }
  }
  return total;
}

export class PilotAccounting {
  #records = [];
  #identities = new Set();
  #reserved = false;

  constructor({ evidencePath, limits, reservePaths = [], fs = { lstat, mkdir, writeFile }, now = () => new Date().toISOString() }) {
    if (!evidencePath || typeof evidencePath !== "string" || !Array.isArray(reservePaths)) throw new Error("pilot_evidence_path_required");
    this.evidencePath = path.resolve(evidencePath);
    this.reservePaths = reservePaths.map(value => path.resolve(value));
    this.attemptDir = path.join(path.dirname(this.evidencePath), "attempts");
    this.limits = limits;
    this.fs = fs;
    this.now = now;
  }

  async reserve() {
    if (this.#reserved) throw new Error("pilot_evidence_already_reserved");
    for (const candidate of [this.evidencePath, ...this.reservePaths]) {
      try { await this.fs.lstat(candidate); throw new Error("pilot_evidence_collision"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await this.fs.mkdir(this.attemptDir);
    this.reservation = await this.#writeReservation();
    this.#reserved = true;
  }

  async #writeReservation() {
    const file = `${this.evidencePath}.reservation.json`;
    const body = { kind: "pilot-evidence-reservation", timestamp: this.now(), evidencePath: this.evidencePath };
    const bytes = `${JSON.stringify(body, null, 2)}\n`;
    await this.fs.writeFile(file, bytes, { flag: "wx" });
    return { path: file, sha256: hash(bytes) };
  }

  async #write(sequence, kind, record) {
    if (!this.#reserved) throw new Error("pilot_evidence_not_reserved");
    const file = path.join(this.attemptDir, `${String(sequence).padStart(3, "0")}-${kind}.json`);
    const body = { ...record, sequence, kind, timestamp: this.now() };
    const bytes = `${JSON.stringify(body, null, 2)}\n`;
    await this.fs.writeFile(file, bytes, { flag: "wx" });
    return { path: file, sha256: hash(bytes) };
  }

  async issue(record) {
    const identity = [record?.requestId, record?.ownerRunId, record?.nodeId].every(value => typeof value === "string") ? `${record.requestId}:${record.ownerRunId}:${record.nodeId}` : undefined;
    if (identity && this.#identities.has(identity)) throw new Error("pilot_attempt_identity_duplicate");
    const sequence = this.#records.length + 1;
    const issued = await this.#write(sequence, "issued", record);
    if (identity) this.#identities.add(identity);
    const state = { sequence, issued, terminal: undefined, outcome: undefined, record };
    this.#records.push(state);
    return state;
  }

  async terminal(state, record) {
    if (!state || !this.#records.includes(state) || state.terminal) throw new Error("pilot_terminal_identity_invalid");
    state.terminal = await this.#write(state.sequence, "terminal", { ...record, arm: state.record.arm, phase: state.record.phase, premium: state.record.premium !== false });
    state.terminalRecord = record;
    return state.terminal;
  }

  async outcome(state, record) {
    if (!state || !this.#records.includes(state) || state.outcome) throw new Error("pilot_outcome_identity_invalid");
    state.outcome = await this.#write(state.sequence, "outcome", { ...record, arm: state.record.arm, phase: state.record.phase, premium: state.record.premium !== false, requestId: state.terminalRecord?.requestId, ownerRunId: state.terminalRecord?.ownerRunId, nodeId: state.terminalRecord?.nodeId });
    state.outcomeRecord = record;
    return state.outcome;
  }

  get artifacts() {
    return this.#records.map(({ sequence, issued, terminal, outcome, record }) => ({ sequence, premium: record.premium !== false, issued, terminal, outcome }));
  }

  get terminals() { return this.#records.map(state => state.terminalRecord).filter(Boolean); }

  assertAdmissible({ forNextRequest = false, elapsedMs = 0 } = {}) {
    const premium = this.#records.filter(state => state.record.premium !== false);
    const rows = premium.map(state => state.terminalRecord).filter(Boolean);
    if (premium.some(state => !state.terminal || !validUsage(state.terminalRecord?.usage))) throw new Error("pilot_usage_incomplete");
    const total = usageTotal(rows, this.limits.admissionTokens);
    if (total === null || elapsedMs > this.limits.maxMinutes * 60_000 || premium.length > this.limits.maxPremiumAttempts || (forNextRequest && (premium.length >= this.limits.maxPremiumAttempts || total >= this.limits.admissionTokens))) throw new Error("pilot_admission_limit_reached");
    return total;
  }

  assertResolved() {
    if (this.#records.some(state => !state.terminal || !state.outcome)) throw new Error("pilot_attempt_unresolved");
  }
}
