import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnGuarded } from "./process-guard.mjs";

const apply = process.argv.includes("--apply");
const cwd = path.resolve(process.cwd());
const configPath = path.join(os.homedir(), ".codex", "config.toml");
const hooksPath = path.join(os.homedir(), ".codex", "hooks.json");
const backupPath = `${configPath}.workloop-20260721T144104Z.bak`;
const expected = new Map([
  ["preToolUse", { label: "PreToolUse", timeoutSec: 20, command: `node "${path.join(os.homedir(), "bin", "workloop.mjs")}" hook --profile codex-safe --mode nudge` }],
  ["stop", { label: "Stop", timeoutSec: 45, command: `node "${path.join(os.homedir(), "bin", "workloop.mjs")}" hook --profile codex-safe --mode nudge` }],
]);

if (!fs.existsSync(backupPath)) throw new Error("refusing to update Hook trust without the pre-migration config backup");

const server = spawnGuarded("codex", ["app-server", "--stdio"], {
  stdio: ["pipe", "pipe", "pipe"],
  timeoutMs: 60_000,
});
const { child } = server;
const pending = new Map();
let nextId = 1;
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-16_384);
});
readline.createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch {
    stderr = `${stderr}\nnon-JSON app-server response`.slice(-16_384);
    return;
  }
  if (message.id === undefined) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
  else waiter.resolve(message.result);
});

server.closed.then(
  () => {
    const error = new Error("app-server closed before all requests completed");
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  },
  (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  },
);

function request(method, params, timeoutMs = 15_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`app-server request timed out: ${method}`));
    }, timeoutMs);
    const settle = (callback) => (value) => {
      clearTimeout(timeoutId);
      callback(value);
    };
    pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (!error) return;
      const waiter = pending.get(id);
      pending.delete(id);
      waiter?.reject(error);
    });
  });
}

function quoteKeySegment(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function projectWorkloopHooks(response) {
  const hooks = response.data.flatMap(({ hooks }) => hooks).filter(({ command }) => command?.includes("workloop.mjs"));
  const unexpected = hooks.filter(({ eventName }) => !expected.has(eventName));
  if (unexpected.length) {
    throw new Error(`unexpected workloop Hook events: ${JSON.stringify(unexpected.map(({ eventName, sourcePath }) => ({ eventName, sourcePath })))}`);
  }
  const projected = [];
  for (const [eventName, contract] of expected) {
    const matches = hooks.filter((candidate) => candidate.eventName === eventName);
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one ${eventName} workloop Hook, found ${matches.length}: ${JSON.stringify(hooks.map(({ eventName: event, sourcePath, timeoutSec }) => ({ event, sourcePath, timeoutSec })))}`,
      );
    }
    const [hook] = matches;
    if (hook.command !== contract.command || Number(hook.timeoutSec) !== contract.timeoutSec || hook.enabled !== true) {
      throw new Error(`${eventName} workloop Hook does not match the reviewed recipe`);
    }
    projected.push({
      key: hook.key,
      eventName: contract.label,
      timeoutSec: Number(hook.timeoutSec),
      trustStatus: hook.trustStatus,
      currentHash: hook.currentHash,
    });
  }
  return projected;
}

try {
  await request("initialize", {
    clientInfo: { name: "workloop-e2e", title: "Workloop E2E", version: "1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  const before = projectWorkloopHooks(await request("hooks/list", { cwds: [cwd] }));
  let writeStatus = "not_requested";
  if (apply) {
    const config = await request("config/read", { includeLayers: true, cwd });
    const userLayers = (config.layers ?? []).filter((layer) => (
      layer.name?.type === "user"
      && layer.name.profile === null
      && path.resolve(String(layer.name.file)) === configPath
      && typeof layer.version === "string"
      && layer.version.length > 0
    ));
    if (userLayers.length !== 1) throw new Error(`expected one versioned base user config layer, found ${userLayers.length}`);
    const edits = before.map(({ key, currentHash }) => ({
      keyPath: `hooks.state.${quoteKeySegment(key)}.trusted_hash`,
      value: currentHash,
      mergeStrategy: "upsert",
    }));
    const result = await request("config/batchWrite", {
      edits,
      filePath: configPath,
      expectedVersion: userLayers[0].version,
      reloadUserConfig: true,
    });
    writeStatus = result.status;
  }
  const after = projectWorkloopHooks(await request("hooks/list", { cwds: [cwd] }));
  process.stdout.write(
    `${JSON.stringify(
      {
        apply,
        write_status: writeStatus,
        hooks: after.map(({ eventName, timeoutSec, trustStatus, currentHash }) => ({
          event: eventName,
          timeout_seconds: timeoutSec,
          trust_status_before: before.find((item) => item.eventName === eventName).trustStatus,
          trust_status_after: trustStatus,
          hash_prefix: currentHash.slice(0, 15),
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  child.stdin.end();
  await server.dispose();
  if (pending.size > 0) throw new Error(`app-server closed with pending requests: ${stderr}`);
}
