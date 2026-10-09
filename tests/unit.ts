/**
 * Unit tests: pure logic only — no network, and the filesystem is limited to a
 * temp directory for the archive-extraction checks.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
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
import { check, equal as eq } from "./harness.ts";

/** Build a minimal ustar archive in memory; no external tar needed. */
function makeTar(entries: Array<{ name: string; content: string; type?: string }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		header.write("000644 \0", 100, 8, "ascii");
		header.write("000000 \0", 108, 8, "ascii");
		header.write("000000 \0", 116, 8, "ascii");
		const size = Buffer.byteLength(entry.content);
		header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
		header.write("00000000000 ", 136, 12, "ascii");
		header.write("        ", 148, 8, "ascii");
		header.write(entry.type ?? "0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header);
		const body = Buffer.alloc(Math.ceil(size / 512) * 512);
		body.write(entry.content, 0, "utf8");
		blocks.push(body);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

export async function runUnit(): Promise<void> {
	// ------------------------------------------------------------ arXiv ids
	eq("parse bare id", parseArxivId("2609.35319")?.id, "2609.35319");
	eq("parse versioned id", parseArxivId("arXiv:2609.35319v2")?.version, "v2");
	eq("parse abs url", parseArxivId("https://arxiv.org/abs/2609.35319v1")?.id, "2609.35319");
	eq("parse pdf url", parseArxivId("https://arxiv.org/pdf/2609.35319")?.id, "2609.35319");
	eq("parse old-style id", parseArxivId("cs/0701001")?.id, "cs/0701001");
	eq("reject a title", parseArxivId("attention is all you need")?.id, undefined);

	// ------------------------------------------------------------ brace utils
	eq("readBraced nested", readBraced("x{a{b}c}y", 1)?.content, "a{b}c");
	eq("readBraced escaped brace", readBraced("x{a\\}b}y", 1)?.content, "a\\}b");
	eq("splitTopLevel ignores braced separator", splitTopLevel("a{&}b&c", "&").length, 2);
	eq("splitTopLevel honours row break", splitTopLevel("a \\\\ b \\\\ c", "\\\\").length, 3);

	// ------------------------------------------------------------ macros
	eq("expand textbf", expandBracedMacros("\\textbf{Hi}"), "**Hi**");
	eq("expand nested macros", expandBracedMacros("\\textbf{\\emph{Hi}}"), "***Hi***");
	eq("expand metricpm", expandBracedMacros("\\metricpm{26.7}{3.0}"), "26.7 ± 3.0");
	eq("expand multicolumn keeps content", expandBracedMacros("\\multicolumn{12}{c}{Group}"), "Group");
	eq("expand metricbest over metricpm", expandBracedMacros("\\metricbest{\\metricpm{82.1}{1.9}}"), "**82.1 ± 1.9**");
	eq("expand drops footnote body", expandBracedMacros("a\\footnote{note}b"), "ab");
	eq("expand drops thanks body", expandBracedMacros("Ada\\thanks{equal}"), "Ada");
	eq("leave unknown macro alone", expandBracedMacros("\\weirdmacro{x}"), "\\weirdmacro{x}");
	eq("inline en/em dashes", latexInlineToMarkdown("a--b---c"), "a–b—c");

	// ------------------------------------------------------------ tabulars
	const simple = parseTabularBody("A & B \\\\ 1 & 2 \\\\ \\hline 3 & 4 \\\\");
	eq("tabular row count", simple.rows.length, 3);
	eq("tabular column count", simple.columns, 2);
	eq("tabular cell values", simple.rows[1]?.join(","), "1,2");

	const spanned = parseTabularBody("\\multicolumn{2}{c}{Head} \\\\ x & y \\\\");
	eq("multicolumn expands width", spanned.columns, 2);
	eq("multicolumn keeps content", spanned.rows[0]?.[0], "Head");
	eq("multicolumn pads remainder", spanned.rows[0]?.[1], "");

	eq("multirow unwrapped", parseTabularBody("\\multirow{2}{*}{A} & 1 \\\\ & 2 \\\\").rows[0]?.[0], "A");

	eq(
		"toGfmTable shape",
		toGfmTable({
			tex: "",
			rows: [
				["a", "b"],
				["1", "2"],
			],
			columns: 2,
			environment: "tabular",
		}),
		"| a | b |\n|:---|:---|\n| 1 | 2 |",
	);
	eq(
		"toGfmTable escapes pipes",
		toGfmTable({ tex: "", rows: [["a|b"], ["1"]], columns: 1, environment: "tabular" }).includes("a\\|b"),
		true,
	);
	eq(
		"group header merged",
		flattenGroupHeader([
			["", "ALF", ""],
			["Method", "Seen", "Unseen"],
		])[0]?.join(" | "),
		"Method | ALF Seen | ALF Unseen",
	);
	eq(
		"group header kept when not a group",
		flattenGroupHeader([
			["Method", "SR"],
			["a", "b"],
		])[0]?.join(","),
		"Method,SR",
	);

	// ------------------------------------------------------------ counters
	const tex = String.raw`
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
	const analysis = analyzeTex(tex, "main.tex", ["main.tex"]);
	eq("title extracted", analysis.title, "Some **Paper**");
	eq("authors split on \\author", analysis.authors.length, 2);
	eq("author annotations stripped", analysis.authors[0], "Ada Lovelace");
	eq("abstract absent when none", analysis.abstract, undefined);
	eq("equation 1", analysis.labels.all.get("eq:first"), "1");
	eq("equation counter advances", analysis.labels.all.get("eq:second"), "2");
	eq("section 2", analysis.labels.all.get("sec:method"), "2");
	eq("subsection 2.1", analysis.labels.all.get("sec:details"), "2.1");
	eq("figure counter steps at caption", analysis.labels.all.get("fig:one"), "1");
	eq("table counter", analysis.labels.all.get("tab:one"), "1");
	eq("appendix letter", analysis.labels.all.get("app:extra"), "A");
	eq("appendix subsection", analysis.labels.all.get("app:more"), "A.1");
	eq("appendix table keeps global numbering", analysis.labels.all.get("tab:two"), "2");
	eq("figure captions collected", analysis.figureCaptions.length, 1);
	eq("table captions collected", analysis.tableCaptions.length, 2);
	eq(
		"outline marks appendix",
		analysis.outline.some((entry) => entry.appendix && entry.number === "A"),
		true,
	);

	const forced = analyzeTex(
		String.raw`\section{S}\begin{figure}\caption{Fig}\label{fig:a}\end{figure}\begin{figure}\captionsetup{type=table}\caption{Tab}\label{tab:a}\end{figure}`,
		"main.tex",
		[],
	);
	eq("captionsetup: figure number", forced.labels.all.get("fig:a"), "1");
	eq("captionsetup: table number", forced.labels.all.get("tab:a"), "1");

	// ------------------------------------------------------------ broken tables
	const broken = findTableBlocks(["|  |  |  |", "|:---|:---|:---|", "| A |  |  |", "| B | ± 3.0 |  |", "| C |  |  |"]);
	eq("one table block found", broken.length, 1);
	eq("broken table detected", broken[0]?.broken, true);
	eq("healthy table accepted", findTableBlocks(["| a | b |", "|:---|:---|", "| 1 | 2 |", "| 3 | 4 |"])[0]?.broken, false);
	eq("raw HTML table detected", findTableBlocks(["<table>", "<tr><td>x</td></tr>", "</table>"])[0]?.broken, true);

	// ------------------------------------------------------------ captions
	eq("label a plain caption", labelCaption("Figure", 3, "**Overview.** Some text."), "**Figure 3 | Overview.** Some text.");
	eq("relabel an existing caption", labelCaption("Table", 6, "**Table 2 | Training cost.** More."), "**Table 6 | Training cost.** More.");
	eq("label an unlabelled caption", labelCaption("Figure", 1, "Plain caption"), "**Figure 1 | Plain caption**");
	eq("relabel unbolded caption", labelCaption("Figure", 4, "Figure 2 | Old title"), "**Figure 4 | Old title**");

	// ------------------------------------------------------------ archive safety
	eq("unsafe: traversal", isUnsafeEntry("../evil.tex"), true);
	eq("unsafe: nested traversal", isUnsafeEntry("a/../../evil.tex"), true);
	eq("unsafe: absolute posix path", isUnsafeEntry("/etc/passwd"), true);
	eq("unsafe: windows drive path", isUnsafeEntry("C:\\Windows\\evil.tex"), true);
	eq("unsafe: empty name", isUnsafeEntry(""), true);
	eq("safe: nested file", isUnsafeEntry("figures/plot.pdf"), false);
	eq("safe: dotted file", isUnsafeEntry("main.v2.tex"), false);

	const tarFixture = makeTar([
		{ name: "main.tex", content: "\\documentclass{article}" },
		{ name: "figures/plot.pdf", content: "PDF" },
		{ name: "../escape.tex", content: "evil" },
	]);
	eq("tar entries parsed", parseTar(tarFixture).length, 3);
	eq("gzip round-trip", parseTar(gunzipSync(gzipSync(tarFixture))).length, 3);

	const extractDir = await mkdtemp(join(tmpdir(), "pi-arxiv-tar-"));
	const extracted = await extractTarToDir(tarFixture, extractDir);
	eq("safe entries extracted", extracted.files.length, 2);
	eq("traversal entry refused", extracted.skipped.length, 1);
	eq("nested file written", existsSync(join(extractDir, "figures", "plot.pdf")), true);
	eq("escape target not written", existsSync(join(extractDir, "..", "escape.tex")), false);
	eq("extracted content preserved", await readFile(join(extractDir, "main.tex"), "utf8"), "\\documentclass{article}");

	const prefixedDir = await mkdtemp(join(tmpdir(), "pi-arxiv-tar2-"));
	const prefixed = await extractTarToDir(
		makeTar([
			{ name: "paper/main.tex", content: "x" },
			{ name: "paper/refs.bib", content: "y" },
		]),
		prefixedDir,
	);
	eq("common top-level prefix stripped", prefixed.files.join(","), "main.tex,refs.bib");

	const noPrefix = makeTar([
		{ name: "main.tex", content: "x" },
		{ name: "sub/refs.bib", content: "y" },
	]);
	eq("mixed depth keeps names", (await extractTarToDir(noPrefix, prefixedDir)).files.join(","), "main.tex,sub/refs.bib");

	await rm(extractDir, { recursive: true, force: true });
	await rm(prefixedDir, { recursive: true, force: true });

	check("unit suite ran", true);
}
