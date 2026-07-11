import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { legacySkillCanBeAdopted } from "../install.mjs";

const ROOT = path.resolve(".");
const SKILLS = [
  "loop-core",
  "workloop",
];
const NON_CORE_SKILLS = [
  "converge",
  "first-principles-planner",
  "judgment-loop",
  "meta-loop",
  "project-docs-layer",
];

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).sort().flatMap((name) => {
    const file = path.join(root, name);
    return fs.statSync(file).isDirectory() ? walk(file) : [file];
  });
}

test("the loop skill closure is repository-owned and has no dangling local links", () => {
  for (const skill of SKILLS) {
    const root = path.join(ROOT, "skills", skill);
    assert.ok(fs.existsSync(root), `missing skills/${skill}`);
    for (const file of walk(root).filter((candidate) => candidate.endsWith(".md"))) {
      const source = fs.readFileSync(file, "utf8");
      for (const match of source.matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
        const target = match[1].split("#", 1)[0];
        if (!target || /[<>{}*]/.test(target)) continue;
        assert.ok(
          fs.existsSync(path.resolve(path.dirname(file), target)),
          `${path.relative(ROOT, file)} has dangling link ${match[1]}`,
        );
      }
    }
  }
  for (const skill of NON_CORE_SKILLS) {
    assert.equal(fs.existsSync(path.join(ROOT, "skills", skill)), false, `non-core skill shipped: ${skill}`);
  }
  assert.equal(walk(path.join(ROOT, "tools")).length, 0, "taskloop must not ship skill-specific tools");
  const coreText = SKILLS.flatMap((skill) => walk(path.join(ROOT, "skills", skill)))
    .filter((file) => file.endsWith(".md"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
  for (const fixed of ["e2e-test-executor", "e2e-report-check", ...NON_CORE_SKILLS]) {
    assert.equal(coreText.includes(fixed), false, `core is coupled to ${fixed}`);
  }
});

test("loop-core ships host binding recipes earned from the dual-host spike", () => {
  const hosts = fs.readFileSync(path.join(ROOT, "skills", "loop-core", "HOSTS.md"), "utf8");
  // A driver's stop condition must treat suspension as "stop", not "push again".
  assert.match(hosts, /terminal state or suspends/i);
  // Codex's default sandbox splits the write surface at the ledger home.
  assert.match(hosts, /--add-dir/);
  assert.match(hosts, /--configure-codex/);
  assert.match(hosts, /~\/\.taskloop/);
  // The recipe names the exact degradation signal the runtime emits, so the
  // doc and the code cannot drift apart silently.
  const signal = "outcome ledger append failed";
  assert.ok(hosts.includes(signal), "HOSTS.md must name the ledger degradation signal");
  assert.ok(
    fs.readFileSync(path.join(ROOT, "lib", "outcome-ledger.mjs"), "utf8").includes(signal),
    "outcome-ledger.mjs no longer emits the signal HOSTS.md documents",
  );
  // Hooks configuration wants a single source, not parallel layers.
  assert.match(hosts, /hooks\.json/);
  assert.match(hosts, /config\.toml/);
  // Rung-1 findings stay anchored: sandbox tiers and headless containment.
  assert.match(hosts, /read-only/);
  assert.match(hosts, /container/);
  const refusal = "cannot write task state";
  assert.ok(hosts.includes(refusal), "HOSTS.md must name the read-only refusal signal");
  assert.ok(
    fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8").includes(refusal),
    "application.mjs no longer emits the refusal HOSTS.md documents",
  );
  // Discoverable from the skill entry, not an orphan file.
  assert.match(
    fs.readFileSync(path.join(ROOT, "skills", "workloop", "SKILL.md"), "utf8"),
    /HOSTS\.md/,
  );
});

test("loop-core states the structural-task criterion principle", () => {
  const ref = fs.readFileSync(path.join(ROOT, "skills", "loop-core", "REFERENCE.md"), "utf8");
  // The principle, not a command cookbook: a structural criterion must assert
  // the whole move (removal + no live reference + new positioning).
  assert.match(ref, /## Structural Tasks/i);
  assert.match(ref, /whole\b.*\bmove/i);
  assert.match(ref, /removal/i);
  assert.match(ref, /reference/i);
  // The read-only __pycache__ trap lives with the adapter's read-only rule, its
  // single source, not restated in the reference.
  const adapters = fs.readFileSync(path.join(ROOT, "skills", "loop-core", "ADAPTERS.md"), "utf8");
  assert.match(adapters, /PYTHONDONTWRITEBYTECODE=1/);
});

test("loop-core documents the criterion-subject exemption the CLI actually enforces", () => {
  const ref = fs.readFileSync(path.join(ROOT, "skills", "loop-core", "REFERENCE.md"), "utf8");
  // Named as an explicit trust grant, not an inference — the exact distinction
  // that separates it from the withdrawn auto-classifier.
  assert.match(ref, /--criterion-subject/);
  assert.match(ref, /trust grant, never an inference/i);
  assert.match(ref, /necessary but not sufficient/i);
  // Doc and code cannot drift: the acceptance banner the reference promises must
  // be a string the application layer actually emits.
  const app = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.ok(
    app.includes("declared work subject changed (drift exemption exercised"),
    "application.mjs no longer emits the subject-exemption banner REFERENCE documents",
  );
});

test("loop-core states the earn-red invariant the CLI enforces", () => {
  const ref = fs.readFileSync(path.join(ROOT, "skills", "loop-core", "REFERENCE.md"), "utf8");
  assert.match(ref, /--earn-red/);
  // The invariant, not just the flag: a witnessed red is required, not a red at open.
  assert.match(ref, /witnessed red at least once/i);
  assert.match(ref, /barred/i);
  // Doc and code cannot drift: the close-bar message must be one the CLI emits.
  const app = fs.readFileSync(path.join(ROOT, "lib", "application.mjs"), "utf8");
  assert.ok(
    app.includes("has not been witnessed red on this task"),
    "application.mjs no longer emits the earn-red close-bar REFERENCE documents",
  );
});

test("installer distributes only the workloop core to both agent runtimes", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASKLOOP_INSTALL_REPO: ROOT,
      TASKLOOP_INSTALL_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const runtime of [".claude", ".codex"]) {
    for (const skill of SKILLS) {
      assert.ok(
        fs.existsSync(path.join(home, runtime, "skills", skill)),
        `${runtime} is missing ${skill}`,
      );
    }
  }
  for (const skill of NON_CORE_SKILLS) {
    for (const runtime of [".claude", ".codex"]) {
      assert.equal(fs.existsSync(path.join(home, runtime, "skills", skill)), false);
    }
  }
});

test("installer treats aliased Claude and Codex skill roots as one owned tree", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-shared-root-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const shared = path.join(home, ".agents", "skills");
  fs.mkdirSync(shared, { recursive: true });
  for (const runtime of [".claude", ".codex"]) {
    const parent = path.join(home, runtime);
    fs.mkdirSync(parent, { recursive: true });
    try {
      fs.symlinkSync(shared, path.join(parent, "skills"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
      t.skip("directory symlinks are unavailable");
      return;
    }
  }
  const result = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASKLOOP_INSTALL_REPO: ROOT,
      TASKLOOP_INSTALL_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(home, "bin", ".taskloop-managed-skills.json"), "utf8"),
  );
  assert.deepEqual(manifest.runtimes[".claude"], manifest.runtimes[".codex"]);
  for (const skill of SKILLS) assert.ok(fs.existsSync(path.join(shared, skill)));
});

