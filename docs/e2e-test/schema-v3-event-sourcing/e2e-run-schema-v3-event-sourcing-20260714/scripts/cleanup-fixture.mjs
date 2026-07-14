import fs from "node:fs";
import path from "node:path";

const runDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fixture = path.join(runDir, "fixture");
const marker = path.join(fixture, ".schema-v3-e2e-owner");
if (fs.readFileSync(marker, "utf8") !== "schema-v3-e2e-20260714\n") throw new Error("refusing to clean an unowned fixture");
fs.rmSync(fixture, { recursive: true });
process.stdout.write(`${JSON.stringify({ cleaned: fixture })}\n`);
