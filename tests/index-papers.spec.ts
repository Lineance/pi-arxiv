/**
 * Corpus inventory: every classification branch is exercised against synthetic
 * corpora in a temp directory, so nothing here touches the real papers folder.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachePathFor, digestSources, outputExclusions } from "../extensions/convert/cache.ts";
import { type CorpusEntry, formatReport, indexPapers, summarizeReport } from "../extensions/corpus/index-papers.ts";

async function put(path: string, content = "x"): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

/** A paper directory with every artifact and a valid manifest. */
async function healthyPaper(root: string, id: string): Promise<void> {
	await put(join(root, id, `${id}.pdf`), "%PDF");
	await put(join(root, id, "abs.md"), "# Abstract");
	await put(join(root, id, "source", "main.tex"), "\\documentclass{article}");
	await put(join(root, id, "source", `${id}.md`), "# Converted");
	await put(
		join(root, id, "manifest.json"),
		JSON.stringify({
			title: `Paper ${id}`,
			version: "v1",
			fetchedAt: "2026-01-01T00:00:00Z",
			outputs: { markdown: `${id}/source/${id}.md` },
		}),
	);
}

let root: string;
let byId: Map<string, CorpusEntry>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-index-"));
	await healthyPaper(root, "2609.00001");

	// Missing the converted Markdown.
	await put(join(root, "2609.00002", "2609.00002.pdf"), "%PDF");
	await put(join(root, "2609.00002", "source", "main.tex"), "\\documentclass{article}");
	await put(join(root, "2609.00002", "manifest.json"), JSON.stringify({ title: "No markdown", version: "v1" }));

	// Missing the source entirely: the paper cannot be reconverted.
	await put(join(root, "2609.00003", "2609.00003.pdf"), "%PDF");

	// Corrupt manifest, but usable artifacts.
	await put(join(root, "2609.00004", "manifest.json"), "{ not json");
	await put(join(root, "2609.00004", "source", "main.tex"), "\\documentclass{article}");
	await put(join(root, "2609.00004", "source", "2609.00004.md"), "# md");

	// Empty source directory.
	await mkdir(join(root, "2609.00005", "source"), { recursive: true });

	// Pre-<id>/ layout plus a stray file.
	await put(join(root, "2609.00009.pdf"), "%PDF");
	await put(join(root, "notes.txt"), "scratch");

	const report = await indexPapers(root);
	byId = new Map(report.entries.map((entry) => [entry.id, entry]));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("scanning", () => {
	it("indexes every directory", async () => {
		const report = await indexPapers(root);
		expect(report.entries.map((entry) => entry.id)).toEqual(["2609.00001", "2609.00002", "2609.00003", "2609.00004", "2609.00005"]);
	});

	it("separates legacy flat pdfs from unrecognised files", async () => {
		const report = await indexPapers(root);
		expect(report.legacy).toEqual(["2609.00009.pdf"]);
		expect(report.unknown).toEqual(["notes.txt"]);
	});

	it("does not treat corpus sidecars as unrecognised", async () => {
		await put(join(root, "README.md"), "# Papers");
		const report = await indexPapers(root);
		expect(report.unknown).toEqual(["notes.txt"]);
	});

	it("returns an empty report for a missing directory instead of throwing", async () => {
		const report = await indexPapers(join(root, "does-not-exist"));
		expect(report.entries).toEqual([]);
		expect(formatReport(report)).toContain("all healthy");
	});

	it("never writes to the corpus", async () => {
		const target = join(root, "does-not-exist");
		await indexPapers(target);
		expect(existsSync(target)).toBe(false);
	});
});

describe("classification", () => {
	it("finds no issues in a complete paper", () => {
		const entry = byId.get("2609.00001");
		expect(entry?.issues).toEqual([]);
		expect(entry?.title).toBe("Paper 2609.00001");
		expect(entry?.version).toBe("v1");
		expect(entry?.markdown).toBeTruthy();
		expect(entry?.pdf).toBeTruthy();
	});

	it("warns when the Markdown is absent", () => {
		const issue = byId.get("2609.00002")?.issues.find((candidate) => candidate.kind === "no-markdown");
		expect(issue?.level).toBe("warn");
	});

	it("errors when the source is absent, because reconversion is impossible", () => {
		const issue = byId.get("2609.00003")?.issues.find((candidate) => candidate.kind === "no-source");
		expect(issue?.level).toBe("error");
	});

	it("survives a corrupt manifest and still finds the artifacts", () => {
		const entry = byId.get("2609.00004");
		expect(entry?.issues.some((issue) => issue.kind === "broken-manifest")).toBe(true);
		expect(entry?.markdown).toBeTruthy();
		expect(entry?.title).toBeUndefined();
	});

	it("flags a source directory with no LaTeX in it", () => {
		expect(byId.get("2609.00005")?.issues.some((issue) => issue.kind === "empty")).toBe(true);
	});
});

