import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { buildDelegationRequest, delegationIdentity, emitIfAuthorized, isFreshChildObserverSnapshot, loadContract, RunController, runIfAuthorized, sha256, SOL_ACTOR } from "./controller.mjs";
import { checkPreflight } from "./preflight-assert.mjs";
import { requestPolicy } from "./policy.mjs";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const OBSERVER = path.join(PLUGIN_DIR, "test", "observer.ts");
const OBSERVER_ID = "autonoxis-observer";
const OBSERVER_KEY = Symbol.for("pi-autonoxis.observer.v1");
const GRACE_MS = 5_000;
const SOL = "openai-codex/gpt-5.6-sol";
const MODULES = ["delegation", "preflight", "required-child-extensions", "capability-ceiling", "shared-types"] as const;

type Subagents = Record<(typeof MODULES)[number], Record<string, any>>;
type Cancellation = { requestId: string; ownerRunId: string; nodeId: string };
type ProviderRequests = { before: number; after: number };
type EntrySummary = { type: string; role?: string; provider?: string; model?: string; responseModel?: string; providerThinkingLevel?: string };
type ObserverSnapshot = { sessionId: string; tools: string[]; cwd: string; startupEntrySummary: EntrySummary[]; postTurnEntrySummary?: EntrySummary[]; postTurnCaptureCount: number; bridgeActive: boolean; observerId: string; observerHash: string };
type ObserverCollector = { parentSessionId: string; observerId: string; observerHash: string; snapshots: ObserverSnapshot[]; providerRequests: ProviderRequests };
type ActiveRun = { controller: RunController; disposers: Array<{ dispose(): void }>; policyAbort?: AbortController; cancel?: (identity: Cancellation, waitForAck?: boolean) => void; abortPending?: (reason: string) => void; clearCancelTimer?: () => void; shutdown: boolean; signalShutdown: () => void; shutdownPromise: Promise<void>; dispose: () => void };

async function loadPublicSubagents(): Promise<Subagents> {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const anchor = path.join(agentDir, "npm", "package.json");
  if (!fs.existsSync(anchor)) throw new Error("agent_npm_anchor_missing");
  const resolve = createRequire(anchor).resolve;
  const loaded = await Promise.all(MODULES.map(async (name) => [name, await import(pathToFileURL(resolve(`pi-subagents/${name}`)).href)] as const));
  return Object.fromEntries(loaded) as Subagents;
}

