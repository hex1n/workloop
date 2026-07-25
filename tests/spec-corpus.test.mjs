// Spec-integrity gate. There is no runtime yet: the only thing this repository
// can currently be wrong about is its own specification, so that is what the
// gate checks. Slice 1 adds the log-kernel property tests alongside this file.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const SCENARIOS = path.resolve(import.meta.dirname, "..", "greenfield", "scenarios");
const files = fs.readdirSync(SCENARIOS).filter((name) => /^\d\d-.*\.md$/u.test(name)).sort();
const read = (name) => fs.readFileSync(path.join(SCENARIOS, name), "utf8");
const scenarioCount = (text) => text.split("\n").filter((line) => line.startsWith("### ")).length;

test("every scenario family file carries scenarios and an audit disposition", () => {
  assert.ok(files.length > 0, "scenario corpus is missing");
  for (const name of files) {
    const text = read(name);
    assert.ok(scenarioCount(text) > 0, `${name} declares no scenarios`);
    assert.match(text, /\*\*审计处置\*\*/u, `${name} has no audit disposition block`);
  }
});

test("audit totals match the corpus, so the two cannot drift apart", () => {
  const audit = read("AUDIT-2026-07-25.md");
  const total = audit.match(/\|\s*\*\*合计\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/u);
  assert.ok(total, "audit summary row is unreadable");
  const [retained, rewritten, dropped] = total.slice(1).map(Number);
  const declared = retained + rewritten + dropped;
  const actual = files.reduce((sum, name) => sum + scenarioCount(read(name)), 0);
  assert.equal(declared, actual, `audit accounts for ${declared} scenarios but the corpus has ${actual}`);
});

test("the design the corpus specifies is present and names the corpus", () => {
  const design = fs.readFileSync(path.resolve(import.meta.dirname, "..", "docs", "plans", "2026-07-25-greenfield-redesign.md"), "utf8");
  assert.match(design, /greenfield\/scenarios/u, "design does not point at the scenario corpus");
  assert.match(read("README.md"), /AUDIT-2026-07-25/u, "corpus README does not point at its audit");
});

test("no source file is binary, so nothing can hide from review", () => {
  // A stray control byte once made src/domain/criterion.mjs read as binary to
  // git and grep, which meant two review rounds never saw it. The gate now
  // refuses that class of invisibility outright.
  const root = path.resolve(import.meta.dirname, "..");
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : walk(full);
    return entry.name.endsWith(".mjs") || entry.name.endsWith(".md") || entry.name.endsWith(".json") ? [full] : [];
  });
  for (const file of [...walk(path.join(root, "src")), ...walk(path.join(root, "tests")), ...walk(path.join(root, "greenfield"))]) {
    assert.equal(fs.readFileSync(file).includes(0), false, `${path.relative(root, file)} contains a NUL byte`);
  }
});
