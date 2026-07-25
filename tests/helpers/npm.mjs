// npm has to be invoked as JavaScript, not as a command name.
//
// On Windows the thing on PATH is `npm.cmd`, and since Node closed the
// argument-injection hole it refuses to spawn a `.cmd` without a shell — so
// `spawnSync("npm", …)` fails there and nowhere else, which is the shape of
// defect this project keeps finding: correct on the machine it was written on,
// broken on the one it was never run on. Running npm's own entry point under
// this process's `node` needs no shell, and therefore no quoting rules and no
// console codepage.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const realOf = (value) => {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
};

function* candidates() {
  // Set when the gate is driven by `npm test`; absent under bare `node --test`,
  // which is the documented gate — so it can only ever be the first guess.
  if (process.env.npm_execpath) yield process.env.npm_execpath;

  // The two layouts a Node distribution ships: npm beside the binary (Windows)
  // or one level up under lib/ (POSIX).
  const nodeDir = path.dirname(process.execPath);
  yield path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  yield path.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

  // Neither layout holds when the two are installed apart — homebrew keeps node
  // under Cellar and npm under the prefix. The shim on PATH resolves to the
  // entry point itself on POSIX; on Windows it sits beside the `.cmd`.
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    for (const name of ["npm", "npm.cmd"]) {
      const real = realOf(path.join(directory, name));
      if (!real) continue;
      if (real.endsWith(".js")) yield real;
      yield path.join(path.dirname(real), "node_modules", "npm", "bin", "npm-cli.js");
    }
  }
}

let cached = null;

export function npmCliPath() {
  if (cached) return cached;
  for (const candidate of candidates()) {
    if (candidate.endsWith(".js") && fs.existsSync(candidate)) {
      cached = candidate;
      return cached;
    }
  }
  // Fail closed. A gate that quietly skips when it cannot find npm reports
  // green for a release nobody packed.
  throw new Error("no npm entry point found: searched npm_execpath, the node distribution layout, and PATH");
}

export function npm(args, options = {}) {
  return spawnSync(process.execPath, [npmCliPath(), ...args], { encoding: "utf8", ...options });
}
