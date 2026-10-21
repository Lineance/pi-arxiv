/**
 * Download PDF / e-print source / metadata for one paper and record a manifest
 * that makes the whole directory reproducible and auditable.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { ArxivMeta, ConvertStats, ConvertWarning } from "../types.ts";
import { ensureDir, exists, readText, sha256File, sha256Text, sizeOf, writeFileQueued } from "../util/fsx.ts";
import { fetchWithRetry, type HttpOptions } from "../util/http.ts";
import { extractTarGzToDir, extractTarToDir } from "../util/tar.ts";

export type PullPart = "pdf" | "source" | "abs";

export interface PullOptions {
	destDir: string;
	parts?: PullPart[] | undefined;
	version?: string | undefined;
	force?: boolean | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
	/** Recorded in the manifest for provenance. */
	libVersion?: string | undefined;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch | undefined;
	onRetry?: HttpOptions["onRetry"];
}

/**
 * `manifest.json` is a documented contract rather than a string bag: every field
 * a reader may rely on is typed, so a typo or a missing write is a compile error.
 */
export interface Manifest {
	id: string;
	version: string;
	title: string;
	authors: string[];
	fetchedAt: string;
	urls: {
		abs: string;
		pdf: string;
		source: string;
	};
	sha256: {
		pdf?: string | undefined;
		source?: string | undefined;
		abs?: string | undefined;
	};
	toolchain: {
		"pi-arxiv"?: string | undefined;
		pandoc?: string | undefined;
		pdftoppm?: string | undefined;
	};
	outputs: {
		pdf?: string | undefined;
		source?: string | undefined;
		sourceFiles?: number | undefined;
		abs?: string | undefined;
		markdown?: string | undefined;
		conversion?: ConvertStats | undefined;
	};
	warnings: ConvertWarning[];
}

export interface PullResult {
	id: string;
	version: string;
	destDir: string;
	pdfPath?: string | undefined;
	sourceDir?: string | undefined;
	absPath?: string | undefined;
	extracted: string[];
	skippedTraversal: string[];
	warnings: ConvertWarning[];
	manifestPath: string;
	manifest: Manifest;
	reused: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Per-attempt timeout: a full e-print is ~1 MB, so a generous but finite bound. */
function attemptTimeoutMs(timeoutMs: number): number {
	return Math.max(15_000, Math.min(timeoutMs, 60_000));
}

/** A download request: the HTTP options plus the caller's overall budget. */
type DownloadOptions = HttpOptions & { timeoutMs: number };

async function download(url: string, options: DownloadOptions): Promise<Buffer> {
	const response = await fetchWithRetry(url, {
		...options,
		timeoutMs: attemptTimeoutMs(options.timeoutMs),
		headers: { accept: "*/*", ...options.headers },
	});
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length === 0) throw new Error(`empty response for ${url}`);
	return buffer;
}

/**
 * How arXiv serves an e-print: a `.tar.gz`, a bare gzipped `.tex`, or (rarely)
 * an uncompressed `.tex`. We normalise all three into `sourceDir` and report
 * which shape we saw instead of guessing.
 */
async function saveSource(buffer: Buffer, sourceDir: string): Promise<{ files: string[]; skipped: string[]; note?: string }> {
	await ensureDir(sourceDir);

	const looksGzipped = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
	const looksTar = buffer.length > 262 && buffer.subarray(257, 262).toString("ascii") === "ustar";

	if (!looksGzipped && looksTar) {
		// Uncompressed tar
		const result = await extractTarToDir(buffer, sourceDir);
		return { files: result.files, skipped: result.skipped };
	}

	if (looksGzipped) {
		const tar = gunzipSync(buffer);
		const looksLikeTar = tar.length > 262 && tar.subarray(257, 262).toString("ascii") === "ustar";
		if (!looksLikeTar) {
			await writeFileQueued(join(sourceDir, "main.tex"), tar);
			return { files: ["main.tex"], skipped: [], note: "e-print was a single gzipped .tex; wrote source/main.tex" };
		}
		const result = await extractTarGzToDir(buffer, sourceDir);
		return { files: result.files, skipped: result.skipped };
	}

	if (/^\s*\\documentclass|^\s*%/.test(buffer.subarray(0, 200).toString("utf8"))) {
		await writeFileQueued(join(sourceDir, "main.tex"), buffer);
		return { files: ["main.tex"], skipped: [], note: "e-print was a single .tex; wrote source/main.tex" };
	}

	// Unknown container: keep the raw payload so nothing is silently lost.
	await writeFileQueued(join(sourceDir, "source.bin"), buffer);
	return { files: ["source.bin"], skipped: [], note: "unrecognised e-print container; kept as source/source.bin" };
}

