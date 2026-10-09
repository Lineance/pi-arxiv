/**
 * The download path end to end, with `fetch` stubbed: no network, but the real
 * write → extract → manifest flow runs against a temp directory.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Manifest, pull } from "../extensions/arxiv/pull.ts";
import type { ArxivMeta } from "../extensions/types.ts";
import { makeTar } from "./helpers/fixtures.ts";

const META: ArxivMeta = {
	id: "2609.35319",
	version: "v1",
	title: "Teacher–Student Gaps Are Not Enough",
	authors: ["Tong Zhang", "Zhou Liu"],
	abstract: "On-policy distillation …",
	categories: ["cs.LG", "cs.AI"],
	published: "2026-09-28T14:49:13Z",
	absUrl: "https://arxiv.org/abs/2609.35319v1",
	pdfUrl: "https://arxiv.org/pdf/2609.35319v1",
	htmlUrl: "https://arxiv.org/html/2609.35319v1",
};

const PDF_BYTES = Buffer.from("%PDF-1.7 fake pdf body");
const SOURCE_ARCHIVE = gzipSync(
	makeTar([
		{ name: "main.tex", content: "\\documentclass{article}\\begin{document}hi\\end{document}" },
		{ name: "figures/plot.pdf", content: "pdf" },
		{ name: "cgd_references.bib", content: "@article{x}" },
		{ name: "../escape.tex", content: "evil" },
	]),
);

/** Records every requested URL so reuse and force can be asserted. */
function stubFetch(payloads: Record<string, Buffer>): { fetch: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const impl: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		const match = Object.entries(payloads).find(([key]) => url.includes(key));
		if (!match) return new Response("not found", { status: 404, statusText: "Not Found" });
		return new Response(new Uint8Array(match[1]), { status: 200 });
	};
	return { fetch: impl, calls };
}

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-arxiv-pull-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("first pull", () => {
	it("writes the pdf, extracts the source and records a manifest", async () => {
		const stub = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });

		const result = await pull(META, { destDir: dir, version: "v1", fetchImpl: stub.fetch, libVersion: "test" });

		expect(result.pdfPath && existsSync(result.pdfPath)).toBe(true);
		expect(result.extracted).toEqual(expect.arrayContaining(["main.tex", "cgd_references.bib"]));
		expect(result.absPath && existsSync(result.absPath)).toBe(true);
		expect(existsSync(result.manifestPath)).toBe(true);
		expect(result.reused).toEqual([]);
	});

	it("refuses a traversal entry and says so", async () => {
		const stub = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });

		const result = await pull(META, { destDir: dir, version: "v1", fetchImpl: stub.fetch });

		expect(result.skippedTraversal).toEqual(["../escape.tex"]);
		expect(result.warnings.some((warning) => /unsafe archive entry/.test(warning.message))).toBe(true);
		expect(existsSync(join(dir, "..", "escape.tex"))).toBe(false);
	});

	it("records hashes, outputs and the library version", async () => {
		const stub = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });
		const result = await pull(META, { destDir: dir, version: "v1", fetchImpl: stub.fetch, libVersion: "test" });

		// Read it back so the assertion covers what was actually written.
		const manifest = JSON.parse(await readFile(result.manifestPath, "utf8")) as Manifest;

		expect(manifest.id).toBe("2609.35319");
		expect(manifest.version).toBe("v1");
		expect(manifest.sha256.pdf).toHaveLength(64);
		expect(manifest.sha256.source).toHaveLength(64);
		expect(manifest.toolchain["pi-arxiv"]).toBe("test");
		expect(manifest.outputs.pdf).toBe("2609.35319.pdf");
	});
});

describe("repeat pull", () => {
	it("makes no requests and reports what it reused", async () => {
		const first = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });
		const initial = await pull(META, { destDir: dir, version: "v1", fetchImpl: first.fetch });

		const second = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });
		const again = await pull(META, { destDir: dir, version: "v1", fetchImpl: second.fetch });

		expect(second.calls).toEqual([]);
		expect(again.reused.some((path) => path.endsWith(".pdf"))).toBe(true);
		expect(again.reused.some((path) => path.endsWith(".tar.gz"))).toBe(true);
		expect(again.manifest.sha256.pdf).toBe(initial.manifest.sha256.pdf);
	});

	it("re-downloads when forced", async () => {
		const first = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });
		await pull(META, { destDir: dir, version: "v1", fetchImpl: first.fetch });

		const forced = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });
		await pull(META, { destDir: dir, version: "v1", force: true, fetchImpl: forced.fetch });

		expect(forced.calls).toHaveLength(2);
	});
});

describe("part selection", () => {
	it("fetches only what was asked for", async () => {
		const stub = stubFetch({ "/pdf/": PDF_BYTES, "/e-print/": SOURCE_ARCHIVE });

		const result = await pull(META, { destDir: dir, parts: ["pdf"], fetchImpl: stub.fetch });

		expect(result.pdfPath).toBeDefined();
		expect(result.sourceDir).toBeUndefined();
		expect(stub.calls).toHaveLength(1);
	});
});

describe("failure handling", () => {
	it("reports an HTTP failure as a warning instead of throwing", async () => {
		const stub = stubFetch({});

		const result = await pull(META, { destDir: dir, parts: ["source"], fetchImpl: stub.fetch });

		expect(result.warnings.some((warning) => warning.level === "warn" && /source download failed/.test(warning.message))).toBe(true);
		expect(result.sourceDir).toBeUndefined();
	});
});

describe("e-print shapes", () => {
	it("normalises a single gzipped .tex into source/main.tex", async () => {
		const stub = stubFetch({ "/e-print/": gzipSync(Buffer.from("\\documentclass{article}")) });

		const result = await pull(META, { destDir: dir, parts: ["source"], fetchImpl: stub.fetch });

		expect(result.extracted).toEqual(["main.tex"]);
		expect(result.warnings.some((warning) => /single gzipped \.tex/.test(warning.message))).toBe(true);
		expect(await readFile(join(dir, "source", "main.tex"), "utf8")).toBe("\\documentclass{article}");
	});

	it("keeps an unrecognised container instead of guessing", async () => {
		const stub = stubFetch({ "/e-print/": Buffer.from("not an archive at all") });

		const result = await pull(META, { destDir: dir, parts: ["source"], fetchImpl: stub.fetch });

		expect(result.extracted).toEqual(["source.bin"]);
		expect(result.warnings.some((warning) => /unrecognised e-print container/.test(warning.message))).toBe(true);
	});
});
