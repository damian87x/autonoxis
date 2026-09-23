import { readFile } from "node:fs/promises";

const ENDPOINT = "http://127.0.0.1:11434/api/chat";
const MAX_PACKET_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 30_000;

function boundedText(value, limit, name) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > limit) throw new Error(`${name}_too_large`);
  return value;
}

async function boundedResponseText(response) {
  if (!response.body) return boundedText(await response.text(), MAX_RESPONSE_BYTES, "policy_response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("policy_response_too_large");
      chunks.push(value);
    }
  } finally {
    if (size > MAX_RESPONSE_BYTES) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseDecision(text, prefix, values) {
  if (typeof text !== "string") throw new Error("policy_response_invalid");
  const lines = boundedText(text, MAX_RESPONSE_BYTES, "policy_response").split(/\r?\n/).map(line => line.trim());
  const match = new RegExp(`^${prefix}: (${values.join("|")})$`).exec(lines[0]);
  if (!match || lines.slice(1).some(line => /^(DECISION|ACTION):/.test(line))) throw new Error("policy_response_invalid");
  return match[1];
}

export function buildPolicyPacket(packet) {
  const encoded = typeof packet === "string" ? packet : JSON.stringify(packet);
  return boundedText(encoded, MAX_PACKET_BYTES, "policy_packet");
}

export async function requestPolicy({ promptPath, packet, manager = false, fetchImpl = fetch, signal, timeoutMs = TIMEOUT_MS }) {
  const encoded = buildPolicyPacket(packet);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relayAbort = () => controller.abort();
  signal?.addEventListener("abort", relayAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const startedAt = Date.now();
  try {
    const prompt = await readFile(promptPath, "utf8");
    const response = await fetchImpl(ENDPOINT, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "autonoxis-conductor:14b", stream: false, think: false,
        options: { temperature: 0, num_predict: 16 }, messages: [{ role: "system", content: prompt }, { role: "user", content: encoded }] }),
    });
    if (!response.ok) throw new Error(`ollama_http_${response.status}`);
    const parsed = JSON.parse(await boundedResponseText(response));
    const decision = parseDecision(parsed?.message?.content, manager ? "ACTION" : "DECISION", manager ? ["ACCEPT", "VERIFY", "REJECT", "REOPEN", "ESCALATE"] : ["STOP", "ASK", "DISPATCH"]);
    return { decision, durationMs: Date.now() - startedAt, promptBytes: Buffer.byteLength(prompt), responseEvalCount: Number.isSafeInteger(parsed?.eval_count) ? parsed.eval_count : null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relayAbort);
  }
}

export const policyConfig = Object.freeze({ endpoint: ENDPOINT, timeoutMs: TIMEOUT_MS, maxPacketBytes: MAX_PACKET_BYTES, maxResponseBytes: MAX_RESPONSE_BYTES });
