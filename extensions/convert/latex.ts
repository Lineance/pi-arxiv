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

/** A located macro invocation: its span in the text and its brace arguments. */
interface MacroCall {
	start: number;
	/** Index just past the last consumed argument. */
	end: number;
	args: string[];
}

/**
 * Skip over optional `[...]` arguments. Returns the offset after them, or
 * `undefined` when a bracket is opened but never closed.
 */
function skipOptionalArgs(text: string, from: number): number | undefined {
	let cursor = from;
	while (text[cursor] === "[") {
		const close = text.indexOf("]", cursor);
		if (close < 0) return undefined;
		cursor = close + 1;
	}
	return cursor;
}

/**
 * Find the next well-formed call of `macro` at or after `from`.
 *
 * A call is well-formed when the name is followed by a brace (or optional args
 * and then a brace) and every one of the macro's arguments is present. Anything
 * else is left untouched: `\texttt` must not be mistaken for `\text`, and a
 * half-written macro must not corrupt the text.
 */
function findMacroCall(text: string, macro: UnwrapMacro, from: number): MacroCall | undefined {
	const needle = `\\${macro.name}`;
	let search = from;
	while (search < text.length) {
		const start = text.indexOf(needle, search);
		if (start < 0) return undefined;

		const next = start + needle.length;
		const after = text[next] ?? "";
		if (after !== "{" && after !== "[" && !/\s/.test(after)) {
			search = next;
			continue;
		}

		const afterOptionals = skipOptionalArgs(text, next);
		if (afterOptionals === undefined) return undefined;
		let cursor: number = afterOptionals;

		const args: string[] = [];
		for (let i = 0; i < macro.arity; i++) {
			while (/\s/.test(text[cursor] ?? "")) cursor++;
			const group = text[cursor] === "{" ? readBraced(text, cursor) : undefined;
			if (!group) {
				args.length = 0;
				break;
			}
			args.push(group.content);
			cursor = group.end;
		}
		if (args.length === macro.arity) return { start, end: cursor, args };
		search = next;
	}
	return undefined;
}

/** Expand every call of one macro, left to right. */
function expandMacro(input: string, macro: UnwrapMacro): { text: string; changed: boolean } {
	let text = input;
	let changed = false;
	let cursor = 0;
	while (cursor < text.length) {
		const call = findMacroCall(text, macro, cursor);
		if (!call) break;
		const replacement = macro.wrap ? macro.wrap(call.args) : (call.args[call.args.length - 1] ?? "");
		text = text.slice(0, call.start) + replacement + text.slice(call.end);
		cursor = call.start + replacement.length;
		changed = true;
	}
	return { text, changed };
}

/**
 * Expand `\macro{a}{b}` style wrappers, innermost-first, repeatedly until the
 * text stops changing. Bounded by `maxPasses` so a self-referential macro
 * definition cannot spin forever.
 */
