/**
 * Conversion cache.
 *
 * Re-running pandoc on unchanged source costs seconds and rewrites a file the
 * caller may have open. The cache records what the output depends on, so a
 * conversion can be skipped exactly when nothing that affects it changed.
 *
 * The subtle part is _what_ to hash. Everything the conversion reads must be in
 * the digest, and everything it writes must be out of it — otherwise the cache
 * invalidates itself the first time it runs. The outputs it writes into the
 * source directory are the rendered figures and the Markdown itself.
 */

import { relative, sep } from "node:path";
import type { ConvertStats, ConvertWarning, ExecLike, TableMode } from "../types.ts";
import { listDir, readText, sha256File, sha256Text, statOf, writeFileQueued } from "../util/fsx.ts";
import { detectToolchain } from "../util/toolchain.ts";

/** Bump when the rule pipeline changes in a way that alters output. */
export const CACHE_FORMAT_VERSION = 1;

/** Directories the converter writes into; hashing them would defeat the cache. */
const OUTPUT_DIRS = ["figures/png", "figures\\png"];

export interface CacheInputs {
	/** Hash over everything the conversion reads. */
	sourceDigest: string;
	/** Versions of the external tools whose output the conversion depends on. */
	toolchain: { pandoc?: string | undefined; pdftoppm?: string | undefined };
	options: {
		figures: boolean;
		figureDpi: number;
		tableMode: TableMode;
		libVersion: string;
	};
}

export interface CacheEntry extends CacheInputs {
	formatVersion: number;
	convertedAt: string;
	markdownPath: string;
	stats: ConvertStats;
	figures: string[];
	warnings: ConvertWarning[];
}

/** The cache sits beside the Markdown it describes, so it is easy to inspect. */
export function cachePathFor(markdownPath: string): string {
	return `${markdownPath}.cache.json`;
}

/**
 * Hash every source file, keyed by its relative path.
 *
 * Relative paths are included so a rename invalidates the entry even when the
 * bytes are unchanged, and the list is sorted so directory order cannot matter.
 */
export async function digestSources(workDir: string, exclude: string[] = []): Promise<string> {
	const excluded = new Set([...OUTPUT_DIRS.map((dir) => dir.toLowerCase()), ...exclude.map((item) => normalizeKey(item))]);
	const files = await collectFiles(workDir);
	const parts: string[] = [];

	for (const file of files) {
		const key = normalizeKey(relative(workDir, file));
		if ([...excluded].some((skip) => key === skip || key.startsWith(`${skip}/`))) continue;
		parts.push(`${key}:${await sha256File(file)}`);
	}

	return sha256Text(parts.join("\n"));
}

function normalizeKey(value: string): string {
	return value.split(sep).join("/").replace(/^\.\//, "").toLowerCase();
}

/** Every regular file under `dir`, recursively. */
async function collectFiles(dir: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await listDir(dir)) {
		if (entry.dir) out.push(...(await collectFiles(entry.path)));
		else out.push(entry.path);
	}
	return out;
}

/** The tool versions whose behaviour shows up in the output. */
export async function toolchainVersions(exec: ExecLike, signal?: AbortSignal): Promise<CacheInputs["toolchain"]> {
	const statuses = await detectToolchain(exec, signal);
	return {
		pandoc: statuses.pandoc.version,
		pdftoppm: statuses.pdftoppm.version,
	};
}

/** Is a recorded entry still valid for these inputs? */
export function isCacheValid(entry: CacheEntry, inputs: CacheInputs): boolean {
	if (entry.formatVersion !== CACHE_FORMAT_VERSION) return false;
	if (entry.sourceDigest !== inputs.sourceDigest) return false;
	if (entry.options.tableMode !== inputs.options.tableMode) return false;
	if (entry.options.figures !== inputs.options.figures) return false;
	if (entry.options.libVersion !== inputs.options.libVersion) return false;

	// Only the tools that actually run count: a changed pdftoppm version must not
	// invalidate a conversion that rendered no figures, and vice versa.
	if (inputs.options.figures && entry.options.figureDpi !== inputs.options.figureDpi) return false;
	if (entry.toolchain.pandoc !== inputs.toolchain.pandoc) return false;
	if (inputs.options.figures && entry.toolchain.pdftoppm !== inputs.toolchain.pdftoppm) return false;

	return true;
}

export async function readCache(path: string): Promise<CacheEntry | undefined> {
	if ((await statOf(path)) <= 0) return undefined;
	try {
		const parsed = JSON.parse(await readText(path)) as CacheEntry;
		// A cache is an optimisation, never a source of truth: anything unexpected
		// means "convert again", never "fail".
		return parsed && typeof parsed === "object" && typeof parsed.sourceDigest === "string" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

export async function writeCache(path: string, entry: CacheEntry): Promise<void> {
	await writeFileQueued(path, `${JSON.stringify(entry, null, 2)}\n`);
}

/**
 * Decide whether a previous conversion can be reused.
 *
 * `markdownPath` must still exist: a cache entry whose output was deleted is not
 * a hit, and reporting one would leave the caller with nothing to read.
 */
export async function findValidCache(markdownPath: string, inputs: CacheInputs): Promise<CacheEntry | undefined> {
	if ((await statOf(markdownPath)) <= 0) return undefined;
	const entry = await readCache(cachePathFor(markdownPath));
	if (!entry) return undefined;
	return isCacheValid(entry, inputs) ? entry : undefined;
}

export function buildEntry(
	inputs: CacheInputs,
	result: { markdownPath: string; stats: ConvertStats; figures: string[]; warnings: ConvertWarning[] },
): CacheEntry {
	return {
		...inputs,
		formatVersion: CACHE_FORMAT_VERSION,
		convertedAt: new Date().toISOString(),
		markdownPath: result.markdownPath,
		stats: result.stats,
		figures: result.figures,
		warnings: result.warnings,
	};
}

/**
 * Paths under `workDir` that the converter owns and must not hash.
 *
 * Returns relative keys, or nothing when the output lives outside the source
 * directory — in which case there is nothing to exclude.
 */
export function outputExclusions(markdownPath: string, workDir: string): string[] {
	const markdown = relative(workDir, markdownPath).split(sep).join("/");
	if (!markdown || markdown.startsWith("..")) return [];
	const base = markdown.replace(/\.md$/i, "");
	return [markdown, cachePathFor(markdown), `${base}.pandoc.md`];
}
