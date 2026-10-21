/**
 * Corpus inventory: what is on disk, what is missing, and what needs rebuilding.
 *
 * Read-only by design. The report is the deliverable; fixing is a separate,
 * explicit action so a scan can never change the corpus.
 *
 * Scanning and rendering are separate functions: `indexPapers` touches the
 * filesystem, `formatReport` is pure, which is what makes the tool testable.
 */

import { basename, extname, join } from "node:path";
import { cachePathFor, digestSources, outputExclusions, readCache } from "../convert/cache.ts";
import { listDir, readText, statOf } from "../util/fsx.ts";

export interface CorpusEntry {
	/** Directory name, i.e. the arXiv id for a managed entry. */
	id: string;
	dir: string;
	pdf?: string | undefined;
	sourceDir?: string | undefined;
	markdown?: string | undefined;
	abstractMd?: string | undefined;
	manifestPath?: string | undefined;
	/** Populated when a manifest exists. */
	title?: string | undefined;
	version?: string | undefined;
	fetchedAt?: string | undefined;
	/** Problems worth acting on, in severity order. */
	issues: CorpusIssue[];
	/** Bytes of the largest artifact, for a rough size column. */
	bytes: number;
}

export type CorpusIssueKind =
	| "no-source"
	| "no-pdf"
	| "no-markdown"
	| "stale-markdown"
	| "no-manifest"
	| "broken-manifest"
	| "legacy-flat"
	| "empty";

export interface CorpusIssue {
	kind: CorpusIssueKind;
	level: "error" | "warn" | "info";
	message: string;
}

export interface CorpusReport {
	papersDir: string;
	/** Managed papers: one directory per id. */
	entries: CorpusEntry[];
	/** `papers/<id>.pdf` files left over from an earlier flat layout. */
	legacy: string[];
	/** Directories that contain nothing recognisable. */
	unknown: string[];
	scannedAt: string;
}

export interface IndexOptions {
	/** Include entries that are fully healthy (default true). */
	includeHealthy?: boolean | undefined;
}

interface ManifestShape {
	title?: unknown;
	version?: unknown;
	fetchedAt?: unknown;
	outputs?: { markdown?: unknown } | undefined;
}

const PDF_EXT = ".pdf";

/** Prefer the path recorded in the manifest; fall back to what the scan found. */
function resolveMarkdown(manifestMarkdown: unknown, fallback: string | undefined): string | undefined {
	if (typeof manifestMarkdown === "string" && manifestMarkdown.length > 0) return manifestMarkdown;
	return fallback;
}

