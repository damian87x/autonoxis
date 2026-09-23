// Gate zero deliberately reads process.env before any dynamic import or Pi resolution.
const childMarker = process.env.PI_SUBAGENT_CHILD === "1";
const herdrMarker = process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1";
const mode = process.argv[2];
const evidenceArg = process.argv.indexOf("--evidence");
const evidencePath = evidenceArg >= 0 ? process.argv[evidenceArg + 1] : undefined;
const fixtureArg = process.argv.indexOf("--fixture");
const fixturePath = fixtureArg >= 0 ? process.argv[fixtureArg + 1] : undefined;
const runRootArg = process.argv.indexOf("--run-root");
const runRoot = runRootArg >= 0 ? process.argv[runRootArg + 1] : undefined;
const agentDirArg = process.argv.indexOf("--agent-dir");
const packageRoot = agentDirArg >= 0 ? process.argv[agentDirArg + 1] : undefined;

async function writeEvidence(record) {
  if (!evidencePath) return;
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
}

// Module-only modes import public modules only; they never construct a Pi host or start inference.
const moduleOnlyMode = ["assert-api", "print-agent-identity", "assert-configured-agent"].includes(mode);
if (!["assert-api", "print-agent-identity", "assert-configured-agent", "assert-host", "check", "ollama", "pilot", "verify-ledger"].includes(mode)) {
  console.error("usage: print-agent-identity --run-root <absolute-dir> [--agent-dir <package-dir>] | assert-configured-agent --run-root <absolute-dir> --fixture <file> --evidence <new-file> | check --run-root <absolute-dir> --fixture <file> --evidence <new-file> | assert-api|assert-host|ollama|pilot|verify-ledger"); process.exitCode = 2;
} else if (packageRoot && mode !== "print-agent-identity") {
  throw new Error("agent_dir_only_supported_for_print_identity");
} else if (!moduleOnlyMode && (childMarker || herdrMarker)) {
  const reason = childMarker ? "child_inert" : "herdr_bridge_substituted";
  await writeEvidence({ status: "LIVE PENDING FOR PARENT", reason, markers: { PI_SUBAGENT_CHILD: childMarker, PI_SUBAGENTS_HERDR_BRIDGE: herdrMarker }, command: "PI_SUBAGENTS_LLM_INTENT_ARBITER=0 node test/native-harness.mjs check --run-root <fresh-temporary-directory> --fixture <frozen-fixture> --evidence <new-evidence-file>" });
  console.error(`LIVE PENDING FOR PARENT: ${reason}`); process.exitCode = 1;
} else if (["check", "pilot"].includes(mode) && process.env.PI_SUBAGENTS_LLM_INTENT_ARBITER !== "0") {
  throw new Error("llm_intent_arbiter_not_disabled");
} else if (mode === "verify-ledger") {
  if (!evidencePath) throw new Error("evidence_required");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { createHash } = await import("node:crypto");
  const data = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const { SOL_BASE_MODEL, isApprovedSolIdentity, isFreshChildObserverSnapshot, isObservedSolAssistant } = await import("../controller.mjs");
  const { providerCountersValid } = await import("./pilot-accounting.mjs");
  const counters = value => value && Number.isSafeInteger(value.before) && value.before >= 0 && Number.isSafeInteger(value.after) && value.after >= 0;
  const usage = value => value && ["input", "output", "cacheRead", "cacheWrite"].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0);
  const usageTotal = rows => {
    let total = 0;
    for (const row of rows) for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
      const value = row.usage[key];
      if (value > 32_000 || total > 32_000 - value) return null;
      total += value;
    }
    return total;
  };
  const preflight = value => value && typeof value.launchContractDigest === "string" && isApprovedSolIdentity(SOL_BASE_MODEL, value.resolvedModel, value.thinking) && value.thinking === "off" && Array.isArray(value.effectiveAllowlist) && value.effectiveAllowlist.length === 0 && Array.isArray(value.internalTools) && value.internalTools.length === 0 && Array.isArray(value.effectiveMcpTools) && value.effectiveMcpTools.length === 0 && value.fanoutAuthorized === false && value.ambientExtensionsDisabled === true && Array.isArray(value.diagnostics) && !value.diagnostics.some(diagnostic => diagnostic?.severity === "error" || diagnostic?.severity === "host-required") && Array.isArray(value.requiredExtensionIds) && value.requiredExtensionIds.includes("autonoxis-observer") && value.requiredPathOmitted === true && value.capabilityAudit;
  const registration = value => value && value.id === "autonoxis-observer" && typeof value.path === "string" && typeof value.hash === "string";
  const observer = value => value && typeof value.sessionId === "string" && Array.isArray(value.tools) && value.tools.length === 0 && typeof value.cwd === "string" && isFreshChildObserverSnapshot(value) && value.bridgeActive === false && value.observerId === "autonoxis-observer" && typeof value.observerHash === "string";
  const policyMeasurement = (value, decision) => value && value.decision === decision && Number.isInteger(value.durationMs) && value.durationMs >= 0 && Number.isInteger(value.promptBytes) && value.promptBytes > 0 && (value.responseEvalCount === null || Number.isInteger(value.responseEvalCount) && value.responseEvalCount >= 0);
  const usageRows = Array.isArray(data?.usage) ? data.usage : [];
  const childRows = usageRows.filter(row => row.phase === "child");
  const baselineRows = childRows.filter(row => row.arm === "baseline");
  const assistedRows = childRows.filter(row => row.arm === "assisted");
  const childPhase = row => row?.phase === "child";
  const validUsageRow = row => row && row.status === "completed" && (childPhase(row) ? isApprovedSolIdentity(SOL_BASE_MODEL, row.model, row.thinking) : Array.isArray(row.responses) && row.responses.length > 0 && row.responses.every(isObservedSolAssistant)) && Object.hasOwn(row, "usage") && usage(row.usage) && row.usageMissing === false && ((row.arm === "baseline" && ["parent-1", "parent-2", "child"].includes(row.phase)) || (row.arm === "assisted" && ["setup", "child"].includes(row.phase)));
  const validChild = row => validUsageRow(row) && row.phase === "child" && /^[a-f0-9]{64}$/.test(row.outputHash) && typeof row.launchContractDigest === "string" && observer(row.observer) && registration(row.observerRegistration) && row.observer.observerHash === row.observerRegistration.hash && preflight(row.preflight) && row.model === row.preflight.resolvedModel && (row.thinking === undefined || row.thinking === row.preflight.thinking) && row.launchContractDigest === row.preflight.launchContractDigest && row.agent?.definitionDigest === data.pinnedAgentDefinitionDigest && row.agent?.definitionProjectionVersion === 2 && row.preflight.agent?.definitionDigest === data.pinnedAgentDefinitionDigest && row.preflight.agent?.definitionProjectionVersion === 2;
  const expectedPhases = new Set(["baseline:parent-1", "baseline:parent-2", "baseline:child", "assisted:setup", "assisted:child"]);
  const exactUsageSchema = usageRows.length === expectedPhases.size && usageRows.every(row => expectedPhases.delete(`${row.arm}:${row.phase}`)) && expectedPhases.size === 0;
  const evidenceFile = path.resolve(evidencePath), evidenceDir = path.dirname(evidenceFile), attemptsDir = path.join(evidenceDir, "attempts");
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const regularBytes = (reference, expectedPath) => {
    if (!reference || typeof reference.path !== "string" || !/^[a-f0-9]{64}$/.test(reference.sha256) || path.resolve(reference.path) !== expectedPath) return undefined;
    try { const stat = fs.lstatSync(expectedPath); if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(expectedPath) !== expectedPath) return undefined; const bytes = fs.readFileSync(expectedPath); return createHash("sha256").update(bytes).digest("hex") === reference.sha256 ? bytes : undefined; } catch { return undefined; }
  };
  const validReservation = value => {
    const bytes = regularBytes(value, `${evidenceFile}.reservation.json`); if (!bytes) return false;
    try { const record = JSON.parse(bytes); return record?.kind === "pilot-evidence-reservation" && typeof record.timestamp === "string" && record.evidencePath === evidenceFile; } catch { return false; }
  };
  const childIdentity = row => [row?.requestId, row?.ownerRunId, row?.nodeId].every(value => typeof value === "string" && value.length > 0);
  const parent = (arm, phase) => usageRows.find(row => row.arm === arm && row.phase === phase);
  const baselineChild = childRows.find(row => row.arm === "baseline"), assistedChild = childRows.find(row => row.arm === "assisted");
  const expectedAttempts = [
    { sequence: 1, arm: "baseline", phase: "parent-1", premium: true, row: parent("baseline", "parent-1") },
    { sequence: 2, arm: "baseline", phase: "parent-2", premium: true, row: parent("baseline", "parent-2") },
    { sequence: 3, arm: "baseline", phase: "child", premium: true, row: baselineChild },
    { sequence: 4, arm: "assisted", phase: "setup", premium: true, row: parent("assisted", "setup") },
    { sequence: 5, arm: "assisted", phase: "command", premium: false },
    { sequence: 6, arm: "assisted", phase: "child", premium: true, row: assistedChild }
  ];
  const artifactRecord = (reference, expected, kind) => {
    const bytes = regularBytes(reference, path.join(attemptsDir, `${String(expected.sequence).padStart(3, "0")}-${kind}.json`)); if (!bytes) return false;
    let record; try { record = JSON.parse(bytes); } catch { return false; }
    if (!record || record.kind !== kind || record.sequence !== expected.sequence || record.arm !== expected.arm || record.phase !== expected.phase || record.premium !== expected.premium || typeof record.timestamp !== "string") return false;
    if (expected.phase === "command" && kind === "terminal" && (record.status !== "completed" || record.usage !== null || record.usageMissing !== true || record.rawMessageCount !== 0 || record.transportRequests !== 1 || !same(record.providerBefore, data?.providerRequests?.assisted) || !same(record.providerAfter, data?.providerRequests?.assisted))) return false;
    if (!expected.row) return kind !== "outcome" || record.accepted === true;
    const row = expected.row;
    if (kind === "issued" && expected.premium && (record.requestedModel !== SOL_BASE_MODEL || record.requestedThinking !== "off")) return false;
    if (kind === "terminal" && (record.status !== row.status || record.model !== row.model || record.thinking !== row.thinking || record.provider !== row.provider || record.responseModel !== row.responseModel || record.providerThinkingLevel !== row.providerThinkingLevel || !same(record.responses, row.responses) || !same(record.usage, row.usage) || record.usageMissing !== row.usageMissing)) return false;
    if (expected.phase === "child" && kind === "terminal" && (record.unresolved !== false || record.outputHash !== row.outputHash || record.formatCanonical !== row.formatCanonical || record.launchContractDigest !== row.launchContractDigest || !same(record.observer, row.observer) || !same(record.observerRegistration, row.observerRegistration) || !same(record.preflight, row.preflight) || !same(record.agent, row.agent) || !same(record.localPolicy, row.localPolicy))) return false;
    if (expected.phase === "child") {
      if (kind !== "issued" || expected.sequence !== 6) {
        if (!childIdentity(record) || record.requestId !== row.requestId || record.ownerRunId !== row.ownerRunId || record.nodeId !== row.nodeId) return false;
      } else if (record.nodeId !== row.nodeId || record.contractHash !== data.runtimeContractHash) return false;
    }
    if (kind === "outcome" && expected.phase === "child" && (record.unresolved !== false || record.validation?.ok !== true || record.validation?.format_canonical !== row.formatCanonical)) return false;
    return kind !== "outcome" || record.accepted === true;
  };
  const attemptArtifacts = data?.attemptArtifacts;
  const exactArtifacts = Array.isArray(attemptArtifacts) && attemptArtifacts.length === expectedAttempts.length && expectedAttempts.every(expected => {
    const value = attemptArtifacts[expected.sequence - 1];
    return value?.sequence === expected.sequence && value.premium === expected.premium && artifactRecord(value.issued, expected, "issued") && artifactRecord(value.terminal, expected, "terminal") && artifactRecord(value.outcome, expected, "outcome");
  });
  const runtimeContract = value => {
    const bytes = regularBytes(value, path.join(evidenceDir, "runtime-contract.json"));
    if (!bytes || !/^[a-f0-9]{64}$/.test(data?.runtimeContractHash)) return false;
    return createHash("sha256").update(bytes).digest("hex") === data.runtimeContractHash;
  };
  const childTriples = childRows.map(row => `${row?.requestId}\u0000${row?.ownerRunId}\u0000${row?.nodeId}`);
  const uniqueChildTriples = childRows.length === 2 && childRows.every(childIdentity) && new Set(childTriples).size === childTriples.length;
  const topCountersMatch = providerCountersValid(data?.providerRequests?.baseline, 2) && providerCountersValid(data?.providerRequests?.assisted, 1);
  const windowCounters = data?.noWake?.providerRequests;
  const noWakeCountersMatch = counters(windowCounters?.before) && counters(windowCounters?.after) && windowCounters.before.before === data?.providerRequests?.assisted?.before && windowCounters.before.after === data?.providerRequests?.assisted?.after && windowCounters.after.before === data?.providerRequests?.assisted?.before && windowCounters.after.after === data?.providerRequests?.assisted?.after;
  const limits = data?.limits;
  if (!data || data.status !== "PILOT_COMPLETE" || !/^[a-f0-9]{64}$/.test(data.fixtureHash) || !/^[a-f0-9]{64}$/.test(data.pinnedAgentDefinitionDigest) || data.pinnedAgentDefinitionProjectionVersion !== 2 || !Array.isArray(data.usage) || !usageRows.every(validUsageRow) || !exactUsageSchema || usageTotal(usageRows) === null || !validReservation(data.evidenceReservation) || !exactArtifacts || !runtimeContract(data.runtimeContract) || baselineRows.length !== 1 || assistedRows.length !== 1 || !childRows.every(validChild) || !uniqueChildTriples || baselineRows[0].observer.sessionId === assistedRows[0].observer.sessionId || !policyMeasurement(assistedRows[0].localPolicy?.conductor, "DISPATCH") || !policyMeasurement(assistedRows[0].localPolicy?.manager, "ACCEPT") || !data.hp1?.piLevelOnly || !Array.isArray(data.hp1.activeTools) || data.hp1.activeTools.includes("autonoxis_probe_tool") || !topCountersMatch || data.noWake?.assistedCommandAddedMessages !== 0 || data.noWake?.graceMs !== 5000 || !noWakeCountersMatch || limits?.maxPremiumAttempts !== 8 || limits?.maxMinutes !== 15 || limits?.admissionTokens !== 32000 || !Number.isInteger(data.premiumAttemptsObserved) || data.premiumAttemptsObserved !== data.usage.length || data.premiumAttemptsObserved > 8 || !Number.isInteger(data.elapsedMs) || data.elapsedMs < 0 || data.elapsedMs > 15 * 60_000 || data.accounting?.price !== "UNKNOWN" || data.accounting?.savings !== "NOT_CALCULATED" || data.accounting?.setupContextCacheConfound !== true) throw new Error("ledger_invalid_or_not_pilot_complete");
  console.log("LEDGER_VALID");
} else {
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const crypto = await import("node:crypto");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const root = path.resolve(import.meta.dirname, "..");
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
  const anchor = path.join(agentDir, "npm", "package.json");
  const { resolvePinnedPiEntry } = await import(pathToFileURL(path.join(root, "test", "pi-entry.mjs")).href);
  const { entry, package: piPackage } = resolvePinnedPiEntry();
  if (!fs.existsSync(anchor)) throw new Error("agent_npm_anchor_missing");
  const resolve = createRequire(anchor).resolve;
  const targets = ["delegation", "preflight", "required-child-extensions", "capability-ceiling", "shared-types"].map(name => ({ name, target: resolve(`pi-subagents/${name}`) }));
  const subagentsPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(resolve("pi-subagents/delegation")), "..", "..", "package.json"), "utf8"));
  if (subagentsPackage.version !== "0.68.0") throw new Error("pi_subagents_version_mismatch");
  const hostRecord = { agentDir, piEntry: entry, candidate: entry, piVersion: piPackage.version, piSubagentsVersion: subagentsPackage.version, publicExports: targets };
  const { SOL_ACTOR, isApprovedSolIdentity, isFreshChildObserverSnapshot, isObservedSolAssistant, validateWorkerJson } = await import(pathToFileURL(path.join(root, "controller.mjs")).href);
  const { checkPreflight } = await import(pathToFileURL(path.join(root, "preflight-assert.mjs")).href);
  const { createHostDisposer, settleHostDisposals } = await import(pathToFileURL(path.join(root, "test", "host-lifecycle.mjs")).href);
  if (["print-agent-identity", "assert-configured-agent", "check", "pilot"].includes(mode) && (!runRoot || !path.isAbsolute(runRoot))) throw new Error("run_root_required");
  if (mode === "check" && !fixturePath) throw new Error("check_fixture_required");
  function configuredFixture(value) {
    if (value?.version !== 2 || value?.agentDefinitionProjectionVersion !== 2 || !/^[a-f0-9]{64}$/.test(value?.agentDefinitionDigest) || !Array.isArray(value.nodes) || !value.nodes.every(node => node.actor === SOL_ACTOR)) throw new Error("configured_agent_fixture_invalid");
    return value;
  }
  function ensureRunRootPackage(value, source = root) {
    if (!source || !path.isAbsolute(source) || !fs.existsSync(path.join(source, "package.json"))) throw new Error("agent_dir_invalid");
    if (!value || !path.isAbsolute(value) || !fs.existsSync(value) || !fs.lstatSync(value).isDirectory() || fs.lstatSync(value).isSymbolicLink()) throw new Error("run_root_not_disposable");
    const resolvedRoot = fs.realpathSync(value), tempRoot = fs.realpathSync(os.tmpdir()), relative = path.relative(tempRoot, resolvedRoot);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("run_root_not_disposable");
    const piDir = path.join(resolvedRoot, ".pi"), marker = path.join(piDir, "autonoxis-harness-root.json"), sourcePath = fs.realpathSync(source), markerBytes = `${JSON.stringify({ version: 1, root: resolvedRoot, source: sourcePath })}\n`;
    if (!fs.existsSync(piDir)) {
      if (fs.readdirSync(resolvedRoot).length !== 0) throw new Error("run_root_not_empty");
      fs.mkdirSync(piDir, { mode: 0o700 });
      fs.writeFileSync(marker, markerBytes, { flag: "wx", mode: 0o600 });
    } else {
      if (fs.lstatSync(piDir).isSymbolicLink() || fs.realpathSync(piDir) !== piDir || !fs.existsSync(marker)) throw new Error("run_root_not_owned");
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(marker) !== marker || fs.readFileSync(marker, "utf8") !== markerBytes) throw new Error("run_root_not_owned");
    }
    const nodeModules = path.join(piDir, "npm", "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });
    const link = path.join(nodeModules, "pi-autonoxis");
    if (fs.existsSync(link)) {
      if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== sourcePath) throw new Error("run_root_package_collision");
    } else fs.symlinkSync(sourcePath, link, "dir");
    return link;
  }
  const observerPath = fs.realpathSync(path.join(root, "test", "observer.ts"));
  const observerHash = crypto.createHash("sha256").update(fs.readFileSync(observerPath, "utf8")).digest("hex");

  async function api() {
    // Match Pi's public extension-loader alias so peer imports share this exact pinned entry.
    const jiti = createRequire(anchor)("jiti")(anchor, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": entry } });
    return Object.fromEntries(await Promise.all(targets.map(async ({ name }) => [name, await jiti.import(`pi-subagents/${name}`)])));
  }
  function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
  function waitFor(bus, channel, predicate, ms = 2_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timeout_${channel}`)); }, ms);
      const off = bus.on(channel, value => { if (predicate(value)) { clearTimeout(timer); off(); resolve(value); } });
    });
  }
  async function rpc(bus, method, params = {}) {
    const requestId = crypto.randomUUID();
    const reply = waitFor(bus, `subagents:rpc:v1:reply:${requestId}`, value => value?.requestId === requestId);
    bus.emit("subagents:rpc:v1:request", { version: 1, requestId, method, source: { extension: "pi-autonoxis" }, params });
    return await reply;
  }
  function sourceKind(source) { return source.startsWith("npm:") ? "npm" : source.includes("://") || source.startsWith("git+") ? "git" : "other"; }
  async function noInstall(settingsManager, Pi, cwd) {
    if (Object.hasOwn(process.env, "PI_OFFLINE")) throw new Error("offline_mode_not_accepted_for_no_install_gate");
    const manager = new Pi.DefaultPackageManager({ cwd, agentDir, settingsManager });
    const configured = manager.listConfiguredPackages();
    if (configured.some(source => !source.installedPath)) throw new Error("configured_package_not_installed");
    await manager.resolve(async () => "error");
    return { count: configured.length, sources: configured.map(source => ({ scope: source.scope, kind: sourceKind(source.source), hash: sha256(`${source.scope}:${source.source}`), latest: /@latest(?:$|\s)/.test(source.source) })) };
  }
  function loadedPaths(loader) { return loader.getExtensions().extensions.map(extension => fs.realpathSync(extension.resolvedPath)).sort(); }
  async function makeHost({ probe = false, cwd }) {
    if (!cwd || !path.isAbsolute(cwd)) throw new Error("host_cwd_required");
    const Pi = await import(pathToFileURL(entry).href);
    await fsp.mkdir(path.join(cwd, ".pi"), { recursive: true });
    const settingsPath = path.join(cwd, ".pi", "settings.json"), settingsBytes = JSON.stringify({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, compaction: { enabled: false } });
    if (fs.existsSync(settingsPath)) {
      const stat = fs.lstatSync(settingsPath);
      if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(settingsPath, "utf8") !== settingsBytes) throw new Error("settings_collision");
    } else await fsp.writeFile(settingsPath, settingsBytes, { flag: "wx", mode: 0o600 });
    const settingsManager = Pi.SettingsManager.create(cwd, agentDir);
    const packages = await noInstall(settingsManager, Pi, cwd);
    if (settingsManager.getRetryEnabled() || settingsManager.getProviderRetrySettings().maxRetries !== 0 || settingsManager.getCompactionEnabled()) throw new Error("effective_isolation_settings_invalid");
    const eventBus = Pi.createEventBus();
    const probePath = path.join(cwd, "probe.ts");
    if (probe) await fsp.writeFile(probePath, `export default function(pi){pi.registerTool({name:'autonoxis_probe_tool',label:'probe',description:'probe',parameters:{type:'object',properties:{},additionalProperties:false},execute:async()=>({content:[],details:{}})})}`, { flag: "wx" });
    const extensionPaths = [resolve("pi-subagents"), path.join(root, "index.ts"), observerPath, ...(probe ? [probePath] : [])].map(file => fs.realpathSync(file));
    const loader = new Pi.DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: extensionPaths });
    await loader.reload();
    if (JSON.stringify(loadedPaths(loader)) !== JSON.stringify([...extensionPaths].sort()) || loader.getExtensions().errors.length || loader.getSkills().skills.length || loader.getPrompts().prompts.length || loader.getThemes().themes.length || loader.getAgentsFiles().agentsFiles.length || loader.getSystemPrompt() || loader.getAppendSystemPrompt().length) throw new Error("isolated_loader_rejected");
    const modelRuntime = await Pi.ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
    const models = await modelRuntime.getAvailable();
    const model = models.find(candidate => `${candidate.provider}/${candidate.id}` === "openai-codex/gpt-5.6-sol");
    if (!model) throw new Error("sol_model_unavailable");
    const sessionManager = Pi.SessionManager.inMemory(cwd);
    const services = { cwd, agentDir, modelRuntime, settingsManager, resourceLoader: loader, diagnostics: [] };
    let created = false;
    const runtime = await Pi.createAgentSessionRuntime(async options => {
      if (created || options.cwd !== cwd || options.sessionManager !== sessionManager) throw new Error("unexpected_runtime_replacement");
      created = true;
      const result = await Pi.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, thinkingLevel: "off", tools: [] });
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd, agentDir, sessionManager, sessionStartEvent: { type: "session_start", reason: "startup" } });
    const bindErrors = [];
    const dispose = createHostDisposer({ runtime, errors: bindErrors });
    try {
      if (runtime.modelFallbackMessage) throw new Error("model_fallback");
      await runtime.session.bindExtensions({ mode: "print", onError: error => bindErrors.push(String(error?.error ?? error)) });
      if (bindErrors.length || loader.getExtensions().errors.length) throw new Error("extension_bind_failed");
    } catch (error) {
      try { await dispose(); } catch (cleanupError) { if (error && typeof error === "object") error.cleanupError = String(cleanupError); }
      throw error;
    }
    return { Pi, cwd, eventBus, loader, session: runtime.session, sessionManager, settingsManager, modelRuntime, packages, extensionPaths, dispose };
  }
  function activateObserverCollector(host) {
    return globalThis[Symbol.for("pi-autonoxis.observer.v1")] = { parentSessionId: host.sessionManager.getSessionId(), observerId: "autonoxis-observer", observerHash, snapshots: [], providerRequests: { before: 0, after: 0 } };
  }
  function normalizedUsage(messages) {
    const rows = messages.filter(message => message?.role === "assistant" && message.usage).map(message => message.usage);
    if (!rows.length) return null;
    return rows.reduce((total, usage) => ({ input: total.input + usage.input, output: total.output + usage.output, cacheRead: total.cacheRead + usage.cacheRead, cacheWrite: total.cacheWrite + usage.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  }
  function assistantIdentities(messages) {
    return messages.filter(message => message?.role === "assistant").map(message => ({ provider: message.provider, model: message.model, responseModel: message.responseModel, providerThinkingLevel: message.providerThinkingLevel }));
  }
  if (mode === "assert-api") {
    const publicApi = await api();
    if (typeof publicApi.preflight.resolveSubagentLaunchContract !== "function") throw new Error("public_preflight_export_missing");
    console.log("PUBLIC_API_READY");
  } else if (mode === "print-agent-identity" || mode === "assert-configured-agent") {
    ensureRunRootPackage(runRoot, packageRoot || root);
    const publicApi = await api();
    const sessionId = `autonoxis-identity-${crypto.randomUUID()}`;
    const observerReg = publicApi["required-child-extensions"].registerRequiredChildExtensions({ sessionId, extensions: [{ id: "autonoxis-observer", path: observerPath }] });
    const ceilingReg = publicApi["capability-ceiling"].registerSubagentCapabilityCeiling({ sessionId, source: "pi-autonoxis", ceiling: { allowedTools: [], allowedAgents: [SOL_ACTOR] } });
    try {
      const contract = await publicApi.preflight.resolveSubagentLaunchContract({ agent: SOL_ACTOR, task: "Return {}", cwd: runRoot, context: "fresh", model: "openai-codex/gpt-5.6-sol", thinking: "off", skill: false, artifacts: false, parentSessionId: sessionId, sessionDir: path.join(runRoot, ".pi", "autonoxis-preflight"), availableModels: [{ provider: "openai-codex", id: "gpt-5.6-sol" }], capabilityCeiling: publicApi["capability-ceiling"].resolveCurrentSubagentCapabilityCeiling(sessionId), intercomBridge: { mode: "off" } });
      if (mode === "print-agent-identity") {
        const a = contract.contract?.agent, t = contract.contract?.tools;
        console.log(JSON.stringify({ name: a?.name, localName: a?.localName, packageName: a?.packageName, source: a?.source, filePath: a?.filePath, definitionDigest: a?.definitionDigest, definitionProjectionVersion: a?.definitionProjectionVersion, shadowedCandidates: a?.shadowedCandidates, tools: t }));
      } else {
        if (!fixturePath) throw new Error("configured_agent_fixture_required");
        const fixture = configuredFixture(JSON.parse(await fsp.readFile(fixturePath, "utf8")));
        const evidence = checkPreflight(contract, observerPath, fixture.agentDefinitionDigest);
        await writeEvidence({ status: "CONFIGURED_AGENT_RESOLVED", runRoot, agent: evidence.agent, launchContractDigest: evidence.launchContractDigest, tools: contract.contract.tools, requiredExtensionIds: evidence.requiredExtensionIds });
        console.log("CONFIGURED_AGENT_RESOLVED");
      }
    } finally { ceilingReg.dispose(); observerReg.dispose(); }
  } else if (mode === "assert-host") {
    await writeEvidence({ status: "HOST_READY", ...hostRecord }); console.log("HOST_READY");
  } else if (mode === "check") {
    const handlerErrors = [], originalError = console.error;
    let host;
    console.error = (...args) => { const text = args.map(String).join(" "); if (text.includes("Event handler error (")) handlerErrors.push(text); originalError(...args); };
    try {
      const fixture = configuredFixture(JSON.parse(await fsp.readFile(fixturePath, "utf8")));
      ensureRunRootPackage(runRoot);
      host = await makeHost({ cwd: runRoot });
      const publicApi = await api();
      const ping = await rpc(host.eventBus, "ping");
      if (!ping?.success || ping.data?.session?.sessionId !== host.sessionManager.getSessionId()) throw new Error("rpc_ping_session_mismatch");
      const actor = SOL_ACTOR;
      const observer = publicApi["required-child-extensions"].registerRequiredChildExtensions({ sessionId: host.sessionManager.getSessionId(), extensions: [{ id: "autonoxis-observer", path: observerPath }] });
      try {
        const invalidId = crypto.randomUUID();
        const invalid = waitFor(host.eventBus, publicApi.delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, value => value?.requestId === invalidId);
        host.eventBus.emit(publicApi.delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, { requestId: invalidId, ownerRunId: "", nodeId: "probe" });
        if ((await invalid).status !== "invalid_request") throw new Error("invalid_roundtrip_failed");
        const requestId = crypto.randomUUID(), ownerRunId = crypto.randomUUID(), nodeId = "pre-cancel";
        const cancelled = waitFor(host.eventBus, publicApi.delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, value => value?.requestId === requestId);
        host.eventBus.emit(publicApi.delegation.SUBAGENT_DELEGATION_CANCEL_EVENT, { requestId, ownerRunId, nodeId });
        host.eventBus.emit(publicApi.delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, { requestId, ownerRunId, nodeId, agent: actor, task: "Return {}", context: "fresh", cwd: host.cwd, model: "openai-codex/gpt-5.6-sol", thinking: "off", timeoutMs: 1_000, toolBudget: { hard: 0, block: "*" }, skill: false, artifacts: false, intercomBridge: { mode: "off" }, result: { kind: "text" } });
        if ((await cancelled).status !== "cancelled") throw new Error("pre_cancel_roundtrip_failed");
        const ceiling = publicApi["capability-ceiling"].registerSubagentCapabilityCeiling({ sessionId: host.sessionManager.getSessionId(), source: "autonoxis-check", ceiling: { allowedTools: [], allowedAgents: [actor] } });
        try {
          const preflight = await publicApi.preflight.resolveSubagentLaunchContract({ agent: actor, task: "Return {}", cwd: host.cwd, context: "fresh", model: "openai-codex/gpt-5.6-sol", thinking: "off", skill: false, artifacts: false, parentSessionId: host.sessionManager.getSessionId(), sessionDir: path.join(host.cwd, ".pi", "autonoxis-preflight"), availableModels: await host.modelRuntime.getAvailable(), capabilityCeiling: publicApi["capability-ceiling"].resolveCurrentSubagentCapabilityCeiling(host.sessionManager.getSessionId()), intercomBridge: { mode: "off" } });
          const preflightRecord = checkPreflight(preflight, observerPath, fixture.agentDefinitionDigest);
          if (preflight.contract.context !== "fresh" || preflight.contract.inheritProjectContext || preflight.contract.inheritGlobalContext || preflight.contract.inheritSkills || preflight.contract.tools.effectiveAllowlist.length || preflight.contract.tools.internalTools.length || preflight.contract.tools.effectiveMcpTools.length || preflight.contract.tools.fanoutAuthorized) throw new Error("preflight_evidence_rejected");
          const hp1 = await makeHost({ probe: true, cwd: await fsp.mkdtemp(path.join(os.tmpdir(), "pi-autonoxis-probe-")) });
          let activeTools;
          try { activeTools = hp1.session.getActiveToolNames(); if (activeTools.includes("autonoxis_probe_tool")) throw new Error("hp1_active_tool_falsified"); } finally { await hp1.dispose(); }
          const runtime = host.loader.getExtensions().runtime, originalSendMessage = runtime.sendMessage, originalSendUserMessage = runtime.sendUserMessage, notifications = [];
          runtime.sendMessage = (message, options) => { notifications.push({ message, options }); };
          runtime.sendUserMessage = () => { throw new Error("hp2_send_user_message_called"); };
          const foreground = { id: `hp2:${0}`, runId: "hp2", source: "foreground", mode: "run", agent: actor, success: true, summary: "done", exitCode: 0, state: "complete", timestamp: new Date().toISOString(), cwd: host.cwd, sessionId: host.sessionManager.getSessionId(), taskIndex: 0 };
          try {
            host.eventBus.emit("subagent:foreground-complete", foreground);
            await new Promise(resolve => setTimeout(resolve, 0));
            if (notifications.length !== 1 || notifications[0].message?.customType !== "subagent-notify" || notifications[0].options?.triggerTurn !== true) throw new Error("hp2_notifier_rejected");
            host.eventBus.emit("subagent:foreground-complete", { ...foreground, id: "hp2:wrong", sessionId: "wrong-session" });
            await new Promise(resolve => setTimeout(resolve, 0));
            if (notifications.length !== 1) throw new Error("hp2_session_filter_rejected");
          } finally { runtime.sendMessage = originalSendMessage; runtime.sendUserMessage = originalSendUserMessage; }
          if (handlerErrors.length) throw new Error("event_handler_error");
          await writeEvidence({ status: "CHECK_COMPLETE_NO_INFERENCE", ...hostRecord, packages: host.packages, loadedExtensions: host.extensionPaths, eventHandlerErrors: handlerErrors, effectiveSettings: { retry: host.settingsManager.getRetrySettings(), providerRetry: host.settingsManager.getProviderRetrySettings(), compaction: host.settingsManager.getCompactionSettings() }, ping: ping.data, preflight: preflightRecord, hp1: { piLevelOnly: true, activeTools }, hp2: { notifier: "subagent-notify", matchingSession: true, mismatchedSessionSilent: true } });
          console.log("CHECK_COMPLETE_NO_INFERENCE");
        } finally { ceiling.dispose(); }
      } finally { observer.dispose(); }
    } finally { try { await host?.dispose(); } finally { console.error = originalError; } }
  } else if (mode === "ollama") {
    const { requestPolicy } = await import(pathToFileURL(path.join(root, "policy.mjs")).href);
    const conductor = "Human authority pilot-authority is current for contract fixture-hash. Node sort is a finite, tools-free task assigned to sorter; its exact task contract, model, capability ceiling, and preflight evidence are current. Choose the next externally visible action.";
    const manager = "Human authority pilot-authority is current for contract fixture-hash. Node sort completed with the required model and exact deterministic JSON evidence (output hash fixture-output, launch digest fixture-digest); no failed or stale evidence is present. Choose the next externally visible action.";
    const decision = await requestPolicy({ promptPath: path.join(root, "prompts", "conductor-system-v4.txt"), packet: conductor });
    const acceptance = await requestPolicy({ promptPath: path.join(root, "prompts", "manager-system-v4.txt"), manager: true, packet: manager });
    await writeEvidence({ status: "OLLAMA_DECISION_MANAGER_CONNECTIVITY", endpoint: "http://127.0.0.1:11434", packetEncoding: "raw_string", decision: decision.decision, manager: acceptance.decision, decisionDurationMs: decision.durationMs, managerDurationMs: acceptance.durationMs }); console.log("OLLAMA_DECISION_MANAGER_CONNECTIVITY");
  } else if (mode === "pilot") {
    if (!fixturePath || !evidencePath) throw new Error("pilot_fixture_and_evidence_required");
    const fixtureBytes = await fsp.readFile(fixturePath, "utf8");
    const fixture = configuredFixture(JSON.parse(fixtureBytes));
    const { PilotAccounting, buildAssistedChildRow, buildBaselineChildRow, countersEqual, persistIssuesBeforeForward, persistTerminalBeforeAcceptance, validUsage, validatePilotFixture } = await import(pathToFileURL(path.join(root, "test", "pilot-accounting.mjs")).href);
    validatePilotFixture(fixture);
    const startedAt = Date.now();
    const runtimeContractPath = path.join(path.dirname(path.resolve(evidencePath)), "runtime-contract.json");
    const accounting = new PilotAccounting({ evidencePath, limits: fixture.pilot, reservePaths: [runtimeContractPath] });
    await accounting.reserve(); // Reserve all attempt paths before host construction or premium issuance.
    const finalEvidence = async record => await fsp.writeFile(evidencePath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    const admission = () => accounting.assertAdmissible({ forNextRequest: true, elapsedMs: Date.now() - startedAt });
    const publicApi = await api();
    const usage = [];
    const addUsage = row => { usage.push(row); return row; };
    const parentPrompt = async (host, arm, phase, prompt) => {
      admission();
      const before = host.session.messages.length;
      let failure;
      const { attempts: [attempt] } = await persistIssuesBeforeForward(accounting, [{ arm, phase, premium: true, requestedModel: fixture.model, requestedThinking: "off", promptHash: sha256(prompt), timestamp: new Date().toISOString() }], async () => { try { await host.session.prompt(prompt); } catch (error) { failure = error; } });
      const messages = host.session.messages.slice(before);
      const value = normalizedUsage(messages), responses = assistantIdentities(messages), served = responses.at(-1) ?? {};
      const terminal = { arm, phase, ...served, responses, status: failure ? "failed" : "completed", usage: value, usageMissing: value === null, rawMessageCount: messages.length };
      const accepted = await persistTerminalBeforeAcceptance(accounting, attempt, terminal, () => { addUsage(terminal); return !failure && validUsage(value) && responses.length > 0 && responses.every(isObservedSolAssistant); });
      await accounting.outcome(attempt, { accepted, error: failure instanceof Error ? failure.message : failure ? String(failure) : undefined });
      if (failure) throw failure;
      accounting.assertAdmissible({ elapsedMs: Date.now() - startedAt });
    };
    const delegate = async (host, arm) => {
      const actor = SOL_ACTOR;
      const observer = publicApi["required-child-extensions"].registerRequiredChildExtensions({ sessionId: host.sessionManager.getSessionId(), extensions: [{ id: "autonoxis-observer", path: observerPath }] });
      const ceiling = publicApi["capability-ceiling"].registerSubagentCapabilityCeiling({ sessionId: host.sessionManager.getSessionId(), source: "autonoxis-pilot", ceiling: { allowedTools: [], allowedAgents: [actor] } });
      const requestId = crypto.randomUUID(), ownerRunId = crypto.randomUUID(), nodeId = fixture.nodes[0].id;
      let attempt;
      try {
        const preflight = await publicApi.preflight.resolveSubagentLaunchContract({ agent: actor, task: fixture.nodes[0].task, cwd: host.cwd, context: "fresh", model: fixture.model, thinking: "off", skill: false, artifacts: false, parentSessionId: host.sessionManager.getSessionId(), sessionDir: path.join(host.cwd, ".pi", "autonoxis-preflight"), availableModels: await host.modelRuntime.getAvailable(), capabilityCeiling: publicApi["capability-ceiling"].resolveCurrentSubagentCapabilityCeiling(host.sessionManager.getSessionId()), intercomBridge: { mode: "off" } });
        const preflightRecord = checkPreflight(preflight, observerPath, fixture.agentDefinitionDigest);
        const snapshotCount = globalThis[Symbol.for("pi-autonoxis.observer.v1")]?.snapshots?.length ?? 0;
        admission();
        const issued = await persistIssuesBeforeForward(accounting, [{ arm, phase: "child", premium: true, requestedModel: fixture.model, requestedThinking: "off", taskHash: sha256(fixture.nodes[0].task), requestId, ownerRunId, nodeId, launchContractDigest: preflightRecord.launchContractDigest }], async () => {
          const response = waitFor(host.eventBus, publicApi.delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, value => value?.requestId === requestId && value?.ownerRunId === ownerRunId && value?.nodeId === nodeId, fixture.nodes[0].timeoutMs + 5_000);
          host.eventBus.emit(publicApi.delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, { requestId, ownerRunId, nodeId, agent: actor, task: fixture.nodes[0].task, context: "fresh", cwd: host.cwd, model: fixture.model, thinking: "off", timeoutMs: fixture.nodes[0].timeoutMs, toolBudget: { hard: 0, block: "*" }, skill: false, artifacts: false, intercomBridge: { mode: "off" }, result: { kind: "text" } });
          return await response;
        }, ([bound]) => { attempt = bound; });
        const terminal = issued.result;
        const output = validateWorkerJson(terminal.result?.text, fixture.nodes[0].expectedJson);
        const snapshot = globalThis[Symbol.for("pi-autonoxis.observer.v1")]?.snapshots?.[snapshotCount];
        const row = buildBaselineChildRow({ arm, terminal, outputHash: typeof terminal.result?.text === "string" ? sha256(terminal.result.text) : undefined, formatCanonical: output.format_canonical, observer: snapshot, observerPath, observerHash, preflight: preflightRecord, requestId, ownerRunId, nodeId });
        const accepted = await persistTerminalBeforeAcceptance(accounting, attempt, { ...row, unresolved: false }, () => { addUsage(row); return terminal.status === "completed" && isApprovedSolIdentity(fixture.model, terminal.model, terminal.thinking) && terminal.model === preflightRecord.resolvedModel && (terminal.thinking === undefined || terminal.thinking === preflightRecord.thinking) && terminal.launchContractDigest === preflightRecord.launchContractDigest && output.ok && snapshot && snapshot.cwd === host.cwd && isFreshChildObserverSnapshot(snapshot) && !snapshot.bridgeActive && !snapshot.tools.length && snapshot.observerId === "autonoxis-observer" && snapshot.observerHash === observerHash; });
        await accounting.outcome(attempt, { accepted, unresolved: false, validation: output, reason: accepted ? undefined : "pilot_terminal_rejected" });
        if (!accepted) throw new Error("pilot_terminal_rejected");
        accounting.assertAdmissible({ elapsedMs: Date.now() - startedAt });
      } catch (error) {
        if (attempt && !attempt.terminal) {
          const row = { arm, phase: "child", requestedModel: fixture.model, requestedThinking: "off", observedModel: null, status: "unresolved", usage: null, usageMissing: true, requestId, ownerRunId, nodeId, unresolved: true };
          await accounting.terminal(attempt, row); addUsage(row);
        }
        if (attempt && !attempt.outcome) await accounting.outcome(attempt, { accepted: false, error: error instanceof Error ? error.message : String(error), unresolved: !attempt.terminalRecord || attempt.terminalRecord.unresolved === true });
        throw error;
      } finally { ceiling.dispose(); observer.dispose(); }
    };
    const assistedRun = async (host, collector) => {
      const runtimeFixture = { ...fixture, cwd: host.cwd, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() }; delete runtimeFixture.pilot;
      const contract = JSON.stringify(runtimeFixture), contractPath = path.join(host.cwd, "autonoxis-pilot-contract.json"), contractHash = sha256(contract);
      await fsp.writeFile(contractPath, contract, { flag: "wx" });
      await fsp.writeFile(runtimeContractPath, contract, { flag: "wx" });
      const runtimeContract = { path: runtimeContractPath, sha256: contractHash };
      const command = `/autonoxis run ${contractPath} ${contractHash}`;
      const before = host.session.messages.length, providerBefore = { ...collector.providerRequests };
      admission();
      const transport = { requests: [], terminals: [] };
      const offRequest = host.eventBus.on(publicApi.delegation.SUBAGENT_DELEGATION_REQUEST_EVENT, value => { if (value?.agent === SOL_ACTOR && value?.task === fixture.nodes[0].task) transport.requests.push(value); });
      const offTerminal = host.eventBus.on(publicApi.delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, value => { if (value?.requestId) transport.terminals.push(value); });
      let commandFailure;
      const issued = await persistIssuesBeforeForward(accounting, [{ arm: "assisted", phase: "command", premium: false, commandHash: sha256(command), contractHash }, { arm: "assisted", phase: "child", premium: true, requestedModel: fixture.model, requestedThinking: "off", taskHash: sha256(fixture.nodes[0].task), contractHash, nodeId: fixture.nodes[0].id }], async () => { try { await host.session.prompt(command); } catch (error) { commandFailure = error; } finally { offRequest(); offTerminal(); } });
      const [commandAttempt, childAttempt] = issued.attempts;
      const messages = host.session.messages.slice(before), unexpectedUsage = normalizedUsage(messages), providerAfter = { ...collector.providerRequests };
      const countersMatch = countersEqual(providerBefore, providerAfter);
      const commandAccepted = await persistTerminalBeforeAcceptance(accounting, commandAttempt, { arm: "assisted", phase: "command", premium: false, status: commandFailure ? "failed" : "completed", usage: unexpectedUsage, usageMissing: unexpectedUsage === null, providerBefore, providerAfter, rawMessageCount: messages.length, transportRequests: transport.requests.length }, () => !commandFailure && messages.length === 0 && countersMatch);
      await accounting.outcome(commandAttempt, { accepted: commandAccepted, error: commandFailure instanceof Error ? commandFailure.message : commandFailure ? String(commandFailure) : undefined });
      const entries = host.sessionManager.getEntries();
      const terminalEntry = entries.filter(entry => entry.type === "custom" && entry.customType === "autonoxis-terminal" && entry.data?.contractHash === contractHash).at(-1);
      const complete = entries.find(entry => entry.type === "custom" && entry.customType === "autonoxis-state" && entry.data?.state === "COMPLETED" && entry.data?.contractHash === contractHash);
      const node = entries.find(entry => entry.type === "custom" && entry.customType === "autonoxis-node" && entry.data?.contractHash === contractHash);
      const noWakeEntry = entries.filter(entry => entry.type === "custom" && entry.customType === "autonoxis-state" && entry.data?.noWake).at(-1);
      const { matching, transportTerminal, identityMatch, row } = buildAssistedChildRow({ terminalEntry, transport, contractHash, node, hashText: sha256 });
      const accepted = await persistTerminalBeforeAcceptance(accounting, childAttempt, { ...row, unresolved: !(terminalEntry || transportTerminal) }, () => { addUsage(row); return !commandFailure && messages.length === 0 && countersMatch && transport.requests.length === 1 && matching.length === 1 && identityMatch && isApprovedSolIdentity(fixture.model, row.model, row.thinking) && row.model === row.preflight?.resolvedModel && (row.thinking === undefined || row.thinking === row.preflight?.thinking) && isApprovedSolIdentity(fixture.model, row.preflight?.resolvedModel, row.preflight?.thinking) && isFreshChildObserverSnapshot(row.observer) && !!terminalEntry && !!complete && !!node && !!noWakeEntry; });
      await accounting.outcome(childAttempt, { accepted, unresolved: false, validation: { ok: accepted, format_canonical: row.formatCanonical }, reason: accepted ? undefined : "assisted_plugin_run_rejected", transportRequestCount: transport.requests.length, transportTerminalCount: matching.length, terminalPresent: !!terminalEntry, completedPresent: !!complete, nodePresent: !!node, noWakePresent: !!noWakeEntry, unresolved: !(terminalEntry || transportTerminal) });
      if (!accepted) throw new Error("assisted_plugin_run_rejected");
      accounting.assertAdmissible({ elapsedMs: Date.now() - startedAt });
      return { contract, contractHash, runtimeContract, noWakeEntry, providerBefore, providerAfter, messagesBefore: before };
    };
    let baseline, assisted, baselineCollector, assistedCollector, assistedResult, pilotError;
    try {
      ensureRunRootPackage(runRoot);
      const hp1Host = await makeHost({ probe: true, cwd: await fsp.mkdtemp(path.join(os.tmpdir(), "pi-autonoxis-probe-")) });
      let hp1;
      try { const activeTools = hp1Host.session.getActiveToolNames(); if (activeTools.includes("autonoxis_probe_tool")) throw new Error("hp1_active_tool_falsified"); hp1 = { piLevelOnly: true, activeTools }; } finally { await hp1Host.dispose(); }
      baseline = await makeHost({ cwd: runRoot }); baselineCollector = activateObserverCollector(baseline);
      await parentPrompt(baseline, "baseline", "parent-1", fixture.pilot.baselineInstruction);
      await parentPrompt(baseline, "baseline", "parent-2", fixture.nodes[0].task);
      await delegate(baseline, "baseline");
      assisted = await makeHost({ cwd: runRoot }); assistedCollector = activateObserverCollector(assisted);
      await parentPrompt(assisted, "assisted", "setup", "Reply with exactly OBSERVER_OK.");
      assistedResult = await assistedRun(assisted, assistedCollector);
      accounting.assertResolved();
      await finalEvidence({ status: "PILOT_COMPLETE", ...hostRecord, fixtureHash: sha256(fixtureBytes), pinnedAgentDefinitionDigest: fixture.agentDefinitionDigest, pinnedAgentDefinitionProjectionVersion: fixture.agentDefinitionProjectionVersion, startedAt: new Date(startedAt).toISOString(), elapsedMs: Date.now() - startedAt, usage, premiumAttemptsObserved: usage.length, evidenceReservation: accounting.reservation, attemptArtifacts: accounting.artifacts, runtimeContractHash: assistedResult.contractHash, runtimeContract: assistedResult.runtimeContract, hp1, providerRequests: { baseline: baselineCollector.providerRequests, assisted: assistedCollector.providerRequests }, accounting: { price: "UNKNOWN", savings: "NOT_CALCULATED", setupContextCacheConfound: true }, noWake: { assistedCommandAddedMessages: assisted.session.messages.length - assistedResult.messagesBefore, providerRequests: assistedResult.noWakeEntry.data.noWake.providerRequests, graceMs: assistedResult.noWakeEntry.data.noWake.graceMs }, limits: fixture.pilot });
      console.log("PILOT_COMPLETE");
    } catch (error) {
      pilotError = error;
      try {
        await finalEvidence({ status: "PILOT_FAILED", ...hostRecord, fixtureHash: sha256(fixtureBytes), elapsedMs: Date.now() - startedAt, usage, premiumAttemptsObserved: usage.length, evidenceReservation: accounting.reservation, attemptArtifacts: accounting.artifacts, error: error instanceof Error ? error.message : String(error), limits: fixture.pilot });
      } catch (writeError) {
        if (error && typeof error === "object") error.finalEvidenceWriteError = writeError instanceof Error ? writeError.message : String(writeError);
        else console.error(`pilot_final_evidence_write_failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
      }
      throw error;
    } finally {
      const failures = await settleHostDisposals([baseline, assisted]);
      if (failures.length) {
        if (pilotError && typeof pilotError === "object") pilotError.cleanupErrors = failures.map(String);
        else throw new AggregateError(failures, "pilot_host_cleanup_failed");
      }
    }
  }
}
