// Performs one round of a loop and exits. Used to prove that a loop survives
// the death of the process that advanced it: this script shares nothing with
// the test but the directory on disk.
import { next, observe, openLoopStore } from "../../src/domain/loop.mjs";

const [location, root, criterionFile, session, commandId] = process.argv.slice(2);

const directive = next(openLoopStore(location));
await observe(openLoopStore(location), {
  root,
  session,
  criterionFile,
  commandId,
});
process.stdout.write(`${JSON.stringify({ round: directive.round, decision: directive.decision })}\n`);
