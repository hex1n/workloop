import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(".");
const files = ["README.md", "skills/loop-core/REFERENCE.md", "skills/loop-core/ADAPTERS.md", "skills/loop-core/HOSTS.md", "skills/workloop/SKILL.md", "skills/judgmentloop/SKILL.md"];

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
  assert.match(joined, /~\/\.taskloop\/outcomes-v2\.jsonl/);
  assert.doesNotMatch(joined, /~\/\.taskloop\/outcomes(?:-v1)?\.jsonl/);
});

test("workloop remains task-facing and delegates shared semantics to loop-core", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/workloop/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/loop-core\/REFERENCE\.md/);
  assert.match(skill, /--criterion-policy/);
  assert.match(skill, /achieve/);
  assert.doesNotMatch(skill, /source-project|session id|\/Users\//);
});

test("judgmentloop remains task-facing and delegates shared semantics to loop-core", () => {
  const skill = fs.readFileSync(path.join(ROOT, "skills/judgmentloop/SKILL.md"), "utf8");
  assert.match(skill, /\.\.\/loop-core\/REFERENCE\.md/);
  assert.match(skill, /\.\.\/loop-core\/ADAPTERS\.md/);
  assert.match(skill, /steady-satisfied/);
  assert.match(skill, /achieve/);
  assert.doesNotMatch(skill, /source-project|session id|\/Users\//);
});

test("adapter contract maps exit 0, 1, 2 to canonical observations", () => {
  const adapter = fs.readFileSync(path.join(ROOT, "skills/loop-core/ADAPTERS.md"), "utf8");
  assert.match(adapter, /exit 0[^\n]+satisfied/i); assert.match(adapter, /exit 1[^\n]+unsatisfied/i); assert.match(adapter, /exit 2[^\n]+indeterminate/i);
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
