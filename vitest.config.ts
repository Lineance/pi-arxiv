import { defineConfig } from "vitest/config";

/**
 * Vitest is the runner pi itself uses, so a contributor already has the
 * toolchain. Two deliberate choices:
 *
 * - Coverage is measured over `extensions/` only. The tests are the thing being
 *   trusted, not the thing being measured; counting them would flatter the
 *   number without saying anything about the package.
 * - The network suite is excluded by default. It is opt-in (`PI_ARXIV_NETWORK=1`)
 *   because a test run must not depend on arXiv being reachable, and CI should
 *   never fail because of someone else's outage.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.spec.ts"],
		// One temp-dir-heavy suite at a time keeps failures readable and avoids
		// fighting over pandoc/pdftoppm subprocesses.
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 60_000,
		coverage: {
			provider: "v8",
			include: ["extensions/**/*.ts"],
			exclude: ["extensions/convert/rules/types.ts"],
			reporter: ["text", "lcov"],
			reportsDirectory: "coverage",
			/*
			 * A ratchet, set to the *guaranteed floor*: the numbers CI reaches without
			 * the optional full-size paper, which is not vendored in this repository.
			 * A threshold that only passes on one machine is a gate people learn to
			 * bypass.
			 *
			 * Measured on the lowest supported CI lane without that fixture (Node 22/Linux): lines 76.3, statements 73.35,
			 * functions 77.06, branches 66.22. The floor is kept just below those observed values so
			 * the gate reflects the real cross-version baseline rather than only Node 24.
			 * With the optional fixture or newer runtimes, coverage is higher.
			 *
			 * Deliberately global only. A per-file threshold was tried and removed:
			 * a module imported by several suites in separate workers is reported
			 * per-worker, so its number moves with the test layout rather than with its
			 * own coverage — a gate that fails for reasons unrelated to the change is a
			 * gate people silence.
			 */
			thresholds: {
				lines: 76,
				functions: 77,
				statements: 73,
				branches: 66,
			},
		},
	},
});