describe("staleness", () => {
	it("detects a Markdown older than the LaTeX it came from", async () => {
		const staleRoot = await mkdtemp(join(tmpdir(), "pi-arxiv-stale-"));
		try {
			await healthyPaper(staleRoot, "2609.00006");
			const yesterday = new Date(Date.now() - 86_400_000);
			await utimes(join(staleRoot, "2609.00006", "source", "2609.00006.md"), yesterday, yesterday);

			const report = await indexPapers(staleRoot);

			expect(report.entries[0]?.issues.some((issue) => issue.kind === "stale-markdown")).toBe(true);
		} finally {
			await rm(staleRoot, { recursive: true, force: true });
		}
	});

	it("detects changed source content even when its timestamp is older", async () => {
		const digestRoot = await mkdtemp(join(tmpdir(), "pi-arxiv-digest-stale-"));
		try {
			await healthyPaper(digestRoot, "2609.00007");
			const sourceDir = join(digestRoot, "2609.00007", "source");
			const markdownPath = join(sourceDir, "2609.00007.md");
			const digest = await digestSources(sourceDir, outputExclusions(markdownPath, sourceDir));
			await writeFile(cachePathFor(markdownPath), JSON.stringify({ sourceDigest: digest }));
			await writeFile(join(sourceDir, "main.tex"), "changed source with old timestamp");
			const yesterday = new Date(Date.now() - 86_400_000);
			await utimes(join(sourceDir, "main.tex"), yesterday, yesterday);
			await utimes(markdownPath, new Date(), new Date());

			const report = await indexPapers(digestRoot);

			expect(report.entries[0]?.issues.some((issue) => issue.kind === "stale-markdown")).toBe(true);
		} finally {
			await rm(digestRoot, { recursive: true, force: true });
		}
	});

	it("trusts an unchanged digest even when source timestamps appear newer", async () => {
		const digestRoot = await mkdtemp(join(tmpdir(), "pi-arxiv-digest-fresh-"));
		try {
			await healthyPaper(digestRoot, "2609.00008");
			const sourceDir = join(digestRoot, "2609.00008", "source");
			const markdownPath = join(sourceDir, "2609.00008.md");
			const digest = await digestSources(sourceDir, outputExclusions(markdownPath, sourceDir));
			await writeFile(cachePathFor(markdownPath), JSON.stringify({ sourceDigest: digest }));
			const yesterday = new Date(Date.now() - 86_400_000);
			const now = new Date();
			await utimes(markdownPath, yesterday, yesterday);
			await utimes(join(sourceDir, "main.tex"), now, now);

			const report = await indexPapers(digestRoot);

			expect(report.entries[0]?.issues.some((issue) => issue.kind === "stale-markdown")).toBe(false);
		} finally {
			await rm(digestRoot, { recursive: true, force: true });
		}
	});

	it("does not flag a freshly converted paper", () => {
		// All artifacts are written within milliseconds of each other; a tolerance
		// window keeps that from reading as staleness.
		expect(byId.get("2609.00001")?.issues).toEqual([]);
	});
});

describe("rendering", () => {
	it("summarises the corpus", async () => {
		const text = formatReport(await indexPapers(root));
		expect(text.split("\n")[0]).toMatch(/5 paper\(s\)/);
		expect(text).toContain(root);
		expect(text).toContain("✗");
		expect(text).toContain("flat file");
	});

	it("can hide healthy entries without hiding problems", async () => {
		const text = formatReport(await indexPapers(root), { includeHealthy: false });
		expect(text).not.toContain("2609.00001");
		expect(text).toContain("2609.00003");
	});

	it("gives a one-line verdict for tool results", async () => {
		const summary = summarizeReport(await indexPapers(root));
		expect(summary).not.toContain("\n");
		expect(summary).toContain("legacy");
	});
});
