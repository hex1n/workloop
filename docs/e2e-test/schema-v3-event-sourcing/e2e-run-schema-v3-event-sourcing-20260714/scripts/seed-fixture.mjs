import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = path.join(runDir, "fixture");
const repo = path.join(fixture, "repo");
const home = path.join(fixture, "home");
const marker = path.join(fixture, ".schema-v3-e2e-owner");

if (!fs.existsSync(marker)) {
  if (fs.existsSync(fixture)) throw new Error(`refusing to claim existing unmarked fixture: ${fixture}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(marker, "schema-v3-e2e-20260714\n");
  fs.writeFileSync(path.join(repo, "check.mjs"), "import fs from 'node:fs'; process.exit(fs.existsSync('done') ? 0 : 1);\n");
  fs.writeFileSync(path.join(repo, "work.txt"), "start\n");
  const commands = [
    ["git", ["init", "-q"]],
    ["git", ["add", "."]],
    ["git", ["-c", "user.name=schema-v3-e2e", "-c", "user.email=e2e@example.invalid", "commit", "-qm", "schema-v3-e2e fixture"]],
  ];
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, { cwd: repo, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`);
  }
}

process.stdout.write(`${JSON.stringify({ owner: "schema-v3-e2e-20260714", fixture, repo, home, marker })}\n`);