test("installer adopts only byte-exact legacy core trees", (t) => {
  assert.equal(
    legacySkillCanBeAdopted(
      "workloop",
      "3dcb2d46005915b1ccd4aa41d6de8b5fb365e9527e4d6da1930707be5ea46281",
      false,
      "different",
    ),
    true,
  );
  assert.equal(legacySkillCanBeAdopted("workloop", "0".repeat(64), false, "different"), false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-v1-adopt-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const runtime of [".claude", ".codex"]) {
    for (const skill of SKILLS) {
      fs.cpSync(
        path.join(ROOT, "skills", skill),
        path.join(home, runtime, "skills", skill),
        { recursive: true },
      );
    }
  }
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "bin", ".taskloop-managed-skills.json"),
    JSON.stringify({ version: 1, skills: SKILLS }) + "\n",
  );
  const result = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASKLOOP_INSTALL_REPO: ROOT,
      TASKLOOP_INSTALL_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(home, "bin", ".taskloop-managed-skills.json"), "utf8"),
  );
  assert.equal(manifest.version, 2);
  for (const runtime of [".claude", ".codex"]) {
    for (const skill of SKILLS) assert.match(manifest.runtimes[runtime][skill], /^[a-f0-9]{64}$/);
  }
});

test("installer replaces source-linked skills with managed copies", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-delink-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Keep both ends of the hard link inside the temporary filesystem. Some
  // sandboxes correctly reject linking a workspace inode into the system temp
  // directory even when both paths are writable to the current process.
  const fixture = path.join(home, "repo");
  fs.mkdirSync(fixture, { recursive: true });
  fs.copyFileSync(path.join(ROOT, "install.mjs"), path.join(fixture, "install.mjs"));
  for (const directory of ["bin", "lib", "skills"]) {
    fs.cpSync(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  const source = path.join(fixture, "skills", "workloop");
  const target = path.join(home, ".codex", "skills", "workloop");
  const env = {
    ...process.env,
    TASKLOOP_INSTALL_REPO: fixture,
    TASKLOOP_INSTALL_HOME: home,
    HOME: home,
    USERPROFILE: home,
  };
  const first = spawnSync(process.execPath, [fs.realpathSync(path.join(fixture, "install.mjs"))], {
    cwd: fixture,
    env,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target);
  fs.linkSync(path.join(source, "SKILL.md"), path.join(target, "SKILL.md"));

  const result = spawnSync(process.execPath, [fs.realpathSync(path.join(fixture, "install.mjs"))], {
    cwd: fixture,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const sourceStat = fs.statSync(path.join(source, "SKILL.md"), { bigint: true });
  const targetStat = fs.statSync(path.join(target, "SKILL.md"), { bigint: true });
  assert.notEqual(
    `${sourceStat.dev}:${sourceStat.ino}`,
    `${targetStat.dev}:${targetStat.ino}`,
    result.stdout,
  );
  assert.equal(
    fs.readFileSync(path.join(target, "SKILL.md"), "utf8"),
    fs.readFileSync(path.join(source, "SKILL.md"), "utf8"),
  );
});

test("installer refuses unowned skill trees without following their links", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-safe-replace-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const skillTarget = path.join(home, ".codex", "skills", "workloop");
  const externalSkill = path.join(home, "external-skill.md");
  fs.mkdirSync(skillTarget, { recursive: true });
  fs.writeFileSync(path.join(skillTarget, "stale.md"), "must disappear\n");
  fs.writeFileSync(externalSkill, "private skill target\n");
  let linksSupported = true;
  try {
    fs.symlinkSync(externalSkill, path.join(skillTarget, "SKILL.md"));
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    linksSupported = false;
    fs.rmSync(path.join(skillTarget, "SKILL.md"), { force: true });
  }

  const result = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASKLOOP_INSTALL_REPO: ROOT,
      TASKLOOP_INSTALL_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(skillTarget, "stale.md")), true);
  if (linksSupported) {
    assert.equal(fs.lstatSync(path.join(skillTarget, "SKILL.md")).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(externalSkill, "utf8"), "private skill target\n");
  }
});

test("installer prunes skill directories it previously owned", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-prune-"));
  const home = path.join(root, "home");
  const fixture = path.join(root, "repo");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["bin", "lib", "skills"]) {
    fs.cpSync(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  const env = {
    ...process.env,
    TASKLOOP_INSTALL_REPO: fixture,
    TASKLOOP_INSTALL_HOME: home,
    HOME: home,
    USERPROFILE: home,
  };
  const first = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  fs.rmSync(path.join(fixture, "skills", "workloop"), { recursive: true, force: true });
  const second = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  for (const runtime of [".claude", ".codex"]) {
    assert.equal(fs.existsSync(path.join(home, runtime, "skills", "workloop")), false);
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(home, "bin", ".taskloop-managed-skills.json"), "utf8"),
  );
  assert.equal(manifest.runtimes[".claude"].workloop, undefined);
  assert.equal(manifest.runtimes[".codex"].workloop, undefined);
});

