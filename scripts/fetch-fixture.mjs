#!/usr/bin/env node
/**
 * Prepare the optional full-size fixture by running the real pipeline.
 *
 * The strongest conversion assertions run against a genuine, published paper.
 * Vendoring one in the repository would be rude and large, so CI fetches it —
 * using this package's own code, which makes the step an integration exercise
 * in its own right.
 *
 * Prints the source directory on success. Callers should treat a failure as
 * "run the reduced suite", never as a build failure: the coverage thresholds are
 * set to hold without this fixture.
 */

import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookupById } from "../extensions/arxiv/api.ts";
import { pull } from "../extensions/arxiv/pull.ts";
import { convertSourceDir } from "../extensions/convert/convert.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = process.env["PI_ARXIV_FIXTURE_ID"] ?? "2609.35319";
const DEST = join(ROOT, "tests", "_out", "fixture-source");

async function main() {
	await rm(DEST, { recursive: true, force: true });
	await mkdir(DEST, { recursive: true });

	const meta = await lookupById(ID);
	const pulled = await pull(meta, { destDir: DEST, libVersion: "ci-fixture" });
	if (!pulled.sourceDir || !existsSync(pulled.sourceDir)) throw new Error("no LaTeX source in the e-print");

	const converted = await convertSourceDir({ workDir: pulled.sourceDir, outFile: join(DEST, "converted.md"), figures: false }, {});
	if (!converted.ok) throw new Error(converted.warnings.map((warning) => warning.message).join("; "));

	// The test consumes only the source path; use stdout so it can be captured
	// without inventing a file format.
	console.log(pulled.sourceDir);
}

main().catch((error) => {
	console.error(`fixture unavailable: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
