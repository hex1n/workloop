const fs = require("node:fs");
const path = require("node:path");

const originalReadFileSync = fs.readFileSync;
let eventStoreReads = 0;

fs.readFileSync = function countedReadFileSync(file, ...args) {
  if (path.basename(String(file)) === "events-v3.jsonl") eventStoreReads += 1;
  return originalReadFileSync.call(this, file, ...args);
};

process.on("exit", () => {
  const target = process.env.TASKLOOP_EVENT_READ_COUNT_FILE;
  if (target) fs.writeFileSync(target, String(eventStoreReads));
});
