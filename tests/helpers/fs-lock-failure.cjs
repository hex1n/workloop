const fs = require("node:fs");
const path = require("node:path");

const originalMkdirSync = fs.mkdirSync;

fs.mkdirSync = function failingTaskLockMkdir(target, ...args) {
  if (process.env.TASKLOOP_FAIL_TASK_LOCK === "1" && path.basename(String(target)) === ".task.lock") {
    throw Object.assign(new Error("synthetic task lock failure"), { code: "EACCES" });
  }
  return originalMkdirSync.call(this, target, ...args);
};