function renderAbsMarkdown(meta: ArxivMeta): string {
	const parts = [
		`# ${meta.title}`,
		"",
		`**arXiv:** [${meta.id}${meta.version ?? ""}](${meta.absUrl}) · **PDF:** ${meta.pdfUrl} · **HTML:** ${meta.htmlUrl}`,
		"",
		`**Authors:** ${meta.authors.join(", ") || "n/a"}`,
		`**Categories:** ${meta.categories.join(", ") || "n/a"}`,
	];
	if (meta.published) parts.push(`**Published:** ${meta.published}`);
	if (meta.updated) parts.push(`**Updated:** ${meta.updated}`);
	if (meta.doi) parts.push(`**DOI:** ${meta.doi}`);
	if (meta.journalRef) parts.push(`**Journal ref:** ${meta.journalRef}`);
	if (meta.comment) parts.push(`**Comment:** ${meta.comment}`);
	parts.push("", "## Abstract", "", meta.abstract, "");
	return `${parts.join("\n")}`.replace(/\n{3,}/g, "\n\n");
}

export async function readPaperManifest(path: string): Promise<Manifest | undefined> {
	if (!(await exists(path))) return undefined;
	try {
		return JSON.parse(await readText(path)) as Manifest;
	} catch {
		return undefined;
	}
}

function sourceUrl(meta: ArxivMeta, version: string): string {
	return `https://arxiv.org/e-print/${meta.id}${version}`;
}

async function matchesManifestArtifact(
	path: string,
	previousUrl: string | undefined,
	expectedUrl: string,
	previousHash: string | undefined,
	force: boolean,
): Promise<boolean> {
	if (force || previousUrl !== expectedUrl || !previousHash || !/^[a-f0-9]{64}$/i.test(previousHash)) return false;
	if ((await sizeOf(path)) <= 0) return false;
	return (await sha256File(path)) === previousHash.toLowerCase();
}