async function inspectEntry(papersDir: string, name: string, files: Awaited<ReturnType<typeof listDir>>): Promise<CorpusEntry> {
	const dir = join(papersDir, name);
	const entry: CorpusEntry = { id: name, dir, issues: [], bytes: 0 };

	const pdf = files.find((file) => !file.dir && file.name === `${name}${PDF_EXT}`);
	const sourceDirEntry = files.find((file) => file.dir && file.name === "source");
	const manifest = files.find((file) => !file.dir && file.name === "manifest.json");

	if (pdf) {
		entry.pdf = pdf.path;
		entry.bytes = Math.max(entry.bytes, pdf.size);
	}
	if (sourceDirEntry) {
		entry.sourceDir = sourceDirEntry.path;
		const sourceFiles = await listDir(sourceDirEntry.path);
		const markdown = sourceFiles.find((file) => !file.dir && file.name.toLowerCase().endsWith(".md"));
		const tex = sourceFiles.find((file) => !file.dir && extname(file.name).toLowerCase() === ".tex");
		if (markdown) {
			entry.markdown = markdown.path;
			entry.bytes = Math.max(entry.bytes, markdown.size);
		}
		if (tex) entry.bytes = Math.max(entry.bytes, tex.size);
		if (!tex) {
			entry.issues.push({ kind: "empty", level: "error", message: "source/ contains no .tex file" });
		}
	}

	const rootMarkdown = files.find((file) => !file.dir && file.name.toLowerCase() === `${name.toLowerCase()}.md`);
	if (rootMarkdown) {
		entry.markdown = rootMarkdown.path;
		entry.bytes = Math.max(entry.bytes, rootMarkdown.size);
	}

	const abstract = files.find((file) => !file.dir && file.name === "abs.md");
	if (abstract) entry.abstractMd = abstract.path;

	if (manifest) {
		entry.manifestPath = manifest.path;
		try {
			const parsed = JSON.parse(await readText(manifest.path)) as ManifestShape;
			if (typeof parsed.title === "string") entry.title = parsed.title;
			if (typeof parsed.version === "string") entry.version = parsed.version;
			if (typeof parsed.fetchedAt === "string") entry.fetchedAt = parsed.fetchedAt;
			const fromManifest = resolveMarkdown(parsed.outputs?.markdown, entry.markdown);
			if (fromManifest && !entry.markdown) entry.markdown = fromManifest;
		} catch (error) {
			entry.issues.push({
				kind: "broken-manifest",
				level: "warn",
				message: `manifest.json is not valid JSON: ${(error as Error).message}`,
			});
		}
	} else {
		entry.issues.push({ kind: "no-manifest", level: "info", message: "no manifest.json (provenance not recorded)" });
	}

	if (!pdf) entry.issues.push({ kind: "no-pdf", level: "warn", message: "no PDF" });
	if (!sourceDirEntry)
		entry.issues.push({ kind: "no-source", level: "error", message: "no source/ directory — the paper cannot be re-converted" });
	else if (!entry.markdown)
		entry.issues.push({ kind: "no-markdown", level: "warn", message: "no converted Markdown — run paper_markdown" });

	// A Markdown older than its LaTeX source is stale: the source changed after
	// conversion, so the Markdown no longer describes it.
	if (entry.markdown && entry.sourceDir && (await isStale(entry.markdown, entry.sourceDir))) {
		entry.issues.push({ kind: "stale-markdown", level: "info", message: "Markdown is older than the LaTeX source — reconvert" });
	}

	if (entry.bytes === 0 && entry.issues.length === 0) {
		entry.issues.push({ kind: "empty", level: "info", message: "directory is empty" });
	}

	return entry;
}

/** Root-level files that belong to the corpus itself rather than to a paper. */
const CORPUS_SIDECARS = new Set(["readme.md", "index.md", "index.json", "manifest.json", ".gitignore"]);

/**
 * A Markdown older than the LaTeX it came from means the source changed after
 * conversion (a newer e-print, or a hand edit) and the output is stale.
 *
 * The tolerance absorbs filesystem timestamp granularity and the fact that the
 * conversion writes its output moments after reading the source.
 */
const STALE_TOLERANCE_MS = 2_000;

async function isStale(markdownPath: string, sourceDir: string): Promise<boolean> {
	const cache = await readCache(cachePathFor(markdownPath));
	if (cache) {
		try {
			const currentDigest = await digestSources(sourceDir, outputExclusions(markdownPath, sourceDir));
			return currentDigest !== cache.sourceDigest;
		} catch {
			// Fall back to timestamps for unreadable or legacy source trees.
		}
	}

	const markdownMtime = await statOf(markdownPath);
	if (markdownMtime <= 0) return false;
	return (await newestSourceMtime(sourceDir)) - markdownMtime > STALE_TOLERANCE_MS;
}

/** Modification time of the newest file in a directory (0 when unreadable). */
async function newestSourceMtime(dir: string): Promise<number> {
	let newest = 0;
	for (const file of await listDir(dir)) {
		newest = Math.max(newest, await statOf(file.path));
	}
	return newest;
}

/** Walk `papersDir` and classify every entry. Read-only. */
export async function indexPapers(papersDir: string): Promise<CorpusReport> {
	const top = await listDir(papersDir);
	const report: CorpusReport = {
		papersDir,
		entries: [],
		legacy: [],
		unknown: [],
		scannedAt: new Date().toISOString(),
	};

	for (const item of top) {
		if (item.dir) {
			report.entries.push(await inspectEntry(papersDir, item.name, await listDir(item.path)));
			continue;
		}
		// `papers/<id>.pdf` (and its `<id>.txt` sibling) predate the per-paper layout.
		if (extname(item.name).toLowerCase() === PDF_EXT) {
			report.legacy.push(item.name);
			continue;
		}
		// Anything else at the root is not a paper artefact; report it rather than
		// silently ignoring a file the user may have expected to be managed.
		if (!CORPUS_SIDECARS.has(basename(item.name).toLowerCase())) report.unknown.push(basename(item.name));
	}

	return report;
}

