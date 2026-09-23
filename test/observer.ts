import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { summarizeSessionEntries } from "../controller.mjs";

const KEY = Symbol.for("pi-autonoxis.observer.v1");
const SELF_HASH = createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");

export function snapshotStartup(pi: any, ctx: any, collector: any) {
  return { sessionId: ctx.sessionManager.getSessionId(), tools: pi.getActiveTools().sort(), cwd: ctx.cwd, startupEntrySummary: summarizeSessionEntries(ctx.sessionManager.getEntries()), postTurnCaptureCount: 0, bridgeActive: ctx.getSystemPrompt().includes("Intercom"), observerId: collector.observerId, observerHash: SELF_HASH };
}

export function capturePostTurn(ctx: any, collector: any) {
  const sessionId = ctx.sessionManager.getSessionId();
  const matches = collector?.snapshots?.filter((snapshot: any) => snapshot?.sessionId === sessionId) ?? [];
  if (matches.length !== 1) return;
  const prior = matches[0];
  const updated = { ...prior, postTurnEntrySummary: summarizeSessionEntries(ctx.sessionManager.getEntries()), postTurnCaptureCount: prior.postTurnCaptureCount + 1 };
  collector.snapshots = collector.snapshots.map((snapshot: any) => snapshot === prior ? updated : snapshot);
}

export default function observer(pi: any) {
  pi.on("before_provider_request", (_event: any, ctx: any) => {
    const collector = (globalThis as any)[KEY];
    if (collector?.parentSessionId === ctx.sessionManager.getSessionId()) collector.providerRequests.before++;
  });
  pi.on("after_provider_response", (_event: any, ctx: any) => {
    const collector = (globalThis as any)[KEY];
    if (collector?.parentSessionId === ctx.sessionManager.getSessionId()) collector.providerRequests.after++;
  });
  pi.on("session_start", (_event: any, ctx: any) => {
    const collector = (globalThis as any)[KEY];
    const owner = collector?.parentSessionId;
    if (!owner || owner === ctx.sessionManager.getSessionId()) return;
    const snapshot = snapshotStartup(pi, ctx, collector);
    collector.snapshots = [...(collector.snapshots ?? []), snapshot];
  });
  pi.on("agent_end", (_event: any, ctx: any) => {
    const collector = (globalThis as any)[KEY];
    const owner = collector?.parentSessionId;
    if (!owner || owner === ctx.sessionManager.getSessionId()) return;
    capturePostTurn(ctx, collector);
  });
}
