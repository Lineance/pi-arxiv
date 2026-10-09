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
			 * Measured without that fixture (the CI case): lines 77.7, statements 75.6,
			 * functions 79.3, branches 67.2. With it (locally, or in CI when the fetch
			 * step succeeds): lines 82.3, statements 80.2, functions 81.5,
			 * branches 70.9.
			 *
			 * Each floor sits a point or so below the CI measurement, so the gate does
			 * not fail on measurement noise. Raise them when the floor rises; never
			 * lower one to make a build pass.
			 *
			 * Deliberately global only. A per-file threshold was tried and removed:
			 * a module imported by several suites in separate workers is reported
			 * per-worker, so its number moves with the test layout rather than with its
			 * own coverage — a gate that fails for reasons unrelated to the change is a
			 * gate people silence.
			 */
			thresholds: {
				lines: 76,
				functions: 78,
				statements: 74,
				branches: 66,
			},
		},
	},
});
