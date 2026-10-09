/**
 * LaTeX source analysis.
 *
 * This is what makes the pipeline general: instead of a hand-maintained
 * label→number table, we replay LaTeX's counters over the flattened source, so
 * `\ref{eq:gate}` resolves to 13 and `\ref{app:implementation}` to "C" for any
 * paper, not just the one this package was born from.
 */

import { dirname, resolve } from "node:path";
import { exists, listDir, readText } from "../util/fsx.ts";

// ---------------------------------------------------------------- brace utils

/** Read a `{...}` group starting at `openIndex` (which must point at `{`). */
export function readBraced(text: string, openIndex: number): { content: string; end: number } | undefined {
	if (text[openIndex] !== "{") return undefined;
	let depth = 0;
	for (let i = openIndex; i < text.length; i++) {
		const char = text[i];
		if (char === "\\") {
			i++;
			continue;
		}
		if (char === "{") depth++;
		else if (char === "}") {
			depth--;
			if (depth === 0) return { content: text.slice(openIndex + 1, i), end: i + 1 };
		}
	}
	return undefined;
}

/** Split on a top-level separator, respecting braces, `$...$` and `\`-escapes. */
export function splitTopLevel(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let math = false;
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const char = text[i] ?? "";
		if (char === "\\") {
			if (depth === 0 && !math && separator && text.startsWith(separator, i)) {
				parts.push(current);
				current = "";
				i += separator.length - 1;
				continue;
			}
			current += char + (text[i + 1] ?? "");
			i++;
			continue;
		}
		if (char === "$") math = !math;
		if (!math && char === "{") depth++;
		else if (!math && char === "}") depth--;
		if (!math && depth === 0 && separator && text.startsWith(separator, i)) {
			parts.push(current);
			current = "";
			i += separator.length - 1;
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

/** Macros that carry only presentation and can be unwrapped with their arguments. */
export interface UnwrapMacro {
	name: string;
	arity: number;
	wrap?: (parts: string[]) => string;
}

export const INLINE_MACROS: UnwrapMacro[] = [
	{ name: "textbf", arity: 1, wrap: ([x]) => `**${x}**` },
	{ name: "bf", arity: 1, wrap: ([x]) => `**${x}**` },
	{ name: "textit", arity: 1, wrap: ([x]) => `*${x}*` },
	{ name: "emph", arity: 1, wrap: ([x]) => `*${x}*` },
	{ name: "it", arity: 1, wrap: ([x]) => `*${x}*` },
	{ name: "texttt", arity: 1, wrap: ([x]) => `\`${x}\`` },
	{ name: "textsc", arity: 1 },
	{ name: "textsuperscript", arity: 1 },
	{ name: "textsubscript", arity: 1 },
	{ name: "text", arity: 1 },
	{ name: "mathrm", arity: 1 },
	{ name: "mbox", arity: 1 },
	{ name: "shortstack", arity: 1 },
	{ name: "makecell", arity: 1 },
	{ name: "cells", arity: 1 },
	{ name: "ensuremath", arity: 1 },
	{ name: "protect", arity: 1 },
	{ name: "footnote", arity: 1, wrap: () => "" },
	{ name: "thanks", arity: 1, wrap: () => "" },
	{ name: "correspondingauthor", arity: 1, wrap: () => "" },
	{ name: "metricvalue", arity: 1 },
	{ name: "metricbest", arity: 1, wrap: ([x]) => `**${x}**` },
	{ name: "metricsecond", arity: 1, wrap: ([x]) => `*${x}*` },
	{ name: "metricthird", arity: 1 },
	{ name: "metricpm", arity: 2, wrap: ([mean, sd]) => `${mean} ± ${sd}` },
	{ name: "multirowcell", arity: 2, wrap: ([, content]) => content ?? "" },
	{ name: "multirow", arity: 3, wrap: ([, , content]) => content ?? "" },
	{ name: "multicolumn", arity: 3, wrap: ([, , content]) => content ?? "" },
	{ name: "href", arity: 2, wrap: ([url, text]) => `[${text}](${url})` },
	{ name: "url", arity: 1 },
];

const MATH_COMMANDS: Array<[string, string]> = [
	["\\%", "%"],
	["\\&", "&"],
	["\\_", "_"],
	["\\#", "#"],
	["\\$", "$"],
	["\\{", "{"],
	["\\}", "}"],
	["\\ ", " "],
	["~", " "],
	["\\,", " "],
	["\\;", " "],
	["\\!", ""],
	["\\quad", " "],
	["\\qquad", " "],
];

/** Symbol macros that appear in prose (author footnotes, captions, tables). */
const SYMBOL_MACROS: Array<[RegExp, string]> = [
	[/\\(?:dag|dagger)\b\{\}/g, "†"],
	[/\\(?:dag|dagger)\b/g, "†"],
	[/\\(?:ddag|ddagger)\b/g, "‡"],
	[/\\S\b/g, "§"],
	[/\\P\b/g, "¶"],
	[/\\textdegree\b/g, "°"],
	[/\\copyright\b/g, "©"],
	[/\\&/g, "&"],
];

/** Expand `\macro{a}{b}` style wrappers, innermost-first, repeatedly. */
export function expandBracedMacros(input: string, macros: UnwrapMacro[] = INLINE_MACROS, maxPasses = 8): string {
	let text = input;
	for (let pass = 0; pass < maxPasses; pass++) {
		let changed = false;
		for (const macro of macros) {
			const needle = `\\${macro.name}`;
			let from = 0;
			while (true) {
				const at = text.indexOf(needle, from);
				if (at < 0) break;
				const after = text[at + needle.length] ?? "";
				if (after !== "{" && after !== "[" && !/\s/.test(after)) {
					from = at + needle.length;
					continue;
				}
				let cursor = at + needle.length;
				while (text[cursor] === "[") {
					const close = text.indexOf("]", cursor);
					if (close < 0) break;
					cursor = close + 1;
				}
				const args: string[] = [];
				let ok = true;
				for (let i = 0; i < macro.arity; i++) {
					while (/\s/.test(text[cursor] ?? "")) cursor++;
					const group = text[cursor] === "{" ? readBraced(text, cursor) : undefined;
					if (!group) {
						ok = false;
						break;
					}
					args.push(group.content);
					cursor = group.end;
				}
				if (!ok) {
					from = at + needle.length;
					continue;
				}
				const replacement = macro.wrap ? macro.wrap(args) : (args[args.length - 1] ?? "");
				text = text.slice(0, at) + replacement + text.slice(cursor);
				changed = true;
				from = at + replacement.length;
			}
		}
		if (!changed) break;
	}
	return text;
}

/** Best-effort LaTeX → Markdown for short inline spans (abstracts, captions, cells). */
export function latexInlineToMarkdown(input: string): string {
	let text = expandBracedMacros(input);
	text = text.replace(/\\(?:cite[tp]?|citep|citealp|ref|eqref)\{[^}]*\}/g, "");
	text = text.replace(/\\(?:etal|ie|eg)\b/g, (match) => `${match.slice(1)}.`);
	text = text.replace(/\\(?:protect|noindent|sloppy|centering|relax|small|footnotesize|scriptsize|tiny|normalsize|large|Large)\b/g, "");
	text = text.replace(/---/g, "—").replace(/--/g, "–");
	text = text.replace(/\\\\/g, " ");
	for (const [from, to] of MATH_COMMANDS) text = text.split(from).join(to);
	for (const [pattern, symbol] of SYMBOL_MACROS) text = text.replace(pattern, symbol);
	text = text.replace(/\s+/g, " ").trim();
	return text;
}

// ---------------------------------------------------------------- counters

export type LabelKind = "eq" | "fig" | "tab" | "sec" | "app" | "alg" | "other";

export interface LabelMaps {
	/** label → display text, e.g. `eq:gate` → "13", `sec:setup` → "4.1", `app:optimization` → "A" */
	all: Map<string, string>;
	kind: Map<string, LabelKind>;
}

export interface ParsedTable {
	tex: string;
	caption?: string | undefined;
	rows: string[][];
	columns: number;
	environment: string;
}

export interface OutlineEntry {
	level: 1 | 2 | 3;
	title: string;
	/** undefined for starred (unnumbered) sections */
	number?: string | undefined;
	appendix: boolean;
}

export interface TexAnalysis {
	mainFile: string;
	sourceFiles: string[];
	flattened: string;
	abstract?: string | undefined;
	title?: string | undefined;
	authors: string[];
	affiliations: string[];
	labels: LabelMaps;
	outline: OutlineEntry[];
	figureCaptions: string[];
	tableCaptions: string[];
	tables: ParsedTable[];
	graphics: string[];
	bibFiles: string[];
	hasAppendix: boolean;
}

const TABLE_ENVS = new Set(["table", "table*", "sidewaystable", "longtable"]);
const NUMBERED_EQ_ENVS = new Set(["equation", "align", "alignat", "gather", "multline", "eqnarray", "flalign"]);
const TABULAR_ENVS = "tabular\\*?x?|longtable";

function letterFor(index: number): string {
	let n = index;
	let out = "";
	do {
		out = String.fromCharCode(65 + (n % 26)) + out;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return out;
}

/** Resolve `\input`/`\include` recursively so scanning sees document order. */
export async function loadTexGraph(
	mainFile: string,
	maxDepth = 4,
	seen = new Set<string>(),
	depth = 0,
): Promise<{ text: string; files: string[] }> {
	const absolute = resolve(mainFile);
	if (depth > maxDepth || seen.has(absolute)) return { text: "", files: [] };
	seen.add(absolute);

	let source: string;
	try {
		source = await readText(absolute);
	} catch {
		return { text: "", files: [] };
	}

	const files = [absolute];
	let text = "";
	const includeRe = /\\(?:input|include|subfile)\{([^}]+)\}/g;
	let cursor = 0;
	for (const match of source.matchAll(includeRe)) {
		text += source.slice(cursor, match.index);
		const target = match[1] ?? "";
		const candidates = [target, `${target}.tex`].map((name) => resolve(dirname(absolute), name));
		let loaded = false;
		for (const candidate of candidates) {
			if (await exists(candidate)) {
				const nested = await loadTexGraph(candidate, maxDepth, seen, depth + 1);
				text += nested.text;
				files.push(...nested.files);
				loaded = true;
				break;
			}
		}
		if (!loaded) text += match[0];
		cursor = match.index + match[0].length;
	}
	text += source.slice(cursor);
	return { text, files };
}

const TOKEN_RE = new RegExp(
	[
		"\\\\appendix\\b",
		`\\\\begin\\{(?:equation\\*?|align\\*?|alignat\\*?|gather\\*?|multline\\*?|eqnarray\\*?|figure\\*?|wrapfigure|sidewaysfigure|SCfigure|table\\*?|sidewaystable|longtable|abstract|${TABULAR_ENVS})\\}(?:\\[[^\\]]*\\]|\\{[^{}]*\\})*`,
		`\\\\end\\{(?:equation\\*?|align\\*?|alignat\\*?|gather\\*?|multline\\*?|eqnarray\\*?|figure\\*?|wrapfigure|sidewaysfigure|SCfigure|table\\*?|sidewaystable|longtable|abstract|${TABULAR_ENVS})\\}`,
		"\\\\subsubsection\\*?\\{",
		"\\\\subsection\\*?\\{",
		"\\\\section\\*?\\{",
		"\\\\captionsetup\\{",
		"\\\\caption\\{",
		"\\\\label\\{[^}]*\\}",
		"\\\\includegraphics(?:\\[[^\\]]*\\])?\\{",
		"\\\\bibliography\\{",
		"\\\\title\\{",
		"\\\\author(?:\\[[^\\]]*\\])?\\{",
		"\\\\affil(?:\\[[^\\]]*\\])?\\{",
	].join("|"),
	"g",
);

/** Replay LaTeX counters and collect everything the Markdown rules need. */
export function analyzeTex(flattened: string, mainFile: string, sourceFiles: string[]): TexAnalysis {
	const labels: LabelMaps = { all: new Map(), kind: new Map() };
	const outline: OutlineEntry[] = [];
	const figureCaptions: string[] = [];
	const tableCaptions: string[] = [];
	const tables: ParsedTable[] = [];
	const graphics: string[] = [];
	const bibFiles: string[] = [];
	const authors: string[] = [];
	const affiliations: string[] = [];

	const counters = { eq: 0, fig: 0, tab: 0, sec: 0, sub: 0, subsub: 0 };
	let appendix = false;
	let appendixIndex = -1;
	let forcedTableCaption = false;
	let abstract: string | undefined;
	let title: string | undefined;
	const envStack: string[] = [];
	let currentTable: ParsedTable | undefined;

	const currentSection = (): string => {
		const base = appendix ? letterFor(appendixIndex) : String(counters.sec);
		if (counters.sub > 0) return `${base}.${counters.sub}${counters.subsub > 0 ? `.${counters.subsub}` : ""}`;
		return base;
	};

	const pushOutline = (level: 1 | 2 | 3, starred: boolean, rawTitle: string): void => {
		outline.push({
			level,
			title: latexInlineToMarkdown(rawTitle),
			number: starred ? undefined : currentSection(),
			appendix,
		});
	};

	TOKEN_RE.lastIndex = 0;
	for (const match of flattened.matchAll(TOKEN_RE)) {
		const token = match[0];
		if (token.startsWith("\\appendix")) {
			appendix = true;
			counters.sec = 0;
			counters.sub = 0;
			counters.subsub = 0;
			appendixIndex = -1;
			continue;
		}
		if (token.startsWith("\\begin{")) {
			const env = token.slice(7, token.indexOf("}"));
			envStack.push(env);
			const bare = env.replace(/\*$/, "");
			// LaTeX steps figure/table counters at \caption; equations at \begin.
			if (NUMBERED_EQ_ENVS.has(env) && !env.endsWith("*")) counters.eq++;
			else if (bare === "abstract") {
				const end = flattened.indexOf("\\end{abstract}", match.index + token.length);
				if (end > 0) abstract = flattened.slice(match.index + token.length, end).trim();
			} else if (bare === "tabular" || bare === "tabularx" || bare === "tabular*" || bare === "tabularx*") {
				currentTable = { tex: "", rows: [], columns: 0, environment: bare };
			}
			continue;
		}
		if (token.startsWith("\\end{")) {
			const env = token.slice(5, token.indexOf("}"));
			const bare = env.replace(/\*$/, "");
			if ((bare === "tabular" || bare === "tabularx" || bare === "tabular*") && currentTable) {
				tables.push(currentTable);
				currentTable = undefined;
			}
			const at = envStack.lastIndexOf(env);
			if (at >= 0) envStack.splice(at, 1);
			continue;
		}
		if (token.startsWith("\\section")) {
			const starred = token.includes("*");
			const group = readBraced(flattened, match.index + token.length - 1);
			if (!starred) {
				counters.sec++;
				counters.sub = 0;
				counters.subsub = 0;
				if (appendix) appendixIndex++;
			}
			pushOutline(1, starred, group?.content ?? "");
			continue;
		}
		if (token.startsWith("\\subsection")) {
			const starred = token.includes("*");
			const group = readBraced(flattened, match.index + token.length - 1);
			if (!starred) {
				counters.sub++;
				counters.subsub = 0;
			}
			pushOutline(2, starred, group?.content ?? "");
			continue;
		}
		if (token.startsWith("\\subsubsection")) {
			const starred = token.includes("*");
			const group = readBraced(flattened, match.index + token.length - 1);
			if (!starred) counters.subsub++;
			pushOutline(3, starred, group?.content ?? "");
			continue;
		}
		if (token === "\\title{") {
			const group = readBraced(flattened, match.index + token.length - 1);
			if (group) title = latexInlineToMarkdown(group.content);
			continue;
		}
		if (token.startsWith("\\author")) {
			const brace = token.lastIndexOf("{");
			const group = readBraced(flattened, match.index + brace);
			if (group) {
				for (const part of group.content.split(/\\and|,(?![^{]*\})|;/)) {
					const name = latexInlineToMarkdown(part)
						.replace(/[*\u2020\u2021]/g, "")
						.trim();
					if (name) authors.push(name);
				}
			}
			continue;
		}
		if (token.startsWith("\\affil")) {
			const brace = token.lastIndexOf("{");
			const group = readBraced(flattened, match.index + brace);
			if (group?.content) affiliations.push(latexInlineToMarkdown(group.content));
			continue;
		}
		if (token === "\\captionsetup{") {
			const group = readBraced(flattened, match.index + token.length - 1);
			if (/type\s*=\s*table/.test(group?.content ?? "")) forcedTableCaption = true;
			continue;
		}
		if (token === "\\caption{") {
			const group = readBraced(flattened, match.index + token.length - 1);
			const inline = latexInlineToMarkdown(group?.content ?? "");
			const tableish = forcedTableCaption || envStack.some((env) => TABLE_ENVS.has(env));
			forcedTableCaption = false;
			if (tableish) {
				counters.tab++;
				tableCaptions.push(inline);
				if (currentTable && !currentTable.caption) currentTable.caption = inline;
			} else {
				counters.fig++;
				figureCaptions.push(inline);
			}
			continue;
		}
		if (token.startsWith("\\includegraphics")) {
			const group = readBraced(flattened, match.index + token.length - 1);
			if (group?.content) graphics.push(group.content.trim());
			continue;
		}
		if (token === "\\bibliography{") {
			const group = readBraced(flattened, match.index + token.length - 1);
			if (group?.content)
				bibFiles.push(
					...group.content
						.split(",")
						.map((name) => name.trim())
						.filter(Boolean),
				);
			continue;
		}
		if (token.startsWith("\\label{")) {
			const key = token.slice(7, token.length - 1);
			const [prefix] = key.split(":");
			let value: string | undefined;
			let kind: LabelKind = "other";
			switch (prefix) {
				case "eq":
					value = String(counters.eq);
					kind = "eq";
					break;
				case "fig":
					value = String(counters.fig);
					kind = "fig";
					break;
				case "tab":
					value = String(counters.tab);
					kind = "tab";
					break;
				case "sec":
					value = currentSection();
					kind = "sec";
					break;
				case "app":
					value = currentSection();
					kind = "app";
					break;
				case "alg":
					value = String(counters.eq);
					kind = "alg";
					break;
				default:
					value = currentSection();
			}
			if (value) {
				labels.all.set(key, value);
				labels.kind.set(key, kind);
			}
		}
	}

	return {
		mainFile,
		sourceFiles,
		flattened,
		abstract,
		title,
		authors,
		affiliations,
		labels,
		outline,
		figureCaptions,
		tableCaptions,
		tables,
		graphics,
		bibFiles,
		hasAppendix: appendix,
	};
}

// ---------------------------------------------------------------- tabulars

const CELL_MATH_SYMBOLS: Array<[RegExp, string]> = [
	[/\$\s*\\uparrow\s*\$/g, "↑"],
	[/\$\s*\\downarrow\s*\$/g, "↓"],
	[/\$\s*\\pm\s*\$/g, "±"],
	[/\$\s*\\times\s*\$/g, "×"],
	[/\$\s*\\rightarrow\s*\$/g, "→"],
	[/\$\s*\\to\s*\$/g, "→"],
	[/\$\s*\\cdot\s*\$/g, "·"],
	[/\$\s*\\%\s*\$/g, "%"],
	[/\$\s*\\approx\s*\$/g, "≈"],
];

/** Escape cell content for GFM (the `|` separator). */
function escapeCell(cell: string): string {
	return cell.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function cleanCell(raw: string): string {
	let cell = expandBracedMacros(raw.trim());
	cell = cell.replace(/\\(?:cellcolor|rowcolor|columncolor|color)\s*\{[^{}]*\}\s*/g, "");
	cell = latexInlineToMarkdown(cell);
	for (const [pattern, symbol] of CELL_MATH_SYMBOLS) cell = cell.replace(pattern, symbol);
	return cell.replace(/\s+/g, " ").trim();
}

const ROW_SEPARATOR_RE = /\\(?:hline|toprule|midrule|bottomrule|cmidrule\s*(?:\([^)]*\))?\s*\{[^}]*\}|cline\s*\{[^}]*\}|hdashline)\s*/g;

