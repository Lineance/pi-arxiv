/**
 * Network smoke tests (opt-in with `--network`).
 *
 * These hit the real arXiv API and are kept small: one metadata lookup, one
 * full download + conversion. They are skipped automatically when the network
 * is unavailable so an offline `npm test` still succeeds.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lookupById, parseArxivId, searchByTitle } from "../extensions/arxiv/api.ts";
import { type Manifest, pull } from "../extensions/arxiv/pull.ts";
import { convertSourceDir } from "../extensions/convert/convert.ts";
import type { ArxivMeta } from "../extensions/types.ts";
import { check, equal as eq, runWithExec } from "./harness.ts";

const KNOWN_ID = "2609.35319";

/** One shared lookup: the arXiv API asks for ~3s between requests. */
export async function runNetwork(): Promise<void> {
	console.log("\nnetwork:");
	let meta: ArxivMeta;
	try {
		meta = await lookupById(KNOWN_ID);
	} catch (error) {
		console.log(`  skipped — arXiv API unreachable (${(error as Error).message})`);
		return;
	}

	eq("lookup returns the requested id", meta.id, KNOWN_ID);
	check("lookup returns a title", meta.title.length > 20, meta.title);
	check("lookup returns authors", meta.authors.length >= 5, meta.authors.length);
	check("lookup returns an abstract", meta.abstract.length > 200, meta.abstract.length);
	check("lookup returns category urls", meta.categories.length > 0, meta.categories);

	const matches = await searchByTitle("Outcome-Guided On-Policy Distillation for Multi-Turn Autonomous Agents", 2);
	check(
		"title search finds the paper",
		matches.some((match) => match.id === KNOWN_ID),
		matches.map((match) => match.id),
	);
	eq("id parsing is stable across forms", parseArxivId(meta.absUrl)?.id, KNOWN_ID);

	// ---- full download + conversion in a temp directory
	const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-e2e-"));
	try {
		const pulled = await pull(meta, { destDir: dir, libVersion: "test" });
		check("pdf downloaded", Boolean(pulled.pdfPath && existsSync(pulled.pdfPath)), pulled.pdfPath);
		check("source extracted", (pulled.extracted?.length ?? 0) > 1, pulled.extracted?.length);
		check("no traversal entries in this e-print", pulled.skippedTraversal.length === 0, pulled.skippedTraversal);
		check("manifest written", existsSync(pulled.manifestPath), pulled.manifestPath);

		const manifest = JSON.parse(await readFile(pulled.manifestPath, "utf8")) as Manifest;
		check("manifest has a pdf hash", (manifest.sha256.pdf ?? "").length === 64, manifest.sha256.pdf);

		const converted = await convertSourceDir(
			{ workDir: pulled.sourceDir!, outFile: join(dir, "paper.md"), figures: true },
			{ exec: runWithExec },
		);
		check("conversion succeeds on a fresh download", converted.ok, converted.warnings[0]?.message);
		if (converted.ok && converted.markdownPath) {
			const markdown = await readFile(converted.markdownPath, "utf8");
			check("fresh download produces a substantial document", markdown.split("\n").length > 400, markdown.split("\n").length);
			check("fresh download has no raw float HTML", !/<figure\b|<figcaption\b/.test(markdown));
			check("fresh download has numbered headings", /^# 1 Introduction$/m.test(markdown));
		}

		// idempotency: a second pull must reuse, not re-download
		const again = await pull(meta, { destDir: dir });
		check("second pull reuses existing files", again.reused.length >= 2, again.reused.length);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
