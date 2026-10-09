/**
 * Shared test harness: assertions, paths, and an ExecLike over child_process.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childProcessExec } from "../extensions/convert/convert.ts";

export const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = join(HERE, "tests", "_out");

/** Real LaTeX source used by the fixture test (override with the env var). */
export const fixtureSource = process.env["PI_ARXIV_FIXTURE_SOURCE"] ?? "D:/Code/Research/opd/papers/og-opd";

export const runWithExec = childProcessExec;

interface Failure {
	name: string;
	detail?: unknown;
}

const state = { passed: 0, failures: [] as Failure[] };

export function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		state.passed++;
		return;
	}
	state.failures.push({ name, detail });
}

export function equal<T>(name: string, actual: T, expected: T): void {
	check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Print the summary and return the process exit code. */
export function report(section: string): number {
	const total = state.passed + state.failures.length;
	console.log(`${section}: ${state.passed}/${total} passed`);
	for (const failure of state.failures) {
		console.log(`  ✗ ${failure.name}${failure.detail === undefined ? "" : ` — ${String(failure.detail)}`}`);
	}
	return state.failures.length > 0 ? 1 : 0;
}

export function failureCount(): number {
	return state.failures.length;
}