/** `\multicolumn{n}{spec}{content}` — expanded horizontally so rows stay column-aligned. */
const MULTICOLUMN_RE = /^\s*\\multicolumn\s*\{(\d+)\}\s*\{[^{}]*\}\s*\{([\s\S]*)\}\s*$/;

/** Parse one tabular body into sanitized cells. */
export function parseTabularBody(body: string): { rows: string[][]; columns: number } {
	const rows: string[][] = [];
	for (const rawRow of splitTopLevel(body, "\\\\")) {
		const stripped = rawRow.replace(ROW_SEPARATOR_RE, " ").trim();
		if (!stripped) continue;
		const cells = splitTopLevel(stripped, "&").flatMap((raw) => {
			const span = MULTICOLUMN_RE.exec(raw);
			if (span) {
				const width = Math.max(1, Number(span[1]));
				return [cleanCell(span[2] ?? ""), ...Array<string>(width - 1).fill("")];
			}
			return [cleanCell(raw)];
		});
		if (cells.every((cell) => cell === "")) continue;
		rows.push(cells);
	}
	const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
	return { rows, columns };
}

/** Attach parsed rows to every tabular collected by `analyzeTex`. */
export function parseTablesFromTex(flattened: string, tables: ParsedTable[]): ParsedTable[] {
	const bodies: string[] = [];
	const beginRe = new RegExp(`\\\\begin\\{(${TABULAR_ENVS})\\}`, "g");
	for (const match of flattened.matchAll(beginRe)) {
		const env = match[1] ?? "tabular";
		let cursor = match.index + match[0].length;
		// tabular*{width}{spec} / tabularx{width}{spec} take two mandatory arguments
		const specCount = /^(tabular\*|tabularx\*?)$/.test(env) ? 2 : 1;
		for (let i = 0; i < specCount; i++) {
			while (/\s/.test(flattened[cursor] ?? "")) cursor++;
			if (flattened[cursor] === "{") {
				const spec = readBraced(flattened, cursor);
				cursor = spec ? spec.end : cursor;
			}
		}
		const end = flattened.indexOf(`\\end{${env}}`, cursor);
		bodies.push(end > 0 ? flattened.slice(cursor, end) : flattened.slice(cursor));
	}

	return tables.map((table, index) => {
		const parsed = parseTabularBody(bodies[index] ?? "");
		return { ...table, tex: bodies[index] ?? "", rows: flattenGroupHeader(parsed.rows), columns: parsed.columns };
	});
}

