import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolvePinnedPiEntry(env = process.env) {
  const explicit = env.PI_AUTONOXIS_PI_ENTRY;
  if (explicit && !path.isAbsolute(explicit)) throw new Error("pi_entry_unresolved: PI_AUTONOXIS_PI_ENTRY must be absolute");
  const candidates = explicit ? [explicit] : [env.npm_config_prefix && path.join(env.npm_config_prefix, "lib", "node_modules"), path.join(os.homedir(), ".npm-global", "lib", "node_modules"), "/usr/local/lib/node_modules", "/usr/lib/node_modules"].filter(Boolean).map(root => path.join(root, "@earendil-works", "pi-coding-agent", "dist", "index.js"));
  const found = [...new Set(candidates)].filter(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (found.length !== 1) throw new Error("pi_entry_unresolved: set PI_AUTONOXIS_PI_ENTRY to one pinned public dist/index.js");
  const entry = found[0], packageJson = path.join(path.dirname(entry), "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(packageJson, "utf8"));
  if (pkg.name !== "@earendil-works/pi-coding-agent" || pkg.version !== "0.85.1") throw new Error("pi_entry_unresolved: pinned Pi 0.85.1 required; set PI_AUTONOXIS_PI_ENTRY");
  return { entry, package: pkg };
}