// ---------------------------------------------------------------- rendering

/** Severity of a whole entry: the worst issue it carries. */
export type CorpusBadge = "ok" | "info" | "warn" | "error";

export function issueBadge(entry: CorpusEntry): CorpusBadge {
	if (entry.issues.some((issue) => issue.level === "error")) return "error";
	if (entry.issues.some((issue) => issue.level === "warn")) return "warn";
	if (entry.issues.some((issue) => issue.level === "info")) return "info";
	return "ok";
}

function humanBytes(bytes: number): string {
	if (bytes <= 0) return "0";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a report as an aligned table plus an actionable summary.
 * Healthy entries are collapsed to a count so the output stays scannable.
 */
export function formatReport(report: CorpusReport, options: IndexOptions = {}): string {
	const includeHealthy = options.includeHealthy ?? true;
	const rows = report.entries.map((entry) => ({
		entry,
		badge: issueBadge(entry),
		title: entry.title ?? "",
	}));
	const attention = rows.filter((row) => row.badge !== "ok");
	const shown = includeHealthy ? rows : attention;

	const lines: string[] = [];
	const healthy = rows.length - attention.length;
	const summary =
		attention.length === 0
			? `${rows.length} paper(s), all healthy`
			: `${rows.length} paper(s): ${healthy} healthy, ${attention.length} need attention`;
	lines.push(summary, `directory: ${report.papersDir}`, "");

	if (shown.length > 0) {
		const flags = (entry: CorpusEntry): string =>
			[
				entry.pdf ? "" : "pdf",
				entry.sourceDir ? "" : "src",
				entry.markdown ? "" : "md",
				entry.issues.some((issue) => issue.kind === "stale-markdown") ? "stale" : "",
			]
				.filter(Boolean)
				.join(",");

		const idWidth = Math.max(4, ...shown.map((row) => row.entry.id.length));
		const titleWidth = Math.min(58, Math.max(12, ...shown.map((row) => row.title.length)));

		for (const { entry, badge, title: entryTitle } of shown) {
			const marker = badge === "ok" ? "✓" : badge === "error" ? "✗" : badge === "warn" ? "!" : "·";
			const missing = flags(entry);
			const title = entryTitle.length > titleWidth ? `${entryTitle.slice(0, titleWidth - 1)}…` : entryTitle;
			lines.push(
				[
					`${marker} ${entry.id.padEnd(idWidth)}`,
					title.padEnd(titleWidth),
					humanBytes(entry.bytes).padStart(8),
					missing ? ` missing: ${missing}` : "",
				].join("  "),
			);
		}
		lines.push("");
	}

	const warnings = attention.filter((row) => row.badge === "error" || row.badge === "warn");
	for (const { entry, badge } of [...warnings, ...attention.filter((row) => row.badge === "info")]) {
		for (const issue of entry.issues.filter((candidate) => candidate.level !== "info" || badge === "info")) {
			const marker = issue.level === "error" ? "✗" : issue.level === "warn" ? "!" : "·";
			lines.push(`${marker} ${entry.id}: ${issue.message}`);
		}
	}

	if (report.legacy.length > 0) {
		lines.push("", ...report.legacy.map((name) => `· flat file ${name} (pre-<id>/ layout; not managed)`));
	}
	if (report.unknown.length > 0) {
		lines.push("", ...report.unknown.map((name) => `· unrecognised file ${name}`));
	}

	return lines.join("\n");
}

/** One-line verdict for tool results that also carry structured data. */
export function summarizeReport(report: CorpusReport): string {
	const counts = new Map<CorpusBadge, number>();
	for (const entry of report.entries) {
		const badge = issueBadge(entry);
		counts.set(badge, (counts.get(badge) ?? 0) + 1);
	}

	const broken = counts.get("error") ?? 0;
	const incomplete = counts.get("warn") ?? 0;
	const parts = [`${report.entries.length} paper(s)`];
	if (broken > 0) parts.push(`${broken} broken`);
	if (incomplete > 0) parts.push(`${incomplete} incomplete`);
	if (report.legacy.length > 0) parts.push(`${report.legacy.length} legacy flat file(s)`);
	return parts.join(", ");
}
