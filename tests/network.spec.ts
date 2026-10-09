/**
 * Live arXiv checks. Opt-in, because a test run must not depend on somebody
 * else's service being up:  PI_ARXIV_NETWORK=1 npm test
 *
 * Kept deliberately small — one lookup, one search, one download cycle — so it
 * is cheap enough to run when a change touches the fetch path.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lookupById, parseArxivId, searchByTitle } from "../extensions/arxiv/api.ts";
import { type Manifest, pull } from "../extensions/arxiv/pull.ts";
import { childProcessExec, convertSourceDir } from "../extensions/convert/convert.ts";
import type { ArxivMeta } from "../extensions/types.ts";

const ENABLED = process.env["PI_ARXIV_NETWORK"] === "1";
const KNOWN_ID = "2609.35319";

let meta: ArxivMeta;
let dir: string;

beforeAll(async () => {
	if (!ENABLED) return;
	meta = await lookupById(KNOWN_ID);
	dir = await mkdtemp(join(tmpdir(), "pi-arxiv-network-"));
});

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)("arXiv API", () => {
	it("returns the requested paper's metadata", () => {
		expect(meta.id).toBe(KNOWN_ID);
		expect(meta.title.length).toBeGreaterThan(20);
		expect(meta.authors.length).toBeGreaterThanOrEqual(5);
		expect(meta.abstract.length).toBeGreaterThan(200);
		expect(meta.categories.length).toBeGreaterThan(0);
	});

	it("round-trips the id through a URL", () => {
		expect(parseArxivId(meta.absUrl)?.id).toBe(KNOWN_ID);
	});

	it("finds the paper by title", async () => {
		const matches = await searchByTitle("Outcome-Guided On-Policy Distillation for Multi-Turn Autonomous Agents", 2);
		expect(matches.map((match) => match.id)).toContain(KNOWN_ID);
	});
});

describe.skipIf(!ENABLED)("download and convert", () => {
	it("fetches, extracts and records provenance", async () => {
		const pulled = await pull(meta, { destDir: dir, libVersion: "test" });

		expect(pulled.pdfPath && existsSync(pulled.pdfPath)).toBe(true);
		expect(pulled.extracted.length).toBeGreaterThan(1);
		expect(pulled.sourceDir).toBeDefined();

		const manifest = JSON.parse(await readFile(pulled.manifestPath, "utf8")) as Manifest;
		expect(manifest.sha256.pdf).toHaveLength(64);
	});

	it("uses the paper's own LaTeX title, not the API's normalised one", async () => {
		const pulled = await pull(meta, { destDir: dir });
		const converted = await convertSourceDir(
			{ workDir: pulled.sourceDir as string, outFile: join(dir, "title.md"), figures: false, arxivMeta: meta },
			{ exec: childProcessExec },
		);
		const markdown = await readFile(converted.markdownPath as string, "utf8");

		// The Atom API rewrites punctuation; the paper's \title uses en dashes.
		expect(markdown.split("\n").find((line) => line.startsWith("# "))).toContain("Teacher–Student");
	});

	it("converts a fresh download into usable Markdown", async () => {
		const pulled = await pull(meta, { destDir: dir });
		const converted = await convertSourceDir(
			{ workDir: pulled.sourceDir as string, outFile: join(dir, "paper.md"), figures: true },
			{ exec: childProcessExec },
		);

		expect(converted.ok, converted.warnings[0]?.message).toBe(true);
		const markdown = await readFile(converted.markdownPath as string, "utf8");
		expect(markdown.split("\n").length).toBeGreaterThan(400);
		expect(/<figure\b|<figcaption\b/.test(markdown)).toBe(false);
		expect(markdown).toMatch(/^# 1 Introduction$/m);
	});

	it("reuses existing files on a second pull", async () => {
		const again = await pull(meta, { destDir: dir });
		expect(again.reused.length).toBeGreaterThanOrEqual(2);
	});
});
