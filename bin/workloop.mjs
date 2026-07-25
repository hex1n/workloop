#!/usr/bin/env node
// The executable. It owns the process — argv in, exit code out — and nothing
// else; every decision is one layer down in src/cli.mjs.
import { main } from "../src/cli.mjs";

// A closed pipe reaches the process as an error event on stdout, after the
// write itself has returned. Both ends have to be quiet about it.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => { if (error.code !== "EPIPE") throw error; });
}

process.exitCode = await main(process.argv.slice(2));
