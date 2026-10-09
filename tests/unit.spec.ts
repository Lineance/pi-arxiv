/**
 * Pure logic: no network, no external tools. The filesystem is touched only for
 * archive extraction, in a temp directory.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseArxivId } from "../extensions/arxiv/api.ts";
import {
	analyzeTex,
	expandBracedMacros,
	flattenGroupHeader,
	latexInlineToMarkdown,
	parseTabularBody,
	readBraced,
	splitTopLevel,
	toGfmTable,
} from "../extensions/convert/latex.ts";
import { labelCaption } from "../extensions/convert/rules/captions.ts";
import { findTableBlocks } from "../extensions/convert/rules/tables.ts";
import { extractTarToDir, isUnsafeEntry, parseTar } from "../extensions/util/tar.ts";
import { makeTar } from "./helpers/fixtures.ts";

describe("arXiv identifier parsing", () => {
	it("accepts every form of a new-style id", () => {
		expect(parseArxivId("2609.35319")?.id).toBe("2609.35319");
		expect(parseArxivId("arXiv:2609.35319v2")).toEqual({ id: "2609.35319", version: "v2" });
		expect(parseArxivId("https://arxiv.org/abs/2609.35319v1")?.id).toBe("2609.35319");
		expect(parseArxivId("https://arxiv.org/pdf/2609.35319")?.id).toBe("2609.35319");
	});

	it("accepts the pre-2007 identifier scheme", () => {
		expect(parseArxivId("cs/0701001")?.id).toBe("cs/0701001");
	});

	it("treats free text as a title, not an id", () => {
		expect(parseArxivId("attention is all you need")).toBeUndefined();
	});
});

describe("brace scanning", () => {
	it("reads a group and reports where it ends", () => {
		// "x{a{b}c}y": the outer group closes at index 7, so `end` is one past it.
		expect(readBraced("x{a{b}c}y", 1)).toEqual({ content: "a{b}c", end: 8 });
	});

	it("does not treat an escaped brace as a terminator", () => {
		expect(readBraced("x{a\\}b}y", 1)?.content).toBe("a\\}b");
	});

	it("returns undefined when the brace is never closed", () => {
		expect(readBraced("x{a", 1)).toBeUndefined();
	});

	it("splits only on top-level separators", () => {
		expect(splitTopLevel("a{&}b&c", "&")).toHaveLength(2);
		expect(splitTopLevel("a \\\\ b \\\\ c", "\\\\")).toHaveLength(3);
	});
});

describe("macro expansion", () => {
	it("unwraps styling macros into Markdown", () => {
		expect(expandBracedMacros("\\textbf{Hi}")).toBe("**Hi**");
		expect(expandBracedMacros("\\textbf{\\emph{Hi}}")).toBe("***Hi***");
	});

	it("expands project-specific metric macros", () => {
		expect(expandBracedMacros("\\metricpm{26.7}{3.0}")).toBe("26.7 ± 3.0");
		expect(expandBracedMacros("\\metricbest{\\metricpm{82.1}{1.9}}")).toBe("**82.1 ± 1.9**");
		expect(expandBracedMacros("\\multicolumn{12}{c}{Group}")).toBe("Group");
	});

	it("drops macro bodies that carry no readable content", () => {
		expect(expandBracedMacros("a\\footnote{note}b")).toBe("ab");
		expect(expandBracedMacros("Ada\\thanks{equal}")).toBe("Ada");
	});

	it("leaves an unknown macro untouched rather than mangling it", () => {
		expect(expandBracedMacros("\\weirdmacro{x}")).toBe("\\weirdmacro{x}");
	});

	it("does not mistake a longer macro name for a shorter one", () => {
		// \\texttt must not be read as \\text, and \\bfseries not as \\bf.
		expect(expandBracedMacros("\\texttt{code}")).toBe("`code`");
		expect(expandBracedMacros("\\bfseries text")).toBe("\\bfseries text");
	});

	it("normalises prose dashes and symbols", () => {
		expect(latexInlineToMarkdown("a--b---c")).toBe("a–b—c");
		expect(latexInlineToMarkdown("Kai Tang\\dag")).toBe("Kai Tang†");
	});
});

describe("tabular parsing", () => {
	it("reads rows, columns and cells", () => {
		const parsed = parseTabularBody("A & B \\\\ 1 & 2 \\\\ \\hline 3 & 4 \\\\");
		expect(parsed.rows).toHaveLength(3);
		expect(parsed.columns).toBe(2);
		expect(parsed.rows[1]).toEqual(["1", "2"]);
	});

	it("expands \\multicolumn so rows stay column-aligned", () => {
		const parsed = parseTabularBody("\\multicolumn{2}{c}{Head} \\\\ x & y \\\\");
		expect(parsed.columns).toBe(2);
		expect(parsed.rows[0]).toEqual(["Head", ""]);
	});

	it("unwraps \\multirow", () => {
		expect(parseTabularBody("\\multirow{2}{*}{A} & 1 \\\\ & 2 \\\\").rows[0]?.[0]).toBe("A");
	});

	it("renders a GFM table with an aligned separator row", () => {
		expect(
			toGfmTable({
				tex: "",
				rows: [
					["a", "b"],
					["1", "2"],
				],
				columns: 2,
				environment: "tabular",
			}),
		).toBe("| a | b |\n|:---|:---|\n| 1 | 2 |");
	});

	it("escapes a pipe inside a cell so the table does not split", () => {
		const rendered = toGfmTable({ tex: "", rows: [["a|b"], ["1"]], columns: 1, environment: "tabular" });
		expect(rendered).toContain("a\\|b");
	});

	it("merges a two-level header into GFM-compatible labels", () => {
		expect(
			flattenGroupHeader([
				["", "ALF", ""],
				["Method", "Seen", "Unseen"],
			])[0],
		).toEqual(["Method", "ALF Seen", "ALF Unseen"]);
	});

	it("leaves a single-row header alone", () => {
		expect(
			flattenGroupHeader([
				["Method", "SR"],
				["a", "b"],
			])[0],
		).toEqual(["Method", "SR"]);
	});
});

describe("LaTeX counter replay", () => {
	const source = String.raw`
\title{Some \textbf{Paper}}
\author[1]{Ada Lovelace\thanks{equal}}
\author[2]{Alan Turing}
\section{Intro}\label{sec:intro}
\begin{equation}\label{eq:first} a=b \end{equation}
\section{Method}\label{sec:method}
\begin{figure}\includegraphics{figures/f.pdf}\caption{First fig}\label{fig:one}\end{figure}
\begin{table}\caption{First tab}\label{tab:one}\begin{tabular}{cc} a & b \\ 1 & 2 \end{tabular}\end{table}
\begin{figure}\includegraphics{figures/g.pdf}\end{figure}
\subsection{Details}\label{sec:details}
\begin{equation}\label{eq:second} c=d \end{equation}
\appendix
\section{Extra}\label{app:extra}
\subsection{More}\label{app:more}
\begin{table}\caption{Second tab}\label{tab:two}\begin{tabular}{cc} x & y \end{tabular}\end{table}
`;
	const analysis = analyzeTex(source, "main.tex", ["main.tex"]);

	it("extracts the title and splits authors on \\author", () => {
		expect(analysis.title).toBe("Some **Paper**");
		expect(analysis.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
	});

	it("leaves the abstract undefined when the class does not provide one", () => {
		expect(analysis.abstract).toBeUndefined();
	});

	it("numbers equations in document order", () => {
		expect(analysis.labels.all.get("eq:first")).toBe("1");
		expect(analysis.labels.all.get("eq:second")).toBe("2");
	});

	it("numbers sections and subsections hierarchically", () => {
		expect(analysis.labels.all.get("sec:method")).toBe("2");
		expect(analysis.labels.all.get("sec:details")).toBe("2.1");
	});

	it("records a figure label against the caption, not the environment", () => {
		expect(analysis.labels.all.get("fig:one")).toBe("1");
	});

	it("restarts section lettering in the appendix", () => {
		expect(analysis.labels.all.get("app:extra")).toBe("A");
		expect(analysis.labels.all.get("app:more")).toBe("A.1");
	});

	it("keeps table numbering global across the appendix boundary", () => {
		expect(analysis.labels.all.get("tab:two")).toBe("2");
	});

	it("collects captions by float kind", () => {
		expect(analysis.figureCaptions).toEqual(["First fig"]);
		expect(analysis.tableCaptions).toEqual(["First tab", "Second tab"]);
	});

	it("records the appendix in the outline", () => {
		expect(analysis.outline).toContainEqual({ level: 1, title: "Extra", number: "A", appendix: true });
	});

	it("does not count a captionless float", () => {
		// The second {figure} has no \caption, so table numbering is unaffected.
		expect(analysis.labels.all.get("fig:one")).toBe("1");
	});
});

describe("\\captionsetup{type=table} inside a figure float", () => {
	// A table caption that LaTeX typesets inside a figure: the counter that
	// advances is the table counter, and pandoc gets this wrong.
	const analysis = analyzeTex(
		String.raw`\section{S}\begin{figure}\caption{Fig}\label{fig:a}\end{figure}\begin{figure}\captionsetup{type=table}\caption{Tab}\label{tab:a}\end{figure}`,
		"main.tex",
		[],
	);

	it("numbers the figure caption as a figure", () => {
		expect(analysis.labels.all.get("fig:a")).toBe("1");
	});

	it("numbers the forced caption as a table", () => {
		expect(analysis.labels.all.get("tab:a")).toBe("1");
	});
});

describe("broken-table detection", () => {
	it("flags a table pandoc emptied", () => {
		const blocks = findTableBlocks(["|  |  |  |", "|:---|:---|:---|", "| A |  |  |", "| B | ± 3.0 |  |", "| C |  |  |"]);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]?.broken).toBe(true);
	});

	it("accepts a healthy table", () => {
		expect(findTableBlocks(["| a | b |", "|:---|:---|", "| 1 | 2 |", "| 3 | 4 |"])[0]?.broken).toBe(false);
	});

	it("flags a raw HTML table, which GFM cannot express", () => {
		expect(findTableBlocks(["<table>", "<tr><td>x</td></tr>", "</table>"])[0]?.broken).toBe(true);
	});
});

describe("caption labelling", () => {
	it("labels a plain caption", () => {
		expect(labelCaption("Figure", 3, "**Overview.** Some text.")).toBe("**Figure 3 | Overview.** Some text.");
	});

	it("replaces a wrong label instead of nesting it", () => {
		expect(labelCaption("Table", 6, "**Table 2 | Training cost.** More.")).toBe("**Table 6 | Training cost.** More.");
	});

	it("bold-labels an unlabelled caption", () => {
		expect(labelCaption("Figure", 1, "Plain caption")).toBe("**Figure 1 | Plain caption**");
	});

	it("handles a label that was not bolded", () => {
		expect(labelCaption("Figure", 4, "Figure 2 | Old title")).toBe("**Figure 4 | Old title**");
	});
});

describe("archive path safety", () => {
	it.each([
		["../evil.tex", "parent traversal"],
		["a/../../evil.tex", "nested traversal"],
		["/etc/passwd", "absolute posix path"],
		["C:\\Windows\\evil.tex", "windows drive path"],
		["", "empty name"],
	])("refuses %s (%s)", (name) => {
		expect(isUnsafeEntry(name)).toBe(true);
	});

	it.each([["figures/plot.pdf"], ["main.v2.tex"], ["sub/refs.bib"]])("accepts %s", (name) => {
		expect(isUnsafeEntry(name)).toBe(false);
	});
});

describe("tar extraction", () => {
	const archive = makeTar([
		{ name: "main.tex", content: "\\documentclass{article}" },
		{ name: "figures/plot.pdf", content: "PDF" },
		{ name: "../escape.tex", content: "evil" },
	]);

	it("parses every entry, including the unsafe one", () => {
		expect(parseTar(archive)).toHaveLength(3);
	});

	it("round-trips through gzip", () => {
		expect(parseTar(gunzipSync(gzipSync(archive)))).toHaveLength(3);
	});

	it("extracts safe entries, refuses the traversal, and preserves content", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-tar-"));
		try {
			const result = await extractTarToDir(archive, dir);

			expect(result.files).toEqual(["main.tex", "figures/plot.pdf"]);
			expect(result.skipped).toEqual(["../escape.tex"]);
			expect(existsSync(join(dir, "figures", "plot.pdf"))).toBe(true);
			expect(existsSync(join(dir, "..", "escape.tex"))).toBe(false);
			expect(await readFile(join(dir, "main.tex"), "utf8")).toBe("\\documentclass{article}");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("strips a single common top-level directory", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-tar-"));
		try {
			const result = await extractTarToDir(
				makeTar([
					{ name: "paper/main.tex", content: "x" },
					{ name: "paper/refs.bib", content: "y" },
				]),
				dir,
			);
			expect(result.files).toEqual(["main.tex", "refs.bib"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps names when the archive has no single root", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-tar-"));
		try {
			const result = await extractTarToDir(
				makeTar([
					{ name: "main.tex", content: "x" },
					{ name: "sub/refs.bib", content: "y" },
				]),
				dir,
			);
			expect(result.files).toEqual(["main.tex", "sub/refs.bib"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
