import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

function killProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t"];
    if (signal === "SIGKILL") args.push("/f");
    spawnSync("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already closed */ } }
}

function spawnGuarded(command, args, { timeoutMs, ...options }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("spawnGuarded requires a positive integer timeoutMs");
  const child = spawn(command, args, {
    ...options,
    detached: options.detached ?? process.platform !== "win32",
    windowsHide: options.windowsHide ?? true,
  });
  let finished = false;
  let timedOut = false;
  let timeoutId;
  let hardTimeoutId;
  let rejectDeadline;
  const exited = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      finished = true;
      clearTimeout(timeoutId);
      clearTimeout(hardTimeoutId);
      reject(error);
    });
    child.once("close", (code, signal) => {
      finished = true;
      clearTimeout(timeoutId);
      clearTimeout(hardTimeoutId);
      resolve({ code, signal, timedOut });
    });
  });
  const deadlineFailure = new Promise((_, reject) => { rejectDeadline = reject; });
  const closed = Promise.race([exited, deadlineFailure]);
  timeoutId = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, "SIGKILL");
    hardTimeoutId = setTimeout(() => {
      if (finished) return;
      killProcessTree(child, "SIGKILL");
      rejectDeadline(new Error(`process tree exceeded its ${timeoutMs}ms deadline and did not close: ${command}`));
    }, 2_000);
  }, timeoutMs);

  async function dispose() {
    if (!finished) {
      killProcessTree(child, "SIGTERM");
      await Promise.race([
        exited.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    if (!finished) killProcessTree(child, "SIGKILL");
    if (!finished) {
      const boundedClose = await Promise.race([
        exited.then((value) => ({ value }), (error) => ({ error })),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 2_000)),
      ]);
      if (boundedClose.timeout) throw new Error(`process tree did not close after cleanup: ${command}`);
      if (boundedClose.error) throw boundedClose.error;
      return boundedClose.value;
    }
    return exited;
  }

  return { child, closed, dispose };
}

export { killProcessTree, spawnGuarded };