function parsedRunArgs(args: string) {
  const parts = args.trim().split(/\s+/);
  if (parts.length !== 3 || parts[0] !== "run") throw new Error("usage: /autonoxis run <contract-path> <sha256>");
  return { path: parts[1], hash: parts[2] };
}
function commandArgs(args: string, verb: string) {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  if (parts[0] !== verb || parts.length > 2) throw new Error(`usage: /autonoxis ${verb} [run-id]`);
  return parts[1];
}
function notify(ctx: any, message: string, level: "info" | "error" = "info") { ctx.ui.notify(message, level); }
function sameRun(active: ActiveRun | undefined, runId: string | undefined) {
  if (!runId || active?.controller.generation === runId) return;
  throw new Error("run_id_not_owned");
}
function copyCounters(counter: ProviderRequests) { return { before: counter.before, after: counter.after }; }
function delay(ms: number) { return new Promise(resolve => setTimeout(resolve, ms)); }
function reserveAuthority(cwd: string, contractHash: string) {
  const piDir = path.join(cwd, ".pi"), markerDir = path.join(piDir, "autonoxis-authorities");
  if (fs.existsSync(piDir)) { if (fs.lstatSync(piDir).isSymbolicLink() || fs.realpathSync(piDir) !== path.resolve(piDir)) throw new Error("authority_marker_path_invalid"); }
  else fs.mkdirSync(piDir, { mode: 0o700 });
  if (fs.existsSync(markerDir)) { if (fs.lstatSync(markerDir).isSymbolicLink() || fs.realpathSync(markerDir) !== path.resolve(markerDir)) throw new Error("authority_marker_path_invalid"); }
  else fs.mkdirSync(markerDir, { mode: 0o700 });
  const marker = path.join(markerDir, contractHash);
  try { fs.writeFileSync(marker, `${JSON.stringify({ version: 1, contractHash })}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error: any) { if (error?.code === "EEXIST") throw new Error("authority_already_used"); throw error; }
  return marker;
}

export default function autonoxis(pi: any) {
  let active: ActiveRun | undefined;
  let starting = false;
  let startupRevoked = false;
  let sessionRunUsed = false;

  async function run(args: string, ctx: any) {
    if (active || starting || sessionRunUsed) throw new Error("run_busy");
    starting = true;
    startupRevoked = false;
    const registrations: Array<{ dispose(): void }> = [];
    let disposed = false;
    let controller: RunController | undefined;
    let collector: ObserverCollector | undefined;
    let providerAtRunStart: ProviderRequests | undefined;
    let runActive: ActiveRun | undefined;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      runActive?.clearCancelTimer?.();
      for (const registration of [...registrations].reverse()) registration.dispose();
    };
    try {
      const parsed = parsedRunArgs(args);
      const loaded = loadContract(parsed.path, parsed.hash, ctx.cwd);
      if (loaded.contract.model !== SOL) throw new Error("model_not_approved");
      if (VERSION !== "0.85.1") throw new Error("pi_version_mismatch");
      if (fs.existsSync(path.join(ctx.cwd, ".pi", "npm", "node_modules", "pi-subagents", "package.json"))) throw new Error("project_pi_subagents_not_supported");
      const authorityMarker = reserveAuthority(loaded.contract.cwd, loaded.hash);
      const api = await loadPublicSubagents(); // After bindExtensions: this executes only from a command.
      if (startupRevoked) throw new Error("authority_revoked_during_startup");
      const sessionId = ctx.sessionManager.getSessionId();
      const foreign = api["capability-ceiling"].resolveCurrentSubagentCapabilityCeiling(sessionId);
      if (foreign?.denyExtensions === true) throw new Error("foreign_ceiling_denies_extensions");
      if (!fs.existsSync(OBSERVER) || !fs.statSync(OBSERVER).isFile()) throw new Error("observer_path_invalid");
      const observerPath = fs.realpathSync(OBSERVER);
      const observerHash = sha256(fs.readFileSync(observerPath, "utf8"));
      const priorCollector = (globalThis as any)[OBSERVER_KEY] as Partial<ObserverCollector> | undefined;
      // A disposable harness can own this counter object; preserve that explicit reference through grace.
      const providerRequests = priorCollector?.providerRequests ?? { before: 0, after: 0 };
      collector = { parentSessionId: sessionId, observerId: OBSERVER_ID, observerHash, snapshots: [], providerRequests };
      providerAtRunStart = copyCounters(providerRequests);
      (globalThis as any)[OBSERVER_KEY] = collector;
      try {
        registrations.push(api["required-child-extensions"].registerRequiredChildExtensions({ sessionId, extensions: [{ id: OBSERVER_ID, path: observerPath }] }));
      } catch (error) {
        if (String(error).includes("Required child extensions are already registered")) throw new Error("observer_slot_occupied");
        throw error;
      }
      controller = new RunController({ loaded, sessionId });
      registrations.push(api["capability-ceiling"].registerSubagentCapabilityCeiling({ sessionId, source: "pi-autonoxis", ceiling: { allowedTools: [], allowedAgents: [SOL_ACTOR] } }));
      let signalShutdown!: () => void;
      const shutdownPromise = new Promise<void>(resolve => { signalShutdown = resolve; });
      runActive = { controller, disposers: registrations, dispose, shutdown: false, signalShutdown, shutdownPromise };
      active = runActive;
      sessionRunUsed = true;
      pi.appendEntry("autonoxis-state", { state: "STARTED", contractHash: loaded.hash, generation: controller.generation, authorityMarker });
      if (startupRevoked) { controller.stop(); throw new Error("authority_revoked_during_startup"); }
      const policy = async (input: { promptPath: string; packet: string; manager?: boolean }) => runIfAuthorized(controller!, async () => {
        const abort = new AbortController();
        runActive!.policyAbort = abort;
        try { return await requestPolicy({ ...input, signal: abort.signal }); }
        finally { if (runActive?.policyAbort === abort) runActive.policyAbort = undefined; }
      });
      const consumedChildSessions = new Set<string>();
      for (const node of loaded.contract.nodes) {
        const actor = SOL_ACTOR;
        const current = controller.begin({ id: node.id, actor });
        const availableModels = ctx.modelRegistry.getAvailable();
        const preflightInput = { agent: actor, task: node.task, cwd: loaded.contract.cwd, context: "fresh", model: SOL, thinking: "off", skill: false, artifacts: false, parentSessionId: sessionId, sessionDir: path.join(loaded.contract.cwd, ".pi", "autonoxis-preflight"), availableModels, capabilityCeiling: api["capability-ceiling"].resolveCurrentSubagentCapabilityCeiling(sessionId), intercomBridge: { mode: "off" } };
        const first = await api.preflight.resolveSubagentLaunchContract(preflightInput);
        const preflightEvidence = checkPreflight(first, observerPath, loaded.contract.agentDefinitionDigest);
        const policyResult = await policy({ promptPath: path.join(PLUGIN_DIR, "prompts", "conductor-system-v4.txt"), packet: `Human authority ${loaded.contract.authorityId} is current for contract ${loaded.hash}. Node ${node.id} is a finite, tools-free task assigned to ${node.actor}; its exact task contract, model, capability ceiling, and preflight evidence are current. Choose the next externally visible action.` });
        controller.admit(policyResult.decision);
        const second = await api.preflight.resolveSubagentLaunchContract(preflightInput);
        const secondEvidence = checkPreflight(second, observerPath, loaded.contract.agentDefinitionDigest);
        if (secondEvidence.launchContractDigest !== preflightEvidence.launchContractDigest || secondEvidence.resolvedModel !== preflightEvidence.resolvedModel || secondEvidence.thinking !== preflightEvidence.thinking || secondEvidence.agent.definitionDigest !== preflightEvidence.agent.definitionDigest) throw new Error("preflight_drift");
        controller.assertAuthority();
        const snapshotCount = collector.snapshots.length;
        const terminal = await new Promise<any>((resolve, reject) => {
          let settled = false;
          let cancelTimer: ReturnType<typeof setTimeout> | undefined;
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          let started = false;
          let updates = 0;
          const matches = (value: any) => value?.requestId === current.requestId && value?.ownerRunId === current.ownerRunId && value?.nodeId === current.nodeId;
          const close = () => {
            if (cancelTimer) clearTimeout(cancelTimer);
            if (watchdog) clearTimeout(watchdog);
            offResponse(); offStarted(); offUpdate();
            if (runActive?.abortPending === abortPending) runActive.abortPending = undefined;
            if (runActive?.cancel === cancel) runActive.cancel = undefined;
            if (runActive?.clearCancelTimer === clearCancelTimer) runActive.clearCancelTimer = undefined;
          };
          const failPending = (reason: string) => {
            if (settled) return;
            settled = true; close(); controller!.interruptUnknown(); reject(new Error(reason));
          };
          const abortPending = (reason: string) => failPending(reason);
          const clearCancelTimer = () => { if (cancelTimer) clearTimeout(cancelTimer); cancelTimer = undefined; };
          const cancel = (cancelled: Cancellation, waitForAck = true) => {
            pi.events.emit(api.delegation.SUBAGENT_DELEGATION_CANCEL_EVENT, cancelled);
            if (!waitForAck) return;
            clearCancelTimer();
            cancelTimer = setTimeout(() => {
              if (settled) return;
              pi.appendEntry("autonoxis-state", { state: "INTERRUPTED_UNKNOWN", generation: controller!.generation, providerRequests: copyCounters(collector!.providerRequests) });
              failPending("cancellation_ack_timeout");
            }, 5_000);
          };
          const offResponse = pi.events.on(api.delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, (response: any) => {
            if (!matches(response)) return;
            settled = true; close(); resolve({ response, started, updates });
          });
          const offStarted = pi.events.on(api.delegation.SUBAGENT_DELEGATION_STARTED_EVENT, (event: any) => { if (matches(event)) started = true; });
          const offUpdate = pi.events.on(api.delegation.SUBAGENT_DELEGATION_UPDATE_EVENT, (event: any) => { if (matches(event)) updates++; });
          runActive!.abortPending = abortPending;
          runActive!.clearCancelTimer = clearCancelTimer;
          runActive!.cancel = cancel;
          const remaining = Math.min(node.timeoutMs, Date.parse(loaded.contract.expiresAt) - Date.now());
          watchdog = setTimeout(() => {
            const cancellation = controller!.stop();
            if (cancellation) cancel(cancellation, false);
            failPending("delegation_timeout");
          }, Math.max(1, remaining));
          try {
            emitIfAuthorized(controller!, () => {
              controller!.markDispatched();
              pi.events.emit(api.delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, buildDelegationRequest(current, { agent: actor, task: node.task, context: "fresh", cwd: loaded.contract.cwd, model: SOL, thinking: "off", timeoutMs: node.timeoutMs, toolBudget: { hard: 0, block: "*" }, skill: false, artifacts: false, intercomBridge: { mode: "off" }, result: { kind: "text" } }));
            });
            if (!started && !settled) failPending("delegation_bridge_absent");
          } catch (error) { if (!settled) { const cancellation = controller!.stop(); if (cancellation) cancel(cancellation, false); settled = true; close(); reject(error); } }
        });
        const observerSnapshot = collector.snapshots.length === snapshotCount + 1 ? collector.snapshots[snapshotCount] : undefined;
        const evidence = controller.terminal(terminal.response, node.expectedJson, preflightEvidence.launchContractDigest, SOL);
        const observed = observerSnapshot && observerSnapshot.sessionId !== sessionId && !consumedChildSessions.has(observerSnapshot.sessionId) && observerSnapshot.cwd === loaded.contract.cwd && isFreshChildObserverSnapshot(observerSnapshot) && !observerSnapshot.bridgeActive && observerSnapshot.tools.length === 0 && observerSnapshot.observerId === OBSERVER_ID && observerSnapshot.observerHash === observerHash;
        const output = typeof terminal.response?.result?.text === "string" ? sha256(terminal.response.result.text) : undefined;
        const terminalRecord = { authorityId: loaded.contract.authorityId, contractHash: loaded.hash, generation: controller.generation, ...delegationIdentity(current), launchContractDigest: preflightEvidence.launchContractDigest, outputHash: output, model: terminal.response?.model, thinking: terminal.response?.thinking, status: terminal.response?.status, usage: terminal.response?.usage, formatCanonical: evidence.format_canonical, agent: preflightEvidence.agent, observer: observerSnapshot, observerRegistration: { id: OBSERVER_ID, path: observerPath, hash: observerHash }, preflight: preflightEvidence, delegation: { started: terminal.started, updates: terminal.updates }, providerRequests: copyCounters(collector.providerRequests) };
        if (!evidence.ok || controller.state !== "EVIDENCE_READY" || !observed) {
          const reason = evidence.reason || "child_observer_rejected";
          pi.appendEntry("autonoxis-terminal-rejected", { ...terminalRecord, reason });
          throw new Error(reason);
        }
        pi.appendEntry("autonoxis-terminal", terminalRecord);
        consumedChildSessions.add(observerSnapshot.sessionId);
        const manager = await policy({ promptPath: path.join(PLUGIN_DIR, "prompts", "manager-system-v4.txt"), manager: true, packet: `Human authority ${loaded.contract.authorityId} is current for contract ${loaded.hash}. Node ${node.id} completed with the required model and exact deterministic JSON evidence (output hash ${output}, launch digest ${preflightEvidence.launchContractDigest}); no failed or stale evidence is present. Choose the next externally visible action.` });
        controller.assertAuthority();
        if (manager.decision !== "ACCEPT") throw new Error("manager_not_accepted");
        pi.appendEntry("autonoxis-node", { ...terminalRecord, localPolicy: { conductor: policyResult, manager } });
      }
      controller.state = "COMPLETED";
      pi.appendEntry("autonoxis-state", { state: "COMPLETED", contractHash: loaded.hash, generation: controller.generation, providerRequests: copyCounters(collector.providerRequests) });
      notify(ctx, "Autonoxis completed the authorized run.");
    } finally {
      runActive?.policyAbort?.abort();
      const finalState = controller?.state === "INTERRUPTED_UNKNOWN" ? "INTERRUPTED_UNKNOWN" : controller?.authorityRevoked ? "CANCELLED" : "FAILED";
      if (runActive?.controller.state !== "COMPLETED" && !runActive?.controller.authorityRevoked) runActive?.controller.stop();
      if (controller?.state !== "COMPLETED" && runActive && !runActive.shutdown) pi.appendEntry("autonoxis-state", { state: finalState, contractHash: controller?.loaded.hash, generation: controller?.generation, providerRequests: collector ? copyCounters(collector.providerRequests) : undefined });
      dispose();
      if (controller?.state === "COMPLETED" && collector && runActive && !runActive.shutdown && (globalThis as any)[OBSERVER_KEY] === collector) {
        await Promise.race([delay(GRACE_MS), runActive.shutdownPromise]);
        if (!runActive.shutdown) pi.appendEntry("autonoxis-state", { state: "COMPLETED", contractHash: controller.loaded.hash, generation: controller.generation, providerRequests: copyCounters(collector.providerRequests), noWake: { graceMs: GRACE_MS, providerRequests: { before: providerAtRunStart, after: copyCounters(collector.providerRequests) } } });
      }
      if ((globalThis as any)[OBSERVER_KEY] === collector) delete (globalThis as any)[OBSERVER_KEY];
      if (active === runActive) active = undefined;
      starting = false;
    }
  }

  pi.registerCommand("autonoxis", {
    description: "Human-authorized tools-free run/status/stop.",
    handler: async (args: string, ctx: any) => {
      try {
        const verb = args.trim().split(/\s+/, 1)[0];
        if (verb === "run") return await run(args, ctx);
        if (verb === "status") {
          const runId = commandArgs(args, "status");
          if (starting && !active) { if (runId) throw new Error("run_id_not_owned"); return notify(ctx, "STARTING"); }
          sameRun(active, runId);
          return notify(ctx, active ? `${active.controller.state} ${active.controller.generation}` : "No active Autonoxis run.");
        }
        if (verb === "stop") {
          const runId = commandArgs(args, "stop");
          if (starting && !active) { if (runId) throw new Error("run_id_not_owned"); startupRevoked = true; sessionRunUsed = true; return notify(ctx, "Autonoxis authority revoked; run starting."); }
          sameRun(active, runId);
          if (!active) return notify(ctx, "No active Autonoxis run.");
          if (active.controller.authorityRevoked) return notify(ctx, "Autonoxis authority is already revoked.");
          const cancellation = active.controller.stop();
          active.policyAbort?.abort();
          pi.appendEntry("autonoxis-state", { state: cancellation ? "CANCEL_PENDING" : "CANCELLED", generation: active.controller.generation });
          if (cancellation) active.cancel?.(cancellation);
          return notify(ctx, cancellation ? "Autonoxis authority revoked; cancellation requested." : "Autonoxis authority revoked; no child dispatch is pending.");
        }
        throw new Error("usage: /autonoxis run <contract-path> <sha256> | status [run-id] | stop [run-id]");
      } catch (error) { notify(ctx, error instanceof Error ? error.message : String(error), "error"); }
    },
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    const autonoxisEntries = ctx.sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && typeof entry.customType === "string" && entry.customType.startsWith("autonoxis-"));
    const states = autonoxisEntries.filter((entry: any) => entry.customType === "autonoxis-state");
    sessionRunUsed = autonoxisEntries.length > 0;
    const last = states.at(-1)?.data;
    if (last?.state && !["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED_UNKNOWN"].includes(last.state)) pi.appendEntry("autonoxis-state", { state: "INTERRUPTED_UNKNOWN", restoredFrom: last.state, generation: last.generation });
  });
  pi.on("session_shutdown", () => {
    if (starting && !active) { startupRevoked = true; sessionRunUsed = true; return; }
    if (!active) return;
    const closing = active;
    closing.shutdown = true; closing.signalShutdown();
    if (closing.controller.state === "COMPLETED") { closing.dispose(); active = undefined; return; }
    pi.appendEntry("autonoxis-state", { state: "INTERRUPTED_UNKNOWN", contractHash: closing.controller.loaded.hash, generation: closing.controller.generation });
    const cancellation = closing.controller.stop();
    closing.policyAbort?.abort();
    if (cancellation) closing.cancel?.(cancellation, false);
    closing.abortPending?.("session_shutdown");
    closing.dispose();
    active = undefined;
  });
}
