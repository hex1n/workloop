import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_ROOT = path.join(ROOT, "tests", "fixtures", "host-hook-capabilities");
const FORBIDDEN_KEYS = new Set([
  "code",
  "command",
  "path",
  "prompt",
  "session_id",
  "tool_input",
  "tool_response",
  "transcript",
]);

function visit(value, at = "fixture") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${at}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    assert.equal(FORBIDDEN_KEYS.has(key), false, `${at}.${key} is privacy-sensitive`);
    visit(item, `${at}.${key}`);
  }
}

test("host capability fixtures are versioned, conservative, and privacy-safe", () => {
  const names = fs.readdirSync(FIXTURE_ROOT).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(names, ["claude-code.json", "codex-app.json", "codex-cli.json"]);

  const ids = new Set();
  for (const name of names) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, name), "utf8"));
    visit(fixture, name);
    assert.equal(fixture.schema_version, 1, name);
    assert.match(fixture.capability_id, /^hostcap:v1:[a-z0-9._-]+$/u, name);
    assert.equal(ids.has(fixture.capability_id), false, `${name} duplicates a capability id`);
    ids.add(fixture.capability_id);
    assert.match(fixture.sanitized_at, /^\d{4}-\d{2}-\d{2}T/u, name);
    assert.ok(["verified", "degraded", "unverified"].includes(fixture.verification), name);
    assert.equal(typeof fixture.exhaustive_surface, "boolean", name);
    if (fixture.verification !== "verified") assert.equal(fixture.exhaustive_surface, false, name);
    assert.ok(Array.isArray(fixture.observations) && fixture.observations.length > 0, name);
    for (const observation of fixture.observations) {
      assert.ok(["success", "failure", "nonzero", "pending"].includes(observation.outcome), `${name}: outcome`);
      assert.ok([true, false, "unknown"].includes(observation.pre_observed), `${name}: PreToolUse`);
      assert.ok([true, false, "unknown"].includes(observation.post_observed), `${name}: PostToolUse`);
      assert.ok([true, false, "unknown"].includes(observation.failure_observed), `${name}: failure hook`);
      assert.ok(["exact", "tool_specific", "reconciled", "unknown"].includes(observation.receipt_quality), `${name}: receipt quality`);
    }
  }
});
