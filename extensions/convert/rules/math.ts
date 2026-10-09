/**
 * Math: make every display block KaTeX-safe.
 *
 * KaTeX (VS Code, Obsidian, docs sites) has no `equation`/`align`/`multline`
 * environments, so we unwrap them and switch to the `aligned` family, which is
 * supported.
 */

import { type Rule, warn } from "./types.ts";

const ENV_RENAMES: Array<[RegExp, string]> = [
	[/\\begin\{align\*?\}/g, "\\begin{aligned}"],
	[/\\end\{align\*?\}/g, "\\end{aligned}"],
	[/\\begin\{alignat\*?\}\{[^}]*\}/g, "\\begin{aligned}"],
	[/\\end\{alignat\*?\}/g, "\\end{aligned}"],
	[/\\begin\{gather\*?\}/g, "\\begin{gathered}"],
	[/\\end\{gather\*?\}/g, "\\end{gathered}"],
	[/\\begin\{multline\*?\}/g, "\\begin{aligned}"],
	[/\\end\{multline\*?\}/g, "\\end{aligned}"],
	[/\\begin\{eqnarray\*?\}/g, "\\begin{aligned}"],
	[/\\end\{eqnarray\*?\}/g, "\\end{aligned}"],
	[/\\begin\{split\}/g, "\\begin{aligned}"],
	[/\\end\{split\}/g, "\\end{aligned}"],
];

function cleanBlock(body: string): { body: string; strippedEnv: boolean } {
	let text = body;
	const hadEnvironment = /\\begin\{(?:equation|align|alignat|gather|multline|eqnarray|split)\*?\}/.test(text);
	text = text.replace(/\\(?:begin|end)\{equation\*?\}/g, "");
	text = text.replace(/\\label\{[^}]*\}/g, "");
	text = text.replace(/\\tag\{[^}]*\}/g, "");
	for (const [pattern, replacement] of ENV_RENAMES) text = text.replace(pattern, replacement);
	text = text
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
	return { body: text, strippedEnv: hadEnvironment };
}

/**
 * MathML → LaTeX.
 *
 * When pandoc cannot express math in GFM it falls back to MathML inside raw
 * HTML. That HTML may be consumed by another rule (or by a reader), and the
 * `<mi>` glyph plus the TeX annotation would then both survive as text
 * (`±\pm`). Convert it to `$…$` up front.
 */
function mathmlToLatex(markdown: string): { markdown: string; converted: number } {
	let converted = 0;
	const texAnnotation = /<math\b[^>]*>[\s\S]*?<annotation[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/g;
	let out = markdown.replace(texAnnotation, (_match, tex: string) => {
		converted++;
		const body = String(tex).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
		return `$${body}$`;
	});
	// Annotations without a usable TeX payload: drop the element, keep nothing.
	out = out.replace(/<math\b[^>]*>[\s\S]*?<\/math>/g, (match) => {
		converted++;
		const mtext = /<mtext[^>]*>([\s\S]*?)<\/mtext>/g;
		const parts = [...match.matchAll(mtext)].map((m) => m[1] ?? "");
		return parts.join("") || match.replace(/<[^>]+>/g, "").trim();
	});
	return { markdown: out, converted };
}

/**
 * Keep exactly one blank line *outside* each $$ block and none inside.
 * Doing this line-wise avoids matching a `$$` that both opens and closes.
 */
function normalizeDisplayBlocks(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (line.trim() === "$$") {
			if (!inside) {
				while (out.length > 0 && out[out.length - 1] === "") out.pop();
				if (out.length > 0) out.push("");
				out.push("$$");
				inside = true;
				continue;
			}
			while (out.length > 0 && out[out.length - 1] === "") out.pop();
			out.push("$$", "");
			inside = false;
			continue;
		}
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export const mathRule: Rule = {
	id: "math",
	description: "normalize math into KaTeX-compatible $…$ / $$…$$",
	run(state) {
		let stripped = 0;
		let blocks = 0;

		const mathml = mathmlToLatex(state.markdown);
		state.markdown = mathml.markdown;
		if (mathml.converted > 0) warn(state, "math", `${mathml.converted} MathML fragment(s) converted back to LaTeX`);

		// ``` math … ```  (pandoc's gfm display math)  →  $$ … $$
		state.markdown = state.markdown.replace(/```\s*math\s*\n([\s\S]*?)```/g, (_match, body: string) => {
			const cleaned = cleanBlock(body);
			if (cleaned.strippedEnv) stripped++;
			blocks++;
			return `$$\n${cleaned.body}\n$$`;
		});

		// $`x`$ (GitHub-flavoured inline math) → $x$
		state.markdown = state.markdown.replace(/\$`([\s\S]*?)`\$/g, (_match, body: string) => `$${body.trim()}$`);

		// unwrap \begin{equation} that pandoc already wrapped in $$
		state.markdown = state.markdown.replace(/\$\$\n([\s\S]*?)\n\$\$/g, (match, body: string) => {
			const cleaned = cleanBlock(body);
			if (cleaned.strippedEnv || cleaned.body !== body.trim()) {
				if (cleaned.strippedEnv) stripped++;
				return `$$\n${cleaned.body}\n$$`;
			}
			return match;
		});

		state.markdown = normalizeDisplayBlocks(state.markdown);

		state.stats.equations = Math.floor((state.markdown.match(/\$\$/g)?.length ?? 0) / 2) || blocks;
		if (stripped > 0) {
			warn(state, "math", `${stripped} equation environment(s) unwrapped to KaTeX-compatible display math`);
		}
	},
};
