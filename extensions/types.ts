/**
 * Shared types for the arXiv pipeline. Nothing here imports `pi`, so the whole
 * converter can run standalone (fixtures, CLI) as well as inside the extension.
 *
 * A note on `exactOptionalPropertyTypes`:
 * option bags and parsed-metadata fields below are declared `?: T | undefined`
 * on purpose. These objects are assembled from partial inputs (CLI flags,
 * settings, an XML response with absent tags), and "absent" and "explicitly
 * undefined" are the same thing to every consumer. Writing `| undefined`
 * documents that, instead of forcing conditional-spread noise at each call
 * site. Fields that must be present are still non-optional.
 */

/** Minimal shell-exec surface; `pi.exec` satisfies it, so does a child_process wrapper. */
export interface ExecResultLike {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean | undefined;
}

export interface ExecOptionsLike {
	cwd?: string | undefined;
	timeout?: number | undefined;
	signal?: AbortSignal | undefined;
}

export type ExecLike = (command: string, args: string[], options?: ExecOptionsLike) => Promise<ExecResultLike>;

export type WarningLevel = "info" | "warn" | "error";

export interface ConvertWarning {
	rule: string;
	level: WarningLevel;
	message: string;
}

/** Metadata parsed from the arXiv Atom API. */
export interface ArxivMeta {
	id: string;
	version?: string | undefined;
	title: string;
	authors: string[];
	abstract: string;
	categories: string[];
	primaryCategory?: string | undefined;
	published?: string | undefined;
	updated?: string | undefined;
	doi?: string | undefined;
	comment?: string | undefined;
	journalRef?: string | undefined;
	absUrl: string;
	pdfUrl: string;
	htmlUrl: string;
}

export type TableMode = "gfm" | "html";

export interface ConvertOptions {
	/** Directory containing the LaTeX source (main.tex + figures/). */
	workDir: string;
	/** Explicit main .tex file (relative to workDir or absolute). */
	mainTex?: string | undefined;
	/** Output markdown path (default: `<workDir>/<basename(workDir)>.md`). */
	outFile?: string | undefined;
	/** Render figure PDFs to PNG with pdftoppm. */
	figures?: boolean | undefined;
	/** DPI for rendered figures. */
	figureDpi?: number | undefined;
	/** How repaired tables are emitted. */
	tableMode?: TableMode | undefined;
	/** Keep the raw pandoc output next to the result for inspection. */
	keepIntermediate?: boolean | undefined;
	/** arXiv metadata when the source came from a fetch; used for the header. */
	arxivMeta?: ArxivMeta | undefined;
	/** Reuse a previous conversion when nothing influential changed (default true). */
	cache?: boolean | undefined;
	/** Ignore any cache entry and convert again. */
	force?: boolean | undefined;
}

export interface ConvertStats {
	lines: number;
	images: number;
	tables: number;
	tablesRebuilt: number;
	figuresRecovered: number;
	refs: number;
	equations: number;
	citationsUnresolved: boolean;
}

export interface ConvertResult {
	ok: boolean;
	markdownPath?: string | undefined;
	rawMarkdownPath?: string | undefined;
	figures: string[];
	stats: ConvertStats;
	warnings: ConvertWarning[];
	/** True when the result came from a cache hit rather than a fresh run. */
	cached?: boolean | undefined;
}

/** Injected outputs so the converter stays testable and quiet in non-TUI modes. */
export interface ConvertIO {
	exec: ExecLike;
	log?: ((message: string) => void) | undefined;
	/** Cancels the external tools and propagates into the rule pipeline. */
	signal?: AbortSignal | undefined;
}
