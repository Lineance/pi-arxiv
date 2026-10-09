/**
 * Heading numbering from the LaTeX section outline.
 *
 * pandoc's gfm writer ignores `--number-sections`, and the in-text references
 * ("Section 3.1", "Appendix C") are only meaningful if the headings carry the
 * same numbers as the PDF.
 */

import { type Rule, warn } from "./types.ts";

function normalizeTitle(title: string): string {
	return title
		.replace(/\*\*|\*|`|_/g, "")
		.replace(/[\u2010-\u2015]/g, "-")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/\s+/g, " ")
		.replace(/[.:;,]+$/, "")
		.trim()
		.toLowerCase();
}

export const headingsRule: Rule = {
	id: "headings",
	description: "number headings from the LaTeX section outline (Section 3.1 / Appendix C)",
	run(state) {
		const numbered = new Map<string, { number: string; appendix: boolean }>();
		for (const entry of state.analysis.outline) {
			if (!entry.number) continue;
			const key = normalizeTitle(entry.title);
			if (key && !numbered.has(key)) numbered.set(key, { number: entry.number, appendix: entry.appendix });
		}
		if (numbered.size === 0) return;

		const lines = state.markdown.split("\n");
		let applied = 0;
		let missed = 0;
		for (let i = 0; i < lines.length; i++) {
			const match = /^(#{1,3})\s+(.+?)\s*$/.exec(lines[i] ?? "");
			if (!match) continue;
			const hashes = match[1] ?? "#";
			const title = (match[2] ?? "").trim();
			if (/^(?:abstract|references)$/i.test(title)) continue;
			const hit = numbered.get(normalizeTitle(title));
			if (!hit) {
				missed++;
				continue;
			}
			// Compare against the number we are about to write instead of guessing from
			// the shape of the heading. A regex on the title cannot tell a numbered
			// heading from prose that merely starts with a capital letter, so
			// "A lemma" used to look already-numbered and stayed bare.
			const prefix = hit.appendix && hashes.length === 1 ? `Appendix ${hit.number}.` : hit.number;
			if (title === prefix || title.startsWith(`${prefix} `) || title.startsWith(`${prefix}.`)) continue;

			lines[i] = `${hashes} ${prefix} ${title}`;
			applied++;
		}
		state.markdown = lines.join("\n");

		if (applied > 0) warn(state, "headings", `${applied} heading(s) numbered from the LaTeX outline`);
		const bodyHeadings = lines.filter((line) => /^#{1,2}\s+\S/.test(line)).length;
		if (missed > bodyHeadings / 2) {
			warn(state, "headings", `${missed} heading(s) had no matching LaTeX section; numbering may be partial`, "warn");
		}
	},
};