export function expandBracedMacros(input: string, macros: UnwrapMacro[] = INLINE_MACROS, maxPasses = 8): string {
	let text = input;
	for (let pass = 0; pass < maxPasses; pass++) {
		let changedThisPass = false;
		for (const macro of macros) {
			const result = expandMacro(text, macro);
			text = result.text;
			changedThisPass ||= result.changed;
		}
		if (!changedThisPass) break;
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

/**
 * The token vocabulary the scanner recognises, built fresh per call so there is
 * no shared `lastIndex` state between analyses.
 */
function tokenRegex(): RegExp {
	return new RegExp(
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
}

/** Mutable state threaded through the token handlers. */
interface ScanState {
	flattened: string;
	labels: LabelMaps;
	outline: OutlineEntry[];
	figureCaptions: string[];
	tableCaptions: string[];
	tables: ParsedTable[];
	graphics: string[];
	bibFiles: string[];
	authors: string[];
	affiliations: string[];
	counters: { eq: number; fig: number; tab: number; sec: number; sub: number; subsub: number };
	appendix: boolean;
	appendixIndex: number;
	/** Set by `\captionsetup{type=table}` so the next `\caption` takes a table number. */
	forcedTableCaption: boolean;
	abstract: string | undefined;
	title: string | undefined;
	envStack: string[];
	currentTable: ParsedTable | undefined;
}

type TokenHandler = (state: ScanState, match: RegExpExecArray) => void;

/** The `{...}` immediately after a token that ends in `{`. */
function groupAfterToken(state: ScanState, match: RegExpExecArray): string | undefined {
	return readBraced(state.flattened, match.index + match[0].length - 1)?.content;
}

/** The `{...}` that follows optional `[...]` arguments, e.g. `\author[1]{...}`. */
function groupAtLastBrace(state: ScanState, match: RegExpExecArray): string | undefined {
	const brace = match[0].lastIndexOf("{");
	return brace < 0 ? undefined : readBraced(state.flattened, match.index + brace)?.content;
}

function currentSection(state: ScanState): string {
	const base = state.appendix ? letterFor(state.appendixIndex) : String(state.counters.sec);
	if (state.counters.sub > 0) {
		return `${base}.${state.counters.sub}${state.counters.subsub > 0 ? `.${state.counters.subsub}` : ""}`;
	}
	return base;
}

function pushOutline(state: ScanState, level: 1 | 2 | 3, starred: boolean, rawTitle: string): void {
	state.outline.push({
		level,
		title: latexInlineToMarkdown(rawTitle),
		number: starred ? undefined : currentSection(state),
		appendix: state.appendix,
	});
}

const TABULAR_BARE = new Set(["tabular", "tabularx", "tabular*", "tabularx*"]);

function handleAppendix(state: ScanState): void {
	state.appendix = true;
	state.counters.sec = 0;
	state.counters.sub = 0;
	state.counters.subsub = 0;
	state.appendixIndex = -1;
}

function handleBegin(state: ScanState, match: RegExpExecArray): void {
	const env = match[0].slice(7, match[0].indexOf("}"));
	state.envStack.push(env);
	const bare = env.replace(/\*$/, "");

	// LaTeX steps the figure/table counters at \caption, but the equation
	// counter at \begin — so only equations are counted here.
	if (NUMBERED_EQ_ENVS.has(env) && !env.endsWith("*")) {
		state.counters.eq++;
	} else if (bare === "abstract") {
		const end = state.flattened.indexOf("\\end{abstract}", match.index + match[0].length);
		if (end > 0) state.abstract = state.flattened.slice(match.index + match[0].length, end).trim();
	} else if (TABULAR_BARE.has(bare)) {
		state.currentTable = { tex: "", rows: [], columns: 0, environment: bare };
	}
}

function handleEnd(state: ScanState, match: RegExpExecArray): void {
	const env = match[0].slice(5, match[0].indexOf("}"));
	const bare = env.replace(/\*$/, "");
	if (TABULAR_BARE.has(bare) && state.currentTable) {
		state.tables.push(state.currentTable);
		state.currentTable = undefined;
	}
	const at = state.envStack.lastIndexOf(env);
	if (at >= 0) state.envStack.splice(at, 1);
}

function handleSection(state: ScanState, match: RegExpExecArray): void {
	const starred = match[0].includes("*");
	if (!starred) {
		state.counters.sec++;
		state.counters.sub = 0;
		state.counters.subsub = 0;
		if (state.appendix) state.appendixIndex++;
	}
	pushOutline(state, 1, starred, groupAfterToken(state, match) ?? "");
}

function handleSubsection(state: ScanState, match: RegExpExecArray): void {
	const starred = match[0].includes("*");
	if (!starred) {
		state.counters.sub++;
		state.counters.subsub = 0;
	}
	pushOutline(state, 2, starred, groupAfterToken(state, match) ?? "");
}

function handleSubsubsection(state: ScanState, match: RegExpExecArray): void {
	const starred = match[0].includes("*");
	if (!starred) state.counters.subsub++;
	pushOutline(state, 3, starred, groupAfterToken(state, match) ?? "");
}

function handleTitle(state: ScanState, match: RegExpExecArray): void {
	const content = groupAfterToken(state, match);
	if (content) state.title = latexInlineToMarkdown(content);
}

function handleAuthor(state: ScanState, match: RegExpExecArray): void {
	const content = groupAtLastBrace(state, match);
	if (!content) return;
	for (const part of content.split(/\\and|,(?![^{]*\})|;/)) {
		const name = latexInlineToMarkdown(part)
			.replace(/[*\u2020\u2021]/g, "")
			.trim();
		if (name) state.authors.push(name);
	}
}

function handleAffiliation(state: ScanState, match: RegExpExecArray): void {
	const content = groupAtLastBrace(state, match);
	if (content) state.affiliations.push(latexInlineToMarkdown(content));
}

function handleCaptionSetup(state: ScanState, match: RegExpExecArray): void {
	// `\captionsetup{type=table}` inside a figure float makes the next caption a
	// table caption; LaTeX then numbers it in the table counter.
	if (/type\s*=\s*table/.test(groupAfterToken(state, match) ?? "")) state.forcedTableCaption = true;
}

function handleCaption(state: ScanState, match: RegExpExecArray): void {
	const inline = latexInlineToMarkdown(groupAfterToken(state, match) ?? "");
	const tableish = state.forcedTableCaption || state.envStack.some((env) => TABLE_ENVS.has(env));
	state.forcedTableCaption = false;

	if (tableish) {
		state.counters.tab++;
		state.tableCaptions.push(inline);
		if (state.currentTable && !state.currentTable.caption) state.currentTable.caption = inline;
	} else {
		state.counters.fig++;
		state.figureCaptions.push(inline);
	}
}

function handleIncludeGraphics(state: ScanState, match: RegExpExecArray): void {
	const content = groupAfterToken(state, match);
	if (content) state.graphics.push(content.trim());
}

function handleBibliography(state: ScanState, match: RegExpExecArray): void {
	const content = groupAfterToken(state, match);
	if (!content) return;
	state.bibFiles.push(
		...content
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean),
	);
}

function handleLabel(state: ScanState, match: RegExpExecArray): void {
	const key = match[0].slice(7, match[0].length - 1);
	const [prefix] = key.split(":");
	let kind: LabelKind = "other";
	let value: string;
	switch (prefix) {
		case "eq":
		case "alg":
			value = String(state.counters.eq);
			kind = prefix as LabelKind;
			break;
		case "fig":
			value = String(state.counters.fig);
			kind = "fig";
			break;
		case "tab":
			value = String(state.counters.tab);
			kind = "tab";
			break;
		case "sec":
			value = currentSection(state);
			kind = "sec";
			break;
		case "app":
			value = currentSection(state);
			kind = "app";
			break;
		default:
			value = currentSection(state);
	}
	state.labels.all.set(key, value);
	state.labels.kind.set(key, kind);
}

/**
 * Dispatch by command name rather than by prefix: prefix matching would make
 * `\captionsetup` collide with `\caption` and silently depend on rule order.
 */
const TOKEN_HANDLERS: Record<string, TokenHandler> = {
	appendix: handleAppendix,
	begin: handleBegin,
	end: handleEnd,
	section: handleSection,
	subsection: handleSubsection,
	subsubsection: handleSubsubsection,
	title: handleTitle,
	author: handleAuthor,
	affil: handleAffiliation,
	captionsetup: handleCaptionSetup,
	caption: handleCaption,
	includegraphics: handleIncludeGraphics,
	bibliography: handleBibliography,
	label: handleLabel,
};

const COMMAND_RE = /^\\([a-zA-Z]+)/;

function commandOf(token: string): string | undefined {
	return COMMAND_RE.exec(token)?.[1];
}

/** Replay LaTeX counters and collect everything the Markdown rules need. */
export function analyzeTex(flattened: string, mainFile: string, sourceFiles: string[]): TexAnalysis {
	const state: ScanState = {
		flattened,
		labels: { all: new Map(), kind: new Map() },
		outline: [],
		figureCaptions: [],
		tableCaptions: [],
		tables: [],
		graphics: [],
		bibFiles: [],
		authors: [],
		affiliations: [],
		counters: { eq: 0, fig: 0, tab: 0, sec: 0, sub: 0, subsub: 0 },
		appendix: false,
		appendixIndex: -1,
		forcedTableCaption: false,
		abstract: undefined,
		title: undefined,
		envStack: [],
		currentTable: undefined,
	};

	for (const match of flattened.matchAll(tokenRegex())) {
		const command = commandOf(match[0]);
		if (command) TOKEN_HANDLERS[command]?.(state, match);
	}

	return {
		mainFile,
		sourceFiles,
		flattened,
		abstract: state.abstract,
		title: state.title,
		authors: state.authors,
		affiliations: state.affiliations,
		labels: state.labels,
		outline: state.outline,
		figureCaptions: state.figureCaptions,
		tableCaptions: state.tableCaptions,
		tables: state.tables,
		graphics: state.graphics,
		bibFiles: state.bibFiles,
		hasAppendix: state.appendix,
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
