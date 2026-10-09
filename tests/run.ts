/**
 * Test orchestrator.
 *
 *   node --experimental-strip-types tests/run.ts             # all offline suites
 *   node --experimental-strip-types tests/run.ts --unit      # pure unit tests only
 *   node --experimental-strip-types tests/run.ts --fixture   # end-to-end conversion only
 *   node --experimental-strip-types tests/run.ts --integration  # extension loading only
 *   node --experimental-strip-types tests/run.ts --network   # also hit the arXiv API
 *   node --experimental-strip-types tests/run.ts --write     # refresh the golden Markdown
 */

import { runFixture } from "./fixture.ts";
import { report } from "./harness.ts";
import { runHttp } from "./http.ts";
import { runIntegration } from "./integration.ts";
import { runPull } from "./pull.ts";
import { runUnit } from "./unit.ts";

const args = new Set(process.argv.slice(2));
const unitOnly = args.has("--unit");
const fixtureOnly = args.has("--fixture");
const integrationOnly = args.has("--integration");
const selected = unitOnly || fixtureOnly || integrationOnly;

if (!fixtureOnly && !integrationOnly) {
	console.log("unit:");
	await runUnit();
	console.log("http:");
	await runHttp();
	console.log("pull:");
	await runPull();
}
if (!unitOnly && !integrationOnly) await runFixture(args.has("--write"));
if (!selected || integrationOnly) {
	console.log("integration:");
	await runIntegration();
}

if (args.has("--network")) {
	const { runNetwork } = await import("./network.ts");
	await runNetwork();
}

const failures = report("total");
console.log(failures === 0 ? "OK" : "FAILED");
process.exit(failures === 0 ? 0 : 1);
