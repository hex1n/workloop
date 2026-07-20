#!/usr/bin/env node
// Removes what install.mjs placed under the current user's home, and nothing
// else. Ownership is proven against the managed-skills manifest before any
// delete, so an edited or externally taken-over skill tree is preserved and
// reported rather than removed. The cross-repository outcome ledger under
// ~/.workloop is the owner's audit history, not an install artifact, so it
// survives unless --purge-ledger says otherwise.
//
// Host bindings (Claude settings.json, Codex hooks.json and config.toml) are
// owner-managed: this reports that they still reference workloop instead of
// editing files it did not write.
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { reportActions, uninstallWorkloop } from "./install.mjs";

const HOME = path.resolve(process.env.WORKLOOP_INSTALL_HOME ?? os.homedir());
const FLAGS = new Set(["--dry-run", "--purge-ledger"]);

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !FLAGS.has(arg))) {
    process.stderr.write("usage: node uninstall.mjs [--dry-run] [--purge-ledger]\n");
    return 2;
  }
  const dry = args.includes("--dry-run");
  uninstallWorkloop(HOME, dry, { purgeLedger: args.includes("--purge-ledger") });
  return reportActions(`workloop uninstall ${dry ? "(dry run) " : ""}from ${HOME}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
