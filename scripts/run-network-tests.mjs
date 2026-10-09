#!/usr/bin/env node
/**
 * Run the opt-in network suite.
 *
 * A tiny launcher rather than `PI_ARXIV_NETWORK=1 vitest …` in package.json,
 * because npm scripts run under `sh` on Unix and `cmd` on Windows, and only the
 * former understands inline environment assignments. This keeps the command
 * identical everywhere and adds no dependency.
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = join(ROOT, "node_modules", "vitest", "vitest.mjs");

const child = spawn(process.execPath, [vitest, "run", "tests/network.spec.ts", "--no-coverage"], {
	cwd: ROOT,
	stdio: "inherit",
	env: { ...process.env, PI_ARXIV_NETWORK: "1" },
});

child.on("close", (code) => process.exit(code ?? 1));
child.on("error", (error) => {
	console.error(`failed to start vitest: ${error.message}`);
	process.exit(1);
});
