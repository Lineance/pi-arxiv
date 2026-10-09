/**
 * In-text references and the bibliography.
 *
 * pandoc rewrites `\ref{x}` into an anchor carrying the label, but it numbers
 * references by its own counter, which drifts as soon as floats are dropped.
 * We resolve every anchor through the LaTeX counter map instead.
 */

import { type ConvertState, type Rule, warn } from "./types.ts";

const NOUNS = ["Figure", "Table", "Section", "Equation", "Appendix", "Algorithm"];
const LABEL_TOKEN = /\b(?:sec|fig|tab|eq|app|alg):[A-Za-z][\w-]*\b/g;
const REF_MARK = "\u0001";

function lookup(state: ConvertState, label: string): string | undefined {
	return state.analysis.labels.all.get(label);
}

export const refsRule: Rule = {
	id: "refs",
	description: "resolve \\ref anchors with LaTeX numbering and flatten the bibliography",
	run(state) {
		let resolved = 0;
		let unresolved = 0;

		// <span id="sec:x" …></span> wrappers pandoc emits for labelled paragraphs
		state.markdown = state.markdown.replace(/<span\s+id="[^"]*"[^>]*>\s*<\/span>\s*/g, "");
		state.markdown = state.markdown.replace(/<span\s+class="[^"]*">([\s\S]*?)<\/span>/g, "$1");
		state.markdown = state.markdown.replace(/<span\s+id="[^"]*"[^>]*>/g, "");
		state.markdown = state.markdown.replace(/<\/span>/g, "");

		// <a href="#…" data-reference="label">text</a> → the LaTeX number
		state.markdown = state.markdown.replace(
			/<a\s+href="#[^"]*"[^>]*data-reference="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g,
			(_match, label: string, inner: string) => {
				const mapped = lookup(state, label);
				if (mapped) {
					resolved++;
					return mapped;
				}
				unresolved++;
				return inner.replace(/^\[|\]$/g, "");
			},
		);

		// \ref / \eqref that survived inside math or captions
		state.markdown = state.markdown.replace(/\\(?:eqref|ref)\{([^}]*)\}/g, (_match, label: string) => {
			const mapped = lookup(state, label);
			if (mapped) {
				resolved++;
				return mapped;
			}
			unresolved++;
			return label;
		});

		// bracket or bare label tokens pandoc left behind ([fig:method], sec:calibration)
		state.markdown = state.markdown.replace(new RegExp(`\\[(${LABEL_TOKEN.source.slice(2, -2)})\\]`, "g"), (_match, label: string) => {
			const mapped = lookup(state, label);
			if (mapped) {
				resolved++;
				return mapped;
			}
			unresolved++;
			return label;
		});
		state.markdown = state.markdown.replace(LABEL_TOKEN, (label: string) => {
			const mapped = lookup(state, label);
			if (!mapped) {
				unresolved++;
				return label;
			}
			resolved++;
			return mapped;
		});

		// \cite that pandoc could not resolve (no usable .bib)
		state.markdown = state.markdown.replace(/\\(?:cite[tp]?|citep|citealp)\{([^}]*)\}/g, (_match, keys: string) => {
			state.stats.citationsUnresolved = true;
			return `[${keys}]`;
		});

		for (const noun of NOUNS) {
			state.markdown = state.markdown.replace(new RegExp(`\\b${noun}\\s+${noun}\\b`, "g"), noun);
		}

		// bibliography: csl-entry divs → flat list, marked so the heading can be placed
		state.markdown = state.markdown.replace(/<div\s+id="ref-[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/div>/g, (_match, body: string) => {
			const flat = body.replace(/\s+/g, " ").trim();
			return flat ? `- ${REF_MARK}${flat}\n` : "";
		});
		state.markdown = state.markdown.replace(/<div\s+id="refs"[^>]*>\s*/g, "");
		state.markdown = state.markdown.replace(/<\/div>\s*(?=\n|$)/g, "");
		const lines = state.markdown.split("\n");
		const firstEntry = lines.findIndex((line) => line.includes(REF_MARK));
		if (firstEntry >= 0 && !lines.some((line) => /^#\s*References\s*$/i.test(line))) {
			lines.splice(firstEntry, 0, "# References", "");
			warn(state, "refs", "bibliography heading inserted (# References)");
		}
		state.markdown = lines.join("\n").split(REF_MARK).join("");

		state.stats.refs = (state.markdown.match(/^- \S.*?(?:\(\d{4}[a-z]?\)|\.\s\d{4}\.)/gm) ?? []).length;
		if (unresolved > 0) warn(state, "refs", `${unresolved} reference(s) had no matching LaTeX label`, "warn");
		if (resolved > 0) warn(state, "refs", `${resolved} in-text reference(s) resolved from LaTeX numbering`);
	},
};
