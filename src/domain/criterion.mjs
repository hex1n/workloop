// Running the criterion, and reading its verdict.
//
// The runtime spawns the criterion itself and reads what it says. That is the
// anchor the whole loop rests on: an agent's claim that the work is done is a
// lead, an exit code from a process the runtime started is a fact.
//
// The verdict channel is deliberately narrow. Anything the runtime cannot
// interpret with confidence becomes "indeterminate", never "satisfied" —
// success is the one answer that must never happen by accident.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { digestOf } from "../canonical.mjs";
import { VERDICT } from "./vocabulary.mjs";

export const VERDICT_PREFIX = "WORKLOOP_VERDICT";

// Dedicated exit codes, used only when the criterion prints no verdict line.
// Neither 0 nor 1 means success: a script that dies before it starts, a stray
// `true`, or a shell that cannot find the file all exit with codes in that
// range, and every one of them must read as "we do not know", not as green.
export const EXIT = Object.freeze({ SATISFIED: 4, UNSATISFIED: 3 });

export const OUTPUT_TAIL_BYTES = 4000;
export const MAX_FAILURES = 50;
// Enough to hold any verdict line a criterion could reasonably print, and
// small enough that a runaway process cannot grow it without bound. Only this
// much is searched for the verdict; everything else survives as a digest.
export const MAX_SCANNED_BYTES = 256 * 1024;

// Accumulates a stream without keeping it: the digest is folded in chunk by
// chunk, and only a bounded window of text is retained. A criterion that
// prints a gigabyte cannot make the runtime hold a gigabyte.
export function streamSink() {
  const hash = createHash("sha256");
  let kept = "";
  let bytes = 0;
  // Memoised, because a hash can only be finalised once. Both the failure path
  // and the close path build an execution record, and on a spawn that fails
  // both can run — the second call used to throw *after* the promise had
  // settled, which surfaces as an unhandled exception with no owner.
  let digested = null;
  return {
    write(chunk) {
      hash.update(chunk);
      bytes += chunk.length;
      kept = (kept + chunk).slice(-MAX_SCANNED_BYTES);
    },
    get text() { return kept; },
    get truncated() { return bytes > kept.length; },
    digest: () => (digested ??= `sha256:${hash.digest("hex")}`),
  };
}

const bounded = (text) => (text.length <= OUTPUT_TAIL_BYTES ? text : `…${text.slice(-OUTPUT_TAIL_BYTES)}`);

// Failures are trimmed to what a signature can be built from and a person can
// read. Everything else about the run survives as a digest of the full output.
function normalizeFailures(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_FAILURES).flatMap((failure) => {
    if (typeof failure === "string") return failure.length > 0 ? [{ id: failure.slice(0, 200) }] : [];
    if (failure === null || typeof failure !== "object") return [];
    const id = typeof failure.id === "string" ? failure.id.slice(0, 200) : null;
    if (id === null || id.length === 0) return [];
    return [{
      id,
      expected: typeof failure.expected === "string" ? failure.expected.slice(0, 500) : null,
      actual: typeof failure.actual === "string" ? failure.actual.slice(0, 500) : null,
    }];
  });
}

// The verdict line wins when present; the exit code is the fallback for
// criteria that have not been taught to speak. When the two disagree, the run
// is indeterminate: two channels contradicting each other is exactly the
// situation where guessing is worst.
export function readVerdict({ stdout, code, signal }) {
  const line = stdout.split("\n").map((entry) => entry.trim()).filter((entry) => entry.startsWith(`${VERDICT_PREFIX} `)).at(-1);
  const fallback = signal !== null ? VERDICT.INDETERMINATE
    : code === EXIT.SATISFIED ? VERDICT.SATISFIED
      : code === EXIT.UNSATISFIED ? VERDICT.UNSATISFIED
        : VERDICT.INDETERMINATE;
  if (line === undefined) return { verdict: fallback, failures: [], source: "exit_code" };

  let parsed;
  try {
    parsed = JSON.parse(line.slice(VERDICT_PREFIX.length + 1));
  } catch {
    return { verdict: VERDICT.INDETERMINATE, failures: [], source: "unparseable_verdict" };
  }
  if (!Object.values(VERDICT).includes(parsed?.verdict)) {
    return { verdict: VERDICT.INDETERMINATE, failures: [], source: "unknown_verdict" };
  }
  // A spoken verdict that its own exit code contradicts is not trusted. The
  // criterion is the anchor; an anchor that disagrees with itself is not one.
  if (fallback !== VERDICT.INDETERMINATE && fallback !== parsed.verdict) {
    return { verdict: VERDICT.INDETERMINATE, failures: [], source: "verdict_conflicts_with_exit_code" };
  }
  return { verdict: parsed.verdict, failures: normalizeFailures(parsed.failures), source: "verdict_line" };
}

