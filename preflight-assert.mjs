import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOL_BASE_MODEL, isApprovedSolIdentity } from "./controller.mjs";

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const OBSERVER_ID = "autonoxis-observer";
// Byte hash, generated from agents/sol-leaf.md before tests; re-verify after any agent edit.
export const SHIPPED_AGENT_FILE_SHA256 = "3733ff58f6d7acc65ab6a020e5857710ac238dd65a33824e3f0239bfd5938994";
const hashFile = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function isPermissionSystemExtension(value) {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  let actual;
  try { actual = fs.realpathSync(value); } catch { return false; }
  for (const directory of [path.join(agentDir, "npm", "node_modules", "@gotgenes", "pi-permission-system"), path.join(agentDir, "extensions", "pi-permission-system")]) {
    const manifest = path.join(directory, "package.json");
    if (!fs.existsSync(manifest)) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(manifest, "utf8"))?.pi?.extensions?.[0];
      const candidate = typeof entry === "string" && entry.trim() ? path.resolve(directory, entry) : undefined;
      if (candidate && fs.existsSync(candidate) && fs.realpathSync(candidate) === actual) return true;
    } catch { /* fail closed */ }
  }
  return false;
}

export function checkPreflight(result, observerPath, expectedDefinitionDigest) {
  if (!/^[a-f0-9]{64}$/.test(expectedDefinitionDigest)) throw new Error("preflight_expected_digest_invalid");
  if (!result?.ok || !result.contract) throw new Error("preflight_rejected");
  const contract = result.contract, a = contract.agent, t = contract.tools;
  const fail = () => { throw new Error("preflight_rejected"); };
  if (!a || !t || a.name !== "pi-autonoxis.sol-leaf" || a.localName !== "sol-leaf" || a.packageName !== "pi-autonoxis" || a.source !== "package" ||
    fs.realpathSync(a.filePath) !== fs.realpathSync(path.join(PLUGIN_DIR, "agents", "sol-leaf.md")) || hashFile(a.filePath) !== SHIPPED_AGENT_FILE_SHA256 ||
    a.definitionProjectionVersion !== 2 || a.definitionDigest !== expectedDefinitionDigest || !Array.isArray(a.shadowedCandidates) || a.shadowedCandidates.length ||
    contract.protocol?.packageVersion !== "0.68.0" || contract.protocol?.lifecycleArtifactVersion !== 3 || !isApprovedSolIdentity(SOL_BASE_MODEL, contract.model, contract.thinking) || contract.thinking !== "off" || contract.context !== "fresh" || contract.systemPromptMode !== "replace" ||
    contract.inheritProjectContext || contract.inheritGlobalContext || contract.inheritSkills || contract.intercomBridge?.active || !Array.isArray(contract.diagnostics) || contract.diagnostics.some(d => d?.severity === "error" || d?.severity === "host-required") ||
    t.explicitAllowlist !== true || t.disableAmbientExtensions !== true || t.fanoutAuthorized || t.excludeTools !== undefined ||
    !Array.isArray(t.effectiveAllowlist) || t.effectiveAllowlist.length || !Array.isArray(t.declaredBuiltin) || t.declaredBuiltin.length || !Array.isArray(t.requestedBuiltin) || t.requestedBuiltin.length || !Array.isArray(t.requiredChildTools) || t.requiredChildTools.length || !Array.isArray(t.internalTools) || t.internalTools.length || !Array.isArray(t.mcp) || t.mcp.length || !Array.isArray(t.effectiveMcpTools) || t.effectiveMcpTools.length || !Array.isArray(t.toolExtensionPaths) || t.toolExtensionPaths.length || !Array.isArray(t.configuredExtensions) || t.configuredExtensions.length ||
    !t.capabilityAudit || t.capabilityAudit.agentAllowed !== true || t.capabilityAudit.extensionsDenied !== false || !Array.isArray(t.capabilityAudit.effectiveTools) || t.capabilityAudit.effectiveTools.length ||
    !Array.isArray(t.runtimeExtensions) || !t.runtimeExtensions.length || !t.runtimeExtensions[0].endsWith("/src/runs/shared/subagent-prompt-runtime.ts") || !equal(t.extensionArgs, t.runtimeExtensions) || t.extensionArgs.includes(observerPath) || !t.runtimeExtensions.slice(1).every(isPermissionSystemExtension) || !Array.isArray(t.requiredExtensionIds) || !t.requiredExtensionIds.includes(OBSERVER_ID)) fail();
  return { launchContractDigest: contract.launchContractDigest, resolvedModel: contract.model, thinking: contract.thinking, context: contract.context, inheritance: { project: contract.inheritProjectContext, global: contract.inheritGlobalContext, skills: contract.inheritSkills }, effectiveAllowlist: t.effectiveAllowlist, internalTools: t.internalTools, effectiveMcpTools: t.effectiveMcpTools, fanoutAuthorized: t.fanoutAuthorized, requiredExtensionIds: t.requiredExtensionIds, extensionArgs: t.extensionArgs, requiredPathOmitted: true, capabilityAudit: t.capabilityAudit, ambientExtensionsDisabled: t.disableAmbientExtensions, diagnostics: contract.diagnostics, agent: { name: a.name, localName: a.localName, packageName: a.packageName, source: a.source, filePath: a.filePath, definitionDigest: a.definitionDigest, definitionProjectionVersion: a.definitionProjectionVersion, shadowedCandidates: a.shadowedCandidates } };
}
