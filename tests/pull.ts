/**
 * Pull tests with a stubbed `fetch`: no network, but the whole download →
 * extract → manifest path runs for real.
 *
 *   node --experimental-strip-types tests/pull.ts
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { type Manifest, pull } from "../extensions/arxiv/pull.ts";
import type { ArxivMeta } from "../extensions/types.ts";
import { check, equal as eq } from "./harness.ts";

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

/** Minimal ustar writer (same layout as the real thing, checksum included). */
function makeTar(entries: Array<{ name: string; content: string }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		header.write("000644 \0", 100, 8, "ascii");
		header.write("000000 \0", 108, 8, "ascii");
		header.write("000000 \0", 116, 8, "ascii");
		const size = Buffer.byteLength(entry.content);
		header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
		header.write("00000000000 ", 136, 12, "ascii");
		header.write("        ", 148, 8, "ascii");
		header.write("0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header);
		const body = Buffer.alloc(Math.ceil(size / 512) * 512);
		body.write(entry.content, 0, "utf8");
		blocks.push(body);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

interface Stub {
	fetch: typeof fetch;
	calls: string[];
}

function stubFetch(payloads: Record<string, Buffer>): Stub {
	const calls: string[] = [];
	const impl: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		const match = Object.entries(payloads).find(([key]) => url.includes(key));
		if (!match) {
			return new Response("not found", { status: 404, statusText: "Not Found" });
		}
		return new Response(new Uint8Array(match[1]), { status: 200 });
	};
	return { fetch: impl, calls };
}

export async function runPull(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-pull-"));
	try {
		const pdfBytes = Buffer.from("%PDF-1.7 fake pdf body");
		const sourceArchive = gzipSync(
			makeTar([
				{ name: "main.tex", content: "\\documentclass{article}\\begin{document}hi\\end{document}" },
				{ name: "figures/plot.pdf", content: "pdf" },
				{ name: "cgd_references.bib", content: "@article{x}" },
				{ name: "../escape.tex", content: "evil" },
			]),
		);
		const stub = stubFetch({ "/pdf/": pdfBytes, "/e-print/": sourceArchive });

		// ---- first pull: everything is downloaded ---------------------------------
		const first = await pull(META, { destDir: dir, version: "v1", fetchImpl: stub.fetch, libVersion: "test" });
		check("pdf written on first pull", Boolean(first.pdfPath && existsSync(first.pdfPath)), first.pdfPath);
		check("source extracted on first pull", first.extracted.includes("main.tex"), first.extracted);
		check("bib file extracted", first.extracted.includes("cgd_references.bib"), first.extracted);
		check("abs.md written", Boolean(first.absPath && existsSync(first.absPath)), first.absPath);
		check("manifest written", existsSync(first.manifestPath), first.manifestPath);
		eq("nothing was reused on first pull", first.reused.length, 0);
		eq("traversal entry refused", first.skippedTraversal.length, 1);
		check(
			"traversal refusal is reported",
			first.warnings.some((warning) => /unsafe archive entry/.test(warning.message)),
			first.warnings.map((warning) => warning.message),
		);
		check("escape file not written", !existsSync(join(dir, "escape.tex")), join(dir, "escape.tex"));

		// Read the manifest back from disk so the written JSON is what we assert on.
		const manifest = JSON.parse(await readFile(first.manifestPath, "utf8")) as Manifest;
		eq("pdf hash recorded", (manifest.sha256.pdf ?? "").length, 64);
		eq("source hash recorded", (manifest.sha256.source ?? "").length, 64);
		eq("library version recorded", manifest.toolchain["pi-arxiv"], "test");
		eq("pdf output recorded", manifest.outputs.pdf, "2609.35319.pdf");

		// ---- second pull: must reuse, not re-download -----------------------------
		const beforeCalls = stub.calls.length;
		const second = await pull(META, { destDir: dir, version: "v1", fetchImpl: stub.fetch });
		eq("second pull made no requests", stub.calls.length - beforeCalls, 0);
		check(
			"pdf reused",
			second.reused.some((path) => path.endsWith(".pdf")),
			second.reused,
		);
		check(
			"source archive reused",
			second.reused.some((path) => path.endsWith(".tar.gz")),
			second.reused,
		);
		eq("hashes unchanged", second.manifest.sha256.pdf, manifest.sha256.pdf);

		// ---- force: re-download ---------------------------------------------------
		const beforeForce = stub.calls.length;
		const forced = await pull(META, { destDir: dir, version: "v1", force: true, fetchImpl: stub.fetch });
		check("force re-downloaded the pdf", forced.manifest.sha256.pdf === manifest.sha256.pdf);
		eq("force made two requests", stub.calls.length - beforeForce, 2);

		// ---- parts filtering ------------------------------------------------------
		const partialDir = await mkdtemp(join(tmpdir(), "pi-arxiv-pull2-"));
		const partialStub = stubFetch({ "/pdf/": pdfBytes, "/e-print/": sourceArchive });
		const partial = await pull(META, { destDir: partialDir, parts: ["pdf"], fetchImpl: partialStub.fetch });
		check("pdf-only pull downloads the pdf", Boolean(partial.pdfPath), partial.pdfPath);
		check("pdf-only pull skips the source", partial.sourceDir === undefined, partial.sourceDir);
		eq("pdf-only pull made one request", partialStub.calls.length, 1);
		await rm(partialDir, { recursive: true, force: true });

		// ---- HTTP failure surfaces as a warning, not a crash ----------------------
		const failing = stubFetch({});
		const failed = await pull(META, { destDir: dir, parts: ["source"], force: true, fetchImpl: failing.fetch });
		check(
			"failed source download is reported",
			failed.warnings.some((warning) => warning.level === "warn" && /source download failed/.test(warning.message)),
			failed.warnings.map((warning) => warning.message),
		);

		// ---- a single gzipped .tex (no tar) is handled ----------------------------
		const singleDir = await mkdtemp(join(tmpdir(), "pi-arxiv-pull3-"));
		const singleStub = stubFetch({ "/e-print/": gzipSync(Buffer.from("\\documentclass{article}")) });
		const single = await pull(META, { destDir: singleDir, parts: ["source"], fetchImpl: singleStub.fetch });
		eq("single-tex e-print becomes main.tex", single.extracted.join(","), "main.tex");
		check(
			"single-tex case is explained",
			single.warnings.some((warning) => /single gzipped \.tex/.test(warning.message)),
			single.warnings.map((warning) => warning.message),
		);
		await rm(singleDir, { recursive: true, force: true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