test("installer preserves and releases a removed skill taken over after installation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-skills-takeover-"));
  const home = path.join(root, "home");
  const fixture = path.join(root, "repo");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["bin", "lib", "skills"]) {
    fs.cpSync(path.join(ROOT, directory), path.join(fixture, directory), { recursive: true });
  }
  const env = {
    ...process.env,
    TASKLOOP_INSTALL_REPO: fixture,
    TASKLOOP_INSTALL_HOME: home,
    HOME: home,
    USERPROFILE: home,
  };
  const first = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const takenOver = path.join(home, ".codex", "skills", "workloop", "SKILL.md");
  fs.appendFileSync(takenOver, "\nuser-owned extension\n");
  fs.rmSync(path.join(fixture, "skills", "workloop"), { recursive: true, force: true });

  const second = spawnSync(process.execPath, [path.join(ROOT, "install.mjs")], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills", "workloop")), false);
  assert.match(fs.readFileSync(takenOver, "utf8"), /user-owned extension/);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(home, "bin", ".taskloop-managed-skills.json"), "utf8"),
  );
  assert.equal(manifest.runtimes[".codex"].workloop, undefined);
});

function runInstaller(home, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, "install.mjs"), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      TASKLOOP_INSTALL_REPO: ROOT,
      TASKLOOP_INSTALL_HOME: home,
      HOME: home,
      USERPROFILE: home,
    },
    encoding: "utf8",
  });
}

