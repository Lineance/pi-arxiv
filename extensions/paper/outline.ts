/**
 * Markdown outline parsing and section extraction.
 *
 * Reading one section of a converted paper should not cost the whole file: a
 * 700-line paper is ~75 KB, and the answer to "how does their weighting work"
 * lives in ten of those lines.
 *
 * Pure string handling, deliberately: the converted Markdown already carries the
 * LaTeX numbering, so no LaTeX analysis is needed here, and the whole module is
 * testable without a filesystem.
 */

export interface Heading {
	/** 1 for `#`, 2 for `##`, … */
	level: number;
	/** Heading text with the leading hashes removed. */
	title: string;
	/** Leading document number, when the heading has one (`3.2`, `Appendix A.`, `A.1`). */
	number?: string | undefined;
	/** Zero-based index of the heading line. */
	startLine: number;
	/** Zero-based, exclusive: the line before the next heading of level <= this one. */
	endLine: number;
}

export interface Outline {
	headings: Heading[];
	lines: string[];
}

/** A fence delimiter, with its indentation, so nested fences stay paired. */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * A leading number as it appears in a converted paper:
 * `3.2`, `3.2.1`, `Appendix A.`, `A.1`, `A.1.2`, `1`.
 */
const HEADING_NUMBER_RE = /^(Appendix\s+[A-Z]\.|[A-Z]\.\d+(?:\.\d+)*|\d+(?:\.\d+)*)\.?\s+/;

/**
 * Parse the heading structure of a Markdown document.
 *
 * Fenced code blocks are skipped: a shell comment inside a fence is not a
 * heading, and papers do contain code listings.
 */
export function parseOutline(markdown: string): Outline {
	const lines = markdown.split("\n");
	const headings: Heading[] = [];
	let fence: string | undefined;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		const fenceMatch = FENCE_RE.exec(line);
		if (fenceMatch?.[1]) {
			if (fence === undefined) fence = fenceMatch[1][0];
			else if (fenceMatch[1][0] === fence) fence = undefined;
			continue;
		}
		if (fence !== undefined) continue;

		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (!match) continue;

		const title = (match[2] ?? "").trim();
		const number = HEADING_NUMBER_RE.exec(title)?.[1]?.replace(/\.$/, "");
		headings.push({ level: (match[1] ?? "#").length, title, number, startLine: i, endLine: lines.length });
	}

	// A heading owns everything up to the next heading of the same or higher level.
	for (let i = 0; i < headings.length; i++) {
		const heading = headings[i];
		if (!heading) continue;
		const next = headings.slice(i + 1).find((candidate) => candidate.level <= heading.level);
		heading.endLine = next ? next.startLine : lines.length;
	}

	return { headings, lines };
}

export interface TocEntry {
	level: number;
	number?: string | undefined;
	title: string;
	/** Lines in this heading's own section, including children. */
	lines: number;
}

export function tableOfContents(outline: Outline): TocEntry[] {
	return outline.headings.map((heading) => ({
		level: heading.level,
		number: heading.number,
		title: heading.title,
		lines: heading.endLine - heading.startLine,
	}));
}

/**
 * Render an indented table of contents.
 *
 * The number is not printed as a separate column: a converted paper already
 * carries it in the heading text ("2.1 Empirical Analysis"), so a column would
 * duplicate it. `TocEntry.number` stays available for callers that need it.
 */
export function formatTableOfContents(outline: Outline): string {
	if (outline.headings.length === 0) return "This document has no Markdown headings.";
	return outline.headings
		.map((heading) => {
			const indent = "  ".repeat(Math.max(0, heading.level - 1));
			return `${indent}${heading.title}  (${heading.endLine - heading.startLine} lines)`;
		})
		.join("\n");
}

// ---------------------------------------------------------------- selection

export type SelectResult =
	| { kind: "found"; heading: Heading; how: "number" | "title" | "partial" }
	| { kind: "ambiguous"; candidates: Heading[] }
	| { kind: "missing"; suggestions: Heading[] };

/** Normalise a title for comparison: drop markup, unify dashes, collapse case. */
function normalize(value: string): string {
	return value
		.replace(/\*\*|\*|`|_/g, "")
		.replace(/[\u2010-\u2015]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * Resolve a section selector against the outline.
 *
 * Accepts the number (`3.2`, `A.1`, `Appendix A`), the title (`Empirical
 * Analysis`), or a fragment of it — an exact match always wins over a partial
 * one, so a short query cannot shadow the section it names.
 */
export function selectSection(outline: Outline, selector: string): SelectResult {
	const query = normalize(selector.replace(/^#+/, ""));
	if (!query) return { kind: "missing", suggestions: outline.headings.slice(0, 12) };

	const withoutNumberWord = query.replace(/^appendix\s+/, "");
	const byNumber = outline.headings.filter((heading) => {
		const number = heading.number ? normalize(heading.number).replace(/^appendix\s+/, "") : undefined;
		return number !== undefined && (number === withoutNumberWord || number === query);
	});
	if (byNumber.length === 1 && byNumber[0]) return { kind: "found", heading: byNumber[0], how: "number" };

	const exact = outline.headings.filter((heading) => {
		const title = normalize(heading.title);
		const bare = normalize(heading.title.replace(HEADING_NUMBER_RE, ""));
		return title === query || bare === query;
	});
	if (exact.length === 1 && exact[0]) return { kind: "found", heading: exact[0], how: "title" };

	const partial = outline.headings.filter((heading) => {
		const title = normalize(heading.title);
		const bare = normalize(heading.title.replace(HEADING_NUMBER_RE, ""));
		return title.includes(query) || bare.includes(query);
	});
	if (partial.length === 1 && partial[0]) return { kind: "found", heading: partial[0], how: "partial" };
	if (partial.length > 1) return { kind: "ambiguous", candidates: partial };

	// Nothing matched: offer the closest headings rather than an empty answer.
	const words = query.split(/\s+/).filter((word) => word.length > 2);
	const scored = outline.headings
		.map((heading) => ({
			heading,
			score: words.filter((word) => normalize(heading.title).includes(word)).length,
		}))
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score);

	return { kind: "missing", suggestions: (scored.length > 0 ? scored.map((entry) => entry.heading) : outline.headings).slice(0, 8) };
}

export interface ExtractOptions {
	/** Include nested subsections (default true). */
	includeSubsections?: boolean | undefined;
	/** Cap the returned text, appending a notice when it truncates. */
	maxBytes?: number | undefined;
}

/**
 * Render one section as Markdown.
 *
 * With `includeSubsections: false` the text stops at the first child heading,
 * which is what you want when a parent section is only a preamble.
 */
export function extractSection(outline: Outline, heading: Heading, options: ExtractOptions = {}): string {
	const includeSubsections = options.includeSubsections ?? true;
	let end = heading.endLine;

	if (!includeSubsections) {
		const child = outline.headings.find((candidate) => candidate.startLine > heading.startLine && candidate.level > heading.level);
		if (child) end = child.startLine;
	}

	const text = outline.lines.slice(heading.startLine, end).join("\n").trimEnd();

	const maxBytes = options.maxBytes ?? 0;
	if (maxBytes > 0 && Buffer.byteLength(text, "utf8") > maxBytes) {
		const slice = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
		// Cut at the last newline so the result cannot end mid-word or mid-escape.
		const cut = slice.lastIndexOf("\n");
		const body = cut > maxBytes / 2 ? slice.slice(0, cut) : slice;
		return `${body}\n\n[${heading.title} truncated at ${maxBytes} bytes; read lines ${heading.startLine + 1}-${end} for the rest]`;
	}
	return text;
}
