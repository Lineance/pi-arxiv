/**
 * Structure: front matter, title, abstract, provenance note.
 *
 * Several conference classes make pandoc drop the abstract entirely (it lives in
 * a custom environment), so it is restored from the LaTeX source when missing.
 */

import { latexInlineToMarkdown } from "../latex.ts";
import { type Rule, warn } from "./types.ts";

const FRONT_MATTER_RE = /^---\n[\s\S]*?\n---\n+/;

function escapeYaml(value: string): string {
	return value.replace(/"/g, '\\"');
}

export const structureRule: Rule = {
	id: "structure",
	description: "prepend front matter, title, abstract and provenance links",
	run(state) {
		let body = state.markdown.replace(FRONT_MATTER_RE, "").replace(/^\s+/, "");

		// The paper's own \title{} is authoritative: the Atom API normalises
		// punctuation (en dashes become hyphens, casing can drift).
		const title = state.analysis.title ?? state.arxiv?.title ?? (/(?:^|\n)#\s+(.+)\n/.exec(body)?.[1] ?? "Untitled").trim();
		const authors = state.arxiv?.authors?.length ? state.arxiv.authors : state.analysis.authors;

		// drop a duplicated H1 the converter may have kept
		body = body.replace(/^#\s+[^\n]*\n+/, (match) => (match.includes(title.slice(0, 24)) ? "" : match));

		const lines: string[] = [];
		lines.push("---", `title: "${escapeYaml(title)}"`);
		if (authors.length > 0) lines.push(`authors: "${escapeYaml(authors.join(", "))}"`);
		if (state.arxiv?.id) lines.push(`arxiv: "${state.arxiv.id}${state.arxiv.version ?? ""}"`);
		lines.push(`generated: "pi-arxiv"`, "---", "", `# ${title}`, "");

		if (authors.length > 0) lines.push(`**Authors:** ${authors.join(", ")}`, "");
		if (state.arxiv) {
			const links = [`[arXiv abstract](${state.arxiv.absUrl})`, `[PDF](${state.arxiv.pdfUrl})`, `[HTML](${state.arxiv.htmlUrl})`];
			lines.push(`**Links:** ${links.join(" · ")}`, "");
			if (state.arxiv.categories.length > 0) lines.push(`**Categories:** ${state.arxiv.categories.join(", ")}`, "");
		}
		lines.push(
			"> Generated from the paper's LaTeX source with pandoc plus pi-arxiv post-processing. Machine-repaired parts are listed in the conversion report.",
			"",
		);

		const hasAbstract = /^##\s*Abstract\s*$/im.test(body);
		const abstractTex = state.analysis.abstract ? latexInlineToMarkdown(state.analysis.abstract) : "";
		if (hasAbstract) {
			lines.push("## Abstract", "");
		} else if (abstractTex) {
			lines.push("## Abstract", "", abstractTex, "");
			warn(state, "structure", "abstract restored from LaTeX source (pandoc dropped it)");
		}

		lines.push("---", "");
		state.markdown = `${lines.join("\n")}\n${body.replace(/^\s+/, "")}`.replace(/\n{3,}/g, "\n\n");
	},
};