/**
 * Two-level LaTeX headers have no GFM equivalent: carry the group label forward
 * and merge it with the sub-header, e.g. ["", "ALFWorld", …] + ["Method", "Seen SR", …]
 * → ["Method", "ALFWorld Seen SR", …].
 */
export function flattenGroupHeader(rows: string[][]): string[][] {
	if (rows.length < 2) return rows;
	const out = [...rows];
	let guard = 0;
	while (out.length >= 2 && guard++ < 3) {
		const group = out[0] ?? [];
		const next = out[1] ?? [];
		const columns = Math.max(group.length, next.length);
		const filled = group.filter((cell) => cell !== "").length;
		if (filled === 0 || filled > columns / 2) break;
		const merged: string[] = [];
		let carry = "";
		for (let i = 0; i < columns; i++) {
			const groupCell = (group[i] ?? "").trim();
			if (groupCell) carry = groupCell;
			const head = (next[i] ?? "").trim();
			merged.push([carry, head].filter(Boolean).join(" ").trim());
		}
		out.splice(0, 2, merged);
	}
	return out;
}

export function toGfmTable(table: ParsedTable): string {
	if (table.rows.length === 0) return "";
	const columns = table.columns || Math.max(...table.rows.map((row) => row.length));
	const pad = (row: string[]): string[] => {
		const cells = row.map(escapeCell);
		while (cells.length < columns) cells.push("");
		return cells.slice(0, columns);
	};
	const [header, ...rest] = table.rows;
	const lines = [`| ${pad(header ?? []).join(" | ")} |`, `|${Array(columns).fill(":---").join("|")}|`];
	for (const row of rest) lines.push(`| ${pad(row).join(" | ")} |`);
	return lines.join("\n");
}

// ---------------------------------------------------------------- discovery

export async function findMainTex(workDir: string): Promise<string | undefined> {
	const entries = await listDir(workDir);
	const texFiles = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".tex"));
	if (texFiles.length === 0) return undefined;
	const preferred = texFiles.find((entry) => /^main\.tex$/i.test(entry.name)) ?? texFiles.find((entry) => /^paper\.tex$/i.test(entry.name));
	if (preferred) return preferred.path;
	for (const entry of texFiles) {
		const text = await readText(entry.path).catch(() => "");
		if (/\\documentclass/.test(text)) return entry.path;
	}
	return texFiles[0]?.path;
}

/** Load and analyze a source directory in one call. */ export async function analyzeSourceDir(
	workDir: string,
	mainTex?: string,
): Promise<TexAnalysis> {
	const mainFile = mainTex ? resolve(workDir, mainTex) : await findMainTex(workDir);
	if (!mainFile) throw new Error(`No .tex file found in ${workDir}`);
	const { text, files } = await loadTexGraph(mainFile);
	const analysis = analyzeTex(text, mainFile, files);
	analysis.tables = parseTablesFromTex(text, analysis.tables);
	return analysis;
}
