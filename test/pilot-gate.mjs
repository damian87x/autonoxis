import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function runPilotGate({ runPilot, runVerifier }) {
  const pilot = await runPilot();
  const pilotClean = pilot?.status === 0 && pilot.signal == null && !pilot.error && pilot.timedOut !== true;
  if (!pilotClean) return { ok: false, phase: "pilot-process", pilot, verifier: null };
  const verifier = await runVerifier();
  const ledgerValid = verifier?.status === 0 && verifier.signal == null && !verifier.error && verifier.timedOut !== true && /^LEDGER_VALID\s*$/m.test(verifier.stdout ?? "");
  return { ok: ledgerValid, phase: ledgerValid ? "complete" : "ledger-verification", pilot, verifier };
}

function arg(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; }
function resultRecord(result) { return { status: result.status, signal: result.signal, error: result.error ? { name: result.error.name, code: result.error.code, message: result.error.message } : null, timedOut: result.error?.code === "ETIMEDOUT" }; }

async function main() {
  const runRoot = arg("--run-root"), fixture = arg("--fixture"), evidenceDir = arg("--evidence-dir");
  if (![runRoot, fixture, evidenceDir].every(value => typeof value === "string" && path.isAbsolute(value))) throw new Error("usage: pilot-gate --run-root <absolute> --fixture <absolute> --evidence-dir <absolute>");
  const harness = path.join(path.dirname(fileURLToPath(import.meta.url)), "native-harness.mjs");
  const evidence = path.join(evidenceDir, "pilot.json"), statusPath = path.join(evidenceDir, "pilot-gate-status.json");
  const pilotStdout = path.join(evidenceDir, "pilot-process.stdout.txt"), pilotStderr = path.join(evidenceDir, "pilot-process.stderr.txt"), verifierOutput = path.join(evidenceDir, "pilot-ledger-verification.txt");
  for (const file of [statusPath, pilotStdout, pilotStderr, verifierOutput]) if (existsSync(file)) throw new Error("pilot_gate_evidence_collision");
  mkdirSync(evidenceDir, { recursive: true });
  let pilotResult, verifierResult;
  const gate = await runPilotGate({
    runPilot: async () => {
      const result = spawnSync(process.execPath, [harness, "pilot", "--run-root", runRoot, "--fixture", fixture, "--evidence", evidence], { encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 1024 * 1024, env: { ...process.env, PI_SUBAGENTS_LLM_INTENT_ARBITER: "0" } });
      writeFileSync(pilotStdout, result.stdout ?? "", { flag: "wx" }); writeFileSync(pilotStderr, result.stderr ?? "", { flag: "wx" });
      return pilotResult = { ...resultRecord(result), stdout: result.stdout ?? "" };
    },
    runVerifier: async () => {
      const result = spawnSync(process.execPath, [harness, "verify-ledger", "--evidence", evidence], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}\nEXIT_STATUS=${result.status ?? "null"}\n`;
      writeFileSync(verifierOutput, combined, { flag: "wx" });
      return verifierResult = { ...resultRecord(result), stdout: result.stdout ?? "" };
    }
  });
  writeFileSync(statusPath, `${JSON.stringify({ version: 1, ok: gate.ok, phase: gate.phase, pilot: pilotResult, verifier: verifierResult ?? null, noAutomaticRetry: true }, null, 2)}\n`, { flag: "wx" });
  if (!gate.ok) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
