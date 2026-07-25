#!/usr/bin/env node
// The executable. It owns the process — argv in, exit code out — and nothing
// else; every decision is one layer down in src/cli.mjs.
import { main } from "../src/cli.mjs";

process.exitCode = await main(process.argv.slice(2));