const treeKill = (child) => {
  if (process.platform === "win32") {
    // Windows has no process group. `taskkill /T` is the whole mechanism.
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    killer.once("error", () => {});
    return killer;
  }
  // Negative pid targets the whole process group, which the child got by being
  // spawned detached. Killing only the child would leave whatever it started
  // running after the runtime believed the criterion was over.
  process.kill(-child.pid, "SIGKILL");
  return null;
};

/**
 * Ends the criterion and everything it started, and reports how sure it is.
 *
 * The fallback is honest about its reach. A failed tree-kill is usually a
 * process that had already exited, so it is retried once. If the mechanism
 * itself is unavailable — `taskkill` off the PATH — nothing Node exposes can
 * reach a grandchild on Windows; the equivalent of a process group there is a
 * job object, which Node does not surface. So the runtime kills what it can
 * and *says* the descendants may have survived, rather than reporting a tree
 * it did not fell.
 *
 * Returning promptly is not negotiable either way: a timeout that hangs is
 * the one thing a timeout must never do.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return { felled: true };
  try {
    treeKill(child);
    return { felled: true };
  } catch (error) {
    // Nothing there to kill is not a failure to kill it. Reporting the group
    // as possibly-surviving because it had already exited would cry wolf on
    // the one outcome that needs no attention at all.
    if (error.code === "ESRCH") return { felled: true };
    try {
      treeKill(child);
      return { felled: true };
    } catch (retry) {
      if (retry.code === "ESRCH") return { felled: true };
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      return { felled: false };
    }
  }
}

export async function runCriterion({ executable, args = [], cwd, timeoutMs = 120_000, env = {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const out = streamSink();
    const err = streamSink();
    let settled = false;
    let timedOut = false;
    let descendantsUncertain = false;
    let child;

    // `error` and `close` can both fire — a spawn failure after a timeout, for
    // instance — and a promise that resolves twice keeps the first answer and
    // silently drops the second. Guarding once here is cheaper than finding
    // out later which answer was lost.
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("exit", onExit);
      resolve(value);
    };
    // If the runtime exits first, the detached group would outlive it with
    // nobody left to time it out. This covers an orderly exit; a SIGKILL of
    // the runtime itself still orphans the group, which §"已知限制" records
    // rather than pretends away.
    const onExit = () => { if (child !== undefined) killTree(child); };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child !== undefined) descendantsUncertain = !killTree(child).felled;
    }, timeoutMs);

    const failed = (source, message) => settle({
      verdict: VERDICT.INDETERMINATE,
      failures: [],
      source,
      execution: {
        error: message, duration_ms: Date.now() - started, exit_code: null, signal: null,
        output_digest: digestOf({ stdout: out.digest(), stderr: err.digest() }),
        output_truncated: false, output_tail: bounded(out.text + err.text),
      },
    });

    try {
      child = spawn(executable, args, {
        cwd,
        detached: process.platform !== "win32",
        // The criterion gets no stdin: it is a check, not a conversation.
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...env },
      });
    } catch (error) {
      failed("spawn_failed", error.message);
      return;
    }
    process.once("exit", onExit);

    child.stdout.on("data", (chunk) => out.write(chunk));
    child.stderr.on("data", (chunk) => err.write(chunk));
    child.once("error", (error) => failed("spawn_failed", error.message));
    child.once("close", (code, signal) => {
      const read = timedOut
        ? { verdict: VERDICT.INDETERMINATE, failures: [], source: "timeout" }
        : readVerdict({ stdout: out.text, code, signal });
      settle({
        ...read,
        execution: {
          error: timedOut ? (descendantsUncertain ? "timeout_descendants_uncertain" : "timeout") : null,
          duration_ms: Date.now() - started,
          exit_code: code,
          signal,
          output_truncated: out.truncated || err.truncated,
          // The full output survives only as a digest, folded in chunk by
          // chunk and taken per stream — so the two can never be confused with
          // each other whatever bytes they happen to carry.
          output_digest: digestOf({ stdout: out.digest(), stderr: err.digest() }),
          // The tail, not the head: when a check fails, what went wrong is at
          // the end of what it printed.
          output_tail: bounded(out.text + err.text),
        },
      });
    });
  });
}
