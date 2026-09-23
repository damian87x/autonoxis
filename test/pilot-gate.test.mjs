import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runPilotGate } from "./pilot-gate.mjs";

const clean = (stdout = "") => ({ status: 0, signal: null, error: null, timedOut: false, stdout });

test("pilot gate rejects a completion marker followed by timeout without verification or retry", async () => {
  let pilotCalls = 0, verifierCalls = 0;
  const result = await runPilotGate({ runPilot: async () => { pilotCalls++; return { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" }, timedOut: true, stdout: "PILOT_COMPLETE\n" }; }, runVerifier: async () => { verifierCalls++; return clean("LEDGER_VALID\n"); } });
  assert.equal(result.ok, false); assert.equal(result.phase, "pilot-process"); assert.equal(pilotCalls, 1); assert.equal(verifierCalls, 0);
});

test("pilot gate requires natural zero exit and an explicit valid ledger", async () => {
  for (const pilot of [{ ...clean("PILOT_COMPLETE\n"), status: 1 }, { ...clean("PILOT_COMPLETE\n"), signal: "SIGKILL" }]) {
    let verifierCalls = 0;
    const result = await runPilotGate({ runPilot: async () => pilot, runVerifier: async () => { verifierCalls++; return clean("LEDGER_VALID\n"); } });
    assert.equal(result.ok, false); assert.equal(verifierCalls, 0);
  }
  const invalid = await runPilotGate({ runPilot: async () => clean("PILOT_COMPLETE\n"), runVerifier: async () => ({ ...clean(""), status: 1 }) });
  assert.equal(invalid.ok, false); assert.equal(invalid.phase, "ledger-verification");
  const markerOnly = await runPilotGate({ runPilot: async () => clean("PILOT_COMPLETE\n"), runVerifier: async () => clean("not a certificate\n") });
  assert.equal(markerOnly.ok, false);
  const valid = await runPilotGate({ runPilot: async () => clean("PILOT_COMPLETE\n"), runVerifier: async () => clean("LEDGER_VALID\n") });
  assert.equal(valid.ok, true); assert.equal(valid.phase, "complete");
});

test("pilot gate CLI wires one pilot process to one ledger verification", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autonoxis-pilot-gate-cli-")), gate = path.join(root, "pilot-gate.mjs"), harness = path.join(root, "native-harness.mjs"), runRoot = path.join(root, "run"), evidenceDir = path.join(root, "evidence"), fixture = path.join(root, "fixture.json");
  mkdirSync(runRoot); mkdirSync(evidenceDir); writeFileSync(fixture, "{}\n");
  writeFileSync(gate, readFileSync(new URL("./pilot-gate.mjs", import.meta.url)));
  writeFileSync(harness, `const mode = process.argv[2]; if (mode === "pilot") console.log("PILOT_COMPLETE"); else if (mode === "verify-ledger") console.log("LEDGER_VALID"); else process.exitCode = 2;\n`);
  const result = spawnSync(process.execPath, [gate, "--run-root", runRoot, "--fixture", fixture, "--evidence-dir", evidenceDir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(evidenceDir, "pilot-gate-status.json"), "utf8")), { version: 1, ok: true, phase: "complete", pilot: { status: 0, signal: null, error: null, timedOut: false, stdout: "PILOT_COMPLETE\n" }, verifier: { status: 0, signal: null, error: null, timedOut: false, stdout: "LEDGER_VALID\n" }, noAutomaticRetry: true });
});