/** Fetch the requested parts into `destDir` and (re)write `manifest.json`. */
export async function pull(meta: ArxivMeta, options: PullOptions): Promise<PullResult> {
	options.signal?.throwIfAborted();
	const parts = options.parts ?? ["pdf", "source", "abs"];
	const version = options.version && options.version !== "latest" ? options.version : (meta.version ?? "");
	const { destDir } = options;
	const sourceDir = join(destDir, "source");
	const manifestPath = join(destDir, "manifest.json");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const downloadOptions: DownloadOptions = { timeoutMs, signal: options.signal, fetchImpl: options.fetchImpl, onRetry: options.onRetry };

	const warnings: ConvertWarning[] = [];
	const reused: string[] = [];

	await ensureDir(destDir);
	options.signal?.throwIfAborted();

	const previousManifest = await readPaperManifest(manifestPath);
	options.signal?.throwIfAborted();
	const manifest: Manifest = previousManifest ?? {
		id: meta.id,
		version: version || "latest",
		title: meta.title,
		authors: meta.authors,
		fetchedAt: new Date().toISOString(),
		urls: { abs: meta.absUrl, pdf: meta.pdfUrl, source: sourceUrl(meta, version) },
		sha256: {},
		toolchain: {},
		outputs: {},
		warnings: [],
	};
	options.signal?.throwIfAborted();
	manifest.id = meta.id;
	manifest.version = version || "latest";
	manifest.title = meta.title;
	manifest.authors = meta.authors;
	manifest.fetchedAt = new Date().toISOString();
	manifest.urls = {
		abs: previousManifest?.urls?.abs ?? meta.absUrl,
		pdf: previousManifest?.urls?.pdf ?? meta.pdfUrl,
		source: previousManifest?.urls?.source ?? sourceUrl(meta, version),
	};
	manifest.sha256 = previousManifest?.sha256 ?? {};
	manifest.toolchain = previousManifest?.toolchain ?? {};
	manifest.outputs = previousManifest?.outputs ?? {};
	manifest.warnings = previousManifest?.warnings ?? [];
	if (options.libVersion) manifest.toolchain["pi-arxiv"] = options.libVersion;

	const result: PullResult = {
		id: meta.id,
		version: manifest.version,
		destDir,
		extracted: [],
		skippedTraversal: [],
		warnings,
		manifestPath,
		manifest,
		reused,
	};

	if (parts.includes("pdf")) {
		options.signal?.throwIfAborted();
		const pdfPath = join(destDir, `${meta.id}.pdf`);
		const pdfUrl = meta.pdfUrl;
		const reusable = await matchesManifestArtifact(
			pdfPath,
			previousManifest?.urls?.pdf,
			pdfUrl,
			previousManifest?.sha256?.pdf,
			options.force ?? false,
		);
		if (reusable) {
			reused.push(pdfPath);
		} else {
			await writeFileQueued(pdfPath, await download(pdfUrl, downloadOptions));
		}
		options.signal?.throwIfAborted();
		result.pdfPath = pdfPath;
		manifest.sha256.pdf = await sha256File(pdfPath);
		manifest.urls.pdf = pdfUrl;
		manifest.outputs.pdf = `${meta.id}.pdf`;
		options.signal?.throwIfAborted();
	}

	if (parts.includes("source")) {
		const archive = join(destDir, `${meta.id}-src.tar.gz`);
		const archiveUrl = sourceUrl(meta, version);
		try {
			const reusable = await matchesManifestArtifact(
				archive,
				previousManifest?.urls?.source,
				archiveUrl,
				previousManifest?.sha256?.source,
				options.force ?? false,
			);
			if (reusable) {
				reused.push(archive);
			} else {
				await writeFileQueued(archive, await download(archiveUrl, downloadOptions));
			}
			options.signal?.throwIfAborted();
			const buffer = await readFile(archive);
			options.signal?.throwIfAborted();
			const saved = await saveSource(buffer, sourceDir);
			options.signal?.throwIfAborted();
			if (saved.note) warnings.push({ rule: "pull", level: "info", message: saved.note });
			if (saved.skipped.length > 0) {
				warnings.push({
					rule: "pull",
					level: "warn",
					message: `refused ${saved.skipped.length} unsafe archive entr${saved.skipped.length === 1 ? "y" : "ies"} (path traversal)`,
				});
			}
			result.extracted = saved.files;
			result.skippedTraversal = saved.skipped;
			result.sourceDir = sourceDir;
			manifest.sha256.source = await sha256File(archive);
			manifest.urls.source = archiveUrl;
			manifest.outputs.source = "source/";
			manifest.outputs.sourceFiles = saved.files.length;
		} catch (error) {
			options.signal?.throwIfAborted();
			warnings.push({ rule: "pull", level: "warn", message: `source download failed: ${(error as Error).message}` });
		}
	}

	if (parts.includes("abs")) {
		options.signal?.throwIfAborted();
		const absPath = join(destDir, "abs.md");
		const body = renderAbsMarkdown(meta);
		if (options.force || sha256Text(body) !== manifest.sha256.abs) {
			await writeFileQueued(absPath, body);
			manifest.sha256.abs = sha256Text(body);
		} else {
			reused.push(absPath);
		}
		result.absPath = absPath;
		manifest.outputs.abs = "abs.md";
	}

	manifest.warnings = warnings;
	options.signal?.throwIfAborted();
	await writeFileQueued(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	options.signal?.throwIfAborted();
	return result;
}
