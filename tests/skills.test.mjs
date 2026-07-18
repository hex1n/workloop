import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");
const files = ["README.md", "skills/loop-core/REFERENCE.md", "skills/loop-core/ADAPTERS.md", "skills/loop-core/HOSTS.md", "skills/workloop/SKILL.md", "skills/judgmentloop/SKILL.md", "skills/meta-loop/SKILL.md"];

test("portable skill closure has no dangling relative markdown links", () => {
  for (const rel of files.filter((x) => x.startsWith("skills/"))) {
    const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
    for (const match of body.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)#]+)(?:#[^)]+)?\)/g)) assert.ok(fs.existsSync(path.resolve(ROOT, path.dirname(rel), match[1])), `${rel} -> ${match[1]}`);
  }
});

test("public docs and skills use the canonical observation/lifecycle/policy vocabulary", () => {
  const joined = files.map((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8")).join("\n");
  for (const token of ["unsatisfied", "satisfied", "indeterminate", "active", "suspended", "terminal", "deferred_witness", "steady_satisfied", "criterion_generation_id"]) assert.match(joined, new RegExp(token));
  assert.doesNotMatch(joined, /--earn-red|--keep-green|\bearn_red\b|\bred_witnessed\b|\bkeep_green\b|\bstate: done\b/);
  assert.match(joined, /~\/\.taskloop\/outcomes\.jsonl/);
  assert.doesNotMatch(joined, /~\/\.taskloop\/outcomes-v\d+\.jsonl/);
});

test("workloop remains task-facing and delegates shared semantics to loop-core", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/workloop/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/loop-core\/REFERENCE\.md/);
  assert.match(skill, /--criterion-policy/);
  assert.match(skill, /--criterion-authored-by/);
  assert.match(skill, /achieve/);
  assert.doesNotMatch(skill, /source-project|session id|\/Users\//);
});

test("criterion authorship and grant provenance are separate public controls", () => {
  const reference = fs.readFileSync(path.join(ROOT, "skills/loop-core/REFERENCE.md"), "utf8");
  const help = fs.readFileSync(path.join(ROOT, "lib/application.mjs"), "utf8");
  assert.match(reference, /Criterion authorship uses its own `--criterion-authored-by/);
  assert.match(reference, /--granted-by.*reserved for grant, waiver, and risk/);
  assert.match(help, /--criterion-authored-by self\|user/);
});

test("judgmentloop remains task-facing and delegates shared semantics to loop-core", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/judgmentloop/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/loop-core\/REFERENCE\.md/);
  assert.match(skill, /\.\.\/loop-core\/ADAPTERS\.md/);
  assert.match(skill, /steady-satisfied/);
  assert.match(skill, /achieve/);
  assert.doesNotMatch(skill, /source-project|session id|\/Users\//);
});

test("adapter contract reserves dedicated tri-state exits and treats zero as silence", () => {
  const adapter = fs.readFileSync(path.join(ROOT, "skills/loop-core/ADAPTERS.md"), "utf8");
  assert.match(adapter, /exit 4[^\n]+satisfied/i); assert.match(adapter, /exit 3[^\n]+unsatisfied/i); assert.match(adapter, /exit 2[^\n]+indeterminate/i); assert.match(adapter, /exit 0[^\n]+(?:indeterminate|silent)/i);
  assert.match(adapter, /one-time v3 cutover/); assert.match(adapter, /signature.*null/); assert.match(adapter, /seven-attempt guard/);
});

test("meta-loop ships a human-gated monthly incremental reminder binding", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/meta-loop/SKILL.md"), "utf8");
  const reminder = fs.readFileSync(path.join(ROOT, "skills/meta-loop/REMINDER.md"), "utf8");
  assert.match(skill, /monthly reminder/); assert.match(skill, /incremental terminal and abandoned/); assert.match(skill, /never unattended/);
  assert.match(reminder, /taskloop ledger --json/); assert.match(reminder, /newTerminal/); assert.match(reminder, /newAbandoned/); assert.match(reminder, /msg \* \$message/);
});

test("every CLI verb named by a portable skill exists in runtime help", () => {
  const help = fs.readFileSync(path.join(ROOT, "lib/application.mjs"), "utf8");
  const joined = files.filter((file) => file.endsWith("SKILL.md")).map((file) => fs.readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  for (const verb of ["open", "status", "verify", "achieve", "review", "ledger", "sync-outcomes"]) if (new RegExp(`taskloop ${verb}\\b`).test(joined)) assert.match(help, new RegExp(`\\b${verb}\\b`));
});

test("release sources contain no removed public-domain vocabulary", () => {
  const releaseFiles = ["lib", "skills", "README.md"].flatMap((rel) => {
    const absolute = path.join(ROOT, rel); if (fs.statSync(absolute).isFile()) return [absolute];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    return walk(absolute);
  }).filter((file) => /\.(?:mjs|md)$/.test(file));
  const offenders = [];
  for (const file of releaseFiles) {
    const body = fs.readFileSync(file, "utf8");
    if (/--earn-red|--keep-green|\bearn_red\b|\bred_witnessed\b|\bkeep_green\b|\bstate: done\b|weak_sensor_unreviewed|--provisional|outcomes-v1\.jsonl/.test(body)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, []);
});
