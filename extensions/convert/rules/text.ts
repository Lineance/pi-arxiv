/**
 * Text hygiene: the invisible characters and whitespace artifacts pandoc keeps
 * from LaTeX, plus the final Markdown sanity pass.
 */

import { type ConvertState, type Rule, warn } from "./types.ts";

const SPACE_LIKE: Array<[string | RegExp, string]> = [
	[/\u00a0/g, " "],
	[/\u2007/g, " "],
	[/\u2009/g, " "],
	[/\u202f/g, " "],
	[/\ufeff/g, ""],
	[/\u00ad/g, ""],
	[/\u2019/g, "'"],
	[/\u201c|\u201d/g, '"'],
];

export const textRule: Rule = {
	id: "text",
	description: "normalize spaces, entities and blank lines",
	run(state) {
		let markdown = state.markdown;
		markdown = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
		for (const [pattern, replacement] of SPACE_LIKE) markdown = markdown.replace(pattern, replacement);
		markdown = markdown.replace(/[ \t]+$/gm, "");
		markdown = markdown.replace(/\n{3,}/g, "\n\n");
		markdown = markdown.replace(/^\s*\n/, "");
		markdown = `${markdown.trimEnd()}\n`;
		state.markdown = markdown;
	},
};

/** Post-conversion lint: surface anything that looks like a conversion failure. */
export function lintMarkdown(state: ConvertState): void {
	const problems: Array<[RegExp, string]> = [
		[/@@CAPTION@@|@@TCAPTION@@/, "unconsumed caption marker"],
		[/<figure\b|<figcaption\b|<div\s+id="ref/, "raw float/bibliography HTML"],
		[/<math\b|application\/x-tex/, "leftover MathML (glyph and TeX annotation would duplicate)"],
		[/±\\pm|\\pm±/, "duplicated ± rendering (MathML glyph plus TeX annotation)"],
		[/<a\s+href="#[^"]*"[^>]*data-reference/, "unresolved pandoc reference anchor"],
		[/\{#[a-z]+:[^}]*\}/, "leftover LaTeX label attributes"],
		[/\\begin\{(?:equation|align|gather|multline)\}/, "LaTeX math environment left in Markdown"],
		[/\b(?:sec|fig|tab|eq|app):[a-z-]+/, "unresolved LaTeX label token"],
		[/\\(?:cite[tp]?|ref|label)\{/, "unresolved LaTeX command"],
	];
	for (const [pattern, message] of problems) {
		const match = pattern.exec(state.markdown);
		if (match) warn(state, "lint", `${message}: "${match[0].slice(0, 60)}"`, "warn");
	}

	const fences = (state.markdown.match(/^```/gm) ?? []).length;
	if (fences % 2 !== 0) warn(state, "lint", "unbalanced code fences", "warn");

	const dollars = (state.markdown.match(/\$\$/g) ?? []).length;
	if (dollars % 2 !== 0) warn(state, "lint", "unbalanced $$ display math delimiters", "warn");

	state.stats.lines = state.markdown.split("\n").length;
	state.stats.images = (state.markdown.match(/!\[[^\]]*\]\([^)]+\)/g) ?? []).length;
}