test("installer warns when Codex cannot write the outcome ledger without taking over config", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-warning-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = '# user-owned\nmodel = "gpt-test"\nsandbox_mode = "workspace-write"\n';
  fs.writeFileSync(config, original);

  const result = runInstaller(home, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /warning\s+Codex outcome ledger binding is missing/i);
  assert.match(result.stdout, /--configure-codex/);
  assert.equal(fs.readFileSync(config, "utf8"), original, "default install must not edit user config");

  const configured = runInstaller(home, ["--configure-codex"]);
  assert.equal(configured.status, 0, configured.stderr || configured.stdout);
  const after = fs.readFileSync(config, "utf8");
  assert.ok(after.startsWith(original), after);
  assert.match(after, /\[sandbox_workspace_write\]/);
  assert.ok(after.includes(JSON.stringify(path.join(home, ".taskloop"))), after);
});

test("--configure-codex preserves config and roots while adding the ledger root idempotently", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-merge-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    config,
    '# personal settings\nmodel = "gpt-test"\n\n' +
      '[sandbox_workspace_write]\nnetwork_access = true\n' +
      'writable_roots = [\n  "/existing/root", # keep this comment\n]\n\n' +
      '[hooks]\nenabled = true\n',
  );
  if (process.platform !== "win32") fs.chmodSync(config, 0o600);

  const first = runInstaller(home, ["--configure-codex"]);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const configured = fs.readFileSync(config, "utf8");
  const ledgerRoot = path.join(home, ".taskloop");
  assert.match(configured, /# personal settings/);
  assert.match(configured, /# keep this comment/);
  assert.match(configured, /network_access = true/);
  assert.match(configured, /\[hooks\]\nenabled = true/);
  assert.ok(configured.includes(JSON.stringify(ledgerRoot)), configured);
  assert.ok(configured.includes('"/existing/root"'), configured);
  if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);

  const second = runInstaller(home, ["--configure-codex"]);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.equal(fs.readFileSync(config, "utf8"), configured, "repeated configure must be byte-idempotent");
  assert.equal(configured.split(JSON.stringify(ledgerRoot)).length - 1, 1);
});

test("--configure-codex creates a missing config, while dry-run stays read-only", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-create-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");

  const dry = runInstaller(home, ["--dry-run", "--configure-codex"]);
  assert.equal(dry.status, 0, dry.stderr || dry.stdout);
  assert.equal(fs.existsSync(config), false);
  assert.match(dry.stdout, new RegExp(`new\\s+${config.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}`));

  const installed = runInstaller(home, ["--configure-codex"]);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const configured = fs.readFileSync(config, "utf8");
  assert.match(configured, /\[sandbox_workspace_write\]/);
  assert.ok(configured.includes(JSON.stringify(path.join(home, ".taskloop"))), configured);
  if (process.platform !== "win32") assert.equal(fs.statSync(config).mode & 0o777, 0o600);
});

test("--configure-codex refuses an unsafe writable_roots shape without changing config", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-refusal-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = '[sandbox_workspace_write]\nwritable_roots = "all"\n';
  fs.writeFileSync(config, original);

  const result = runInstaller(home, ["--configure-codex"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /error\s+cannot safely configure Codex/i);
  assert.match(result.stdout, /writable_roots must be a TOML array/i);
  assert.equal(fs.readFileSync(config, "utf8"), original);
});

test("--configure-codex refuses dotted writable_roots it cannot merge without duplicate TOML keys", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-dotted-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = 'sandbox_workspace_write.writable_roots = ["/existing"]\n';
  fs.writeFileSync(config, original);

  const result = runInstaller(home, ["--configure-codex"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /error\s+cannot safely configure Codex/i);
  assert.match(result.stdout, /dotted or inline/i);
  assert.equal(fs.readFileSync(config, "utf8"), original);
});

test("--configure-codex preserves a symlinked user config instead of replacing its ownership seam", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "taskloop-codex-binding-symlink-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, ".codex", "config.toml");
  const owned = path.join(home, "dotfiles-codex.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  const original = 'model = "gpt-test"\n';
  fs.writeFileSync(owned, original);
  try {
    fs.symlinkSync(owned, config);
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
    t.skip("file symlinks are unavailable");
    return;
  }

  const result = runInstaller(home, ["--configure-codex"]);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /error\s+cannot safely configure Codex outcome ledger binding/i);
  assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(owned, "utf8"), original);
});
