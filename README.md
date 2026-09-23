# Autonoxis for Pi

An experimental [Pi](https://github.com/badlogic/pi-mono) extension that uses the local `autonoxis-conductor:14b` classifier to gate a **single, human-authored** sequence of tools-free Sol subagent tasks. It adds `/autonoxis run <contract-path> <sha256>`, `/autonoxis status [run-id]`, and `/autonoxis stop [run-id]`. This is **not** the `jev-claude-orchestrator` Claude Code plugin.

## Try the install

Prerequisites: Pi **0.85.1**, `pi-subagents` **0.68.0** installed at user scope, Node.js with `node --test`, and Git. For actual runs you also need `openai-codex/gpt-5.6-sol` available in Pi and an Ollama model named `autonoxis-conductor:14b`. The model is **not** downloaded by this package. Do not install a second project-scoped `pi-subagents` alongside the user-scoped one.

```sh
# If pi-subagents is not already installed at user scope:
pi install npm:pi-subagents@0.68.0

# Preview ONLY if this package is not already installed:
pi -e git:github.com/damian87x/autonoxis@v0.1.2
# In Pi: /autonoxis status → "No active Autonoxis run."

# To install persistently at user scope:
pi install git:github.com/damian87x/autonoxis@v0.1.2
# Thereafter start Pi normally: pi
# In Pi: /autonoxis status → "No active Autonoxis run."
```

**Choose one loading method per session.** If `pi list` already shows `git:github.com/damian87x/autonoxis`, use `pi`, **not** `pi -e git:github.com/damian87x/autonoxis`: loading it twice makes Pi rename the commands `/autonoxis:1` and `/autonoxis:2`. Bare `/autonoxis status` then falls through to the LLM instead of the extension, potentially incurring cost. Exit that Pi session and restart with `pi` alone. The status response means the extension loaded and is idle; it does **not** demonstrate delegation. Do not try bare `/autonoxis run` as a smoke test—it requires a contract path and hash.

The one-session preview still runs package code. Review the source before installing. `pi install` changes your user-level Pi settings; the commands above are instructions for you, not actions performed by this repository. To remove the persistent install: `pi remove git:github.com/damian87x/autonoxis@v0.1.2`.

This package is intentionally pinned to the above Pi and pi-subagents versions and the exact `openai-codex/gpt-5.6-sol:off` child identity. Other versions or models fail closed. It neither installs nor configures Pi, pi-subagents, Sol, or Ollama for you. It does not provide autonomous planning: a `run` needs a fresh, human-approved, finite v2 JSON contract under the intended working directory, that file's SHA-256, an unexpired authority, and a package-agent digest resolved for that root. A contract hash can be used once. **Do not try `/autonoxis run` until you have deliberately prepared such a contract and accepted premium inference.** `/autonoxis stop` revokes one run; it is not a general-purpose supervisor.

## Local no-inference checks

From a clone of this repository, on a machine with the pinned Pi and pi-subagents already installed:

```sh
node --test test/*.test.mjs
RUN_ROOT="$(mktemp -d)"
PI_SUBAGENTS_LLM_INTENT_ARBITER=0 node test/native-harness.mjs print-agent-identity --run-root "$RUN_ROOT"
```

The tests include public Pi preflight checks but no premium child inference. `test/native-harness.mjs` also contains pilot and ledger modes for **separately authorized** bounded certification, not a quickstart. Do not run a pilot merely to check installation. Three prior pilots failed certification; no fourth pair is authorized by this release. Classifier parity on 48 frozen cases is narrow evidence, **not** production safety or cost-savings proof. Pricing remains `UNKNOWN`; savings remain `NOT_CALCULATED`.

The published LoRA is separate: [autonoxis-conductor-qwen3-14b-lora](https://huggingface.co/damianborek/autonoxis-conductor-qwen3-14b-lora). It is not a ready-to-use Ollama download. This public code repository includes no model weights, API credentials, private pilot receipts, or historical workspace data.
