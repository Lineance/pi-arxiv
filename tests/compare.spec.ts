/**
 * Version comparison: file-level, text-level and — the reason this exists —
 * table-cell level, where a citation-relevant number can move silently.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareFiles, compareVersions, diffTables, formatTableDeltas, summarizeComparison } from "../extensions/compare/versions.ts";
import { analyzeSourceDir, type ParsedTable, parseTabularBody } from "../extensions/convert/latex.ts";

/** Build a ParsedTable the way the analyzer does. */
function table(body: string, caption?: string, label?: string): ParsedTable {
	const parsed = parseTabularBody(body);
	return { tex: body, rows: parsed.rows, columns: parsed.columns, environment: "tabular", caption, label };
}

const MAIN_V1 = String.raw`\documentclass{article}
\title{A Paper}
\begin{document}
\section{Intro}\label{sec:i}
Intro.
\section{Results}
\begin{table}
\caption{Main results}
\label{tab:main}
\begin{tabular}{lcc}
Method & Success & Rounds \\
Baseline & 20.1 & 17.7 \\
Ours & 45.7 & 5.6 \\
\end{tabular}
\end{table}
\end{document}`;

let root: string;

async function versionDir(name: string, files: Record<string, string>): Promise<string> {
	const dir = join(root, name);
	for (const [file, content] of Object.entries(files)) {
		const target = join(dir, ...file.split("/"));
		await mkdir(join(target, ".."), { recursive: true });
		await writeFile(target, content);
	}
	await mkdir(dir, { recursive: true });
	return dir;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-compare-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("compareFiles", () => {
	it("separates added, removed, changed and unchanged", async () => {
		const from = await versionDir("v1", { "main.tex": "a\n", "refs.bib": "b\n", "old.tex": "c\n" });
		const to = await versionDir("v2", { "main.tex": "a\n", "refs.bib": "b changed\n", "new.tex": "d\n" });

		const changes = await compareFiles(from, to);

		expect(changes.added).toEqual(["new.tex"]);
		expect(changes.removed).toEqual(["old.tex"]);
		expect(changes.changed).toEqual(["refs.bib"]);
		expect(changes.unchanged).toBe(1);
	});

	it("walks nested directories and reports forward-slash paths", async () => {
		const from = await versionDir("v1", { "figures/plot.pdf": "x", "main.tex": "a" });
		const to = await versionDir("v2", { "figures/plot.pdf": "x", "main.tex": "a" });

		expect((await compareFiles(from, to)).unchanged).toBe(2);
	});

	it("ignores timestamps and notices content", async () => {
		const from = await versionDir("v1", { "main.tex": "same" });
		const to = await versionDir("v2", { "main.tex": "different" });

		expect((await compareFiles(from, to)).changed).toEqual(["main.tex"]);
	});

	it("compares binary assets by their original bytes", async () => {
		const from = await versionDir("v1", { "figure.pdf": "" });
		const to = await versionDir("v2", { "figure.pdf": "" });
		await writeFile(join(from, "figure.pdf"), Uint8Array.of(0xff));
		await writeFile(join(to, "figure.pdf"), Uint8Array.of(0xfe));

		expect((await compareFiles(from, to)).changed).toEqual(["figure.pdf"]);
	});

	it("handles an identical pair", async () => {
		const from = await versionDir("v1", { "main.tex": "same" });
		const changes = await compareFiles(from, from);
		expect(changes).toEqual({ added: [], removed: [], changed: [], unchanged: 1 });
	});
});

describe("diffTables", () => {
	it("reports a changed number in the cell that moved", () => {
		const before = [table("A & B \\\\ 1 & 2 \\\\ 3 & 4 \\\\", "Cap")];
		const after = [table("A & B \\\\ 1 & 2 \\\\ 3 & 4.1 \\\\", "Cap")];

		const deltas = diffTables(before, after);

		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.cells).toEqual([{ row: 3, column: 2, from: "4", to: "4.1" }]);
		expect(deltas[0]?.shapeChanged).toBe(false);
	});

	it("ignores a change that is only Markdown emphasis", () => {
		const before = [table("Method & SR \\\\ Ours & 45.7 \\\\")];
		const after = [table("Method & SR \\\\ \\textbf{Ours} & \\textbf{45.7} \\\\")];

		expect(diffTables(before, after)).toEqual([]);
	});

	it("does not compare cells when a changed shape cannot be aligned", () => {
		const before = [table("A & B \\\\ 1 & 2 \\\\")];
		const after = [table("A & B & C \\\\ 1 & 2 & 3 \\\\")];

		const deltas = diffTables(before, after);

		expect(deltas).toHaveLength(2);
		expect(deltas.map((delta) => delta.alignment)).toEqual(["unmatched", "unmatched"]);
		expect(deltas.every((delta) => delta.cells.length === 0)).toBe(true);
		expect(formatTableDeltas(deltas).join("\n")).toContain("cell comparison omitted");
	});

	it("reports added and removed rows for a same-width table", () => {
		const before = [table("A & B \\\\ 1 & 2 \\\\")];
		const after = [table("A & B \\\\ 1 & 2 \\\\ 3 & 4 \\\\")];

		const deltas = diffTables(before, after);

		expect(deltas[0]?.rowsAdded).toBe(1);
		expect(deltas[0]?.rowsRemoved).toBe(0);
		expect(deltas[0]?.shapeChanged).toBe(false);
	});

	it("reports an added table", () => {
		const deltas = diffTables([table("A & B \\\\ 1 & 2 \\\\")], [table("A & B \\\\ 1 & 2 \\\\"), table("C & D \\\\ 3 & 4 \\\\")]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.index).toBe(2);
		expect(deltas[0]?.toIndex).toBe(2);
		expect(deltas[0]?.alignment).toBe("unmatched");
	});

	it("reports a removed table", () => {
		const deltas = diffTables([table("A & B \\\\ 1 & 2 \\\\"), table("C & D \\\\ 3 & 4 \\\\")], [table("A & B \\\\ 1 & 2 \\\\")]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.fromIndex).toBe(2);
		expect(deltas[0]?.alignment).toBe("unmatched");
	});

	it("reports an unchanged caption change without claiming cells moved", () => {
		const deltas = diffTables([table("A & B \\\\ 1 & 2 \\\\", "Old")], [table("A & B \\\\ 1 & 2 \\\\", "New")]);

		expect(deltas).toHaveLength(1);
		expect(deltas[0]?.captionChanged).toBe(true);
		expect(deltas[0]?.cells).toEqual([]);
	});

	it("reports nothing when the tables are identical", () => {
		const same = [table("A & B \\\\ 1 & 2 \\\\", "Cap")];
		expect(diffTables(same, same)).toEqual([]);
	});

	it("reports every changed cell, not just the first", () => {
		const before = [table("A & B \\\\ 1 & 2 \\\\ 3 & 4 \\\\")];
		const after = [table("A & B \\\\ 9 & 2 \\\\ 3 & 8 \\\\")];

		expect(diffTables(before, after)[0]?.cells).toHaveLength(2);
	});
	it("aligns labeled tables after an insertion without false numeric changes", () => {
		const before = [
			table("Method & Score \\\\ A & 10 \\\\", "Results", "tab:results"),
			table("Method & Score \\\\ B & 20 \\\\", "Ablation", "tab:ablation"),
		];
		const after = [
			table("Model & Count \\\\ New & 3 \\\\", "New table", "tab:new"),
			table("Method & Score \\\\ A & 11 \\\\", "Results", "tab:results"),
			table("Method & Score \\\\ B & 20 \\\\", "Ablation", "tab:ablation"),
		];

		const deltas = diffTables(before, after);
		const results = deltas.find((delta) => delta.label === "tab:results");

		expect(results).toMatchObject({ alignment: "label", fromIndex: 1, toIndex: 2 });
		expect(results?.cells).toEqual([{ row: 2, column: 2, from: "10", to: "11" }]);
		expect(deltas.find((delta) => delta.label === "tab:new")?.alignment).toBe("unmatched");
		expect(deltas).toHaveLength(2);
	});

	it("does not guess between repeated structures when captions and labels are absent", () => {
		const before = [table("Method & Score \\\\ A & 10 \\\\"), table("Method & Score \\\\ B & 20 \\\\")];
		const after = [table("Method & Score \\\\ A & 11 \\\\"), table("Method & Score \\\\ B & 21 \\\\")];
		const deltas = diffTables(before, after);

		expect(deltas).toHaveLength(4);
		expect(deltas.every((delta) => delta.alignment === "unmatched" && delta.cells.length === 0)).toBe(true);
	});
});

describe("formatTableDeltas", () => {
	it("names the table by caption and lists each cell", () => {
		const delta = diffTables([table("A & B \\\\ 1 & 2 \\\\", "Main results")], [table("A & B \\\\ 1 & 3 \\\\", "Main results")]);
		const text = formatTableDeltas(delta).join("\n");

		expect(text).toContain("Table 1: Main results (matched by caption)");
		expect(text).toContain("r2c2: 2 → 3");
	});

	it("notes shape and caption changes in the heading", () => {
		const delta = diffTables(
			[table("A & B \\\\ 1 & 2 \\\\", "Old", "tab:shape")],
			[table("A & B & C \\\\ 1 & 2 & 3 \\\\", "New", "tab:shape")],
		);
		const text = formatTableDeltas(delta).join("\n");

		expect(text).toContain("caption changed");
		expect(text).toContain("shape 2x2 → 3x2");
	});

	it("shows an emptied cell", () => {
		const delta = diffTables([table("A & B \\\\ 1 & 2 \\\\")], [table("A & B \\\\ 1 & \\\\")]);
		expect(formatTableDeltas(delta).join("\n")).toContain("(empty)");
	});

	it("bounds the number of cells it lists", () => {
		const before = [table(Array.from({ length: 60 }, () => "1 & 1 \\\\").join(""))];
		const after = [table(Array.from({ length: 60 }, () => "2 & 2 \\\\").join(""))];
		for (const item of [...before, ...after]) item.caption = "Metric";
		const text = formatTableDeltas(diffTables(before, after), 5).join("\n");

		expect(text).toContain("more changed cell(s)");
	});
});

describe("compareVersions", () => {
	it("extracts LaTeX table labels for reliable alignment", async () => {
		const dir = await versionDir("labelled", { "main.tex": MAIN_V1 });
		const analysis = await analyzeSourceDir(dir);

		expect(analysis.tables[0]?.label).toBe("tab:main");
		expect(analysis.tables[0]?.caption).toContain("Main results");
	});

	it("combines files, LaTeX and tables", async () => {
		const from = await versionDir("v1", { "main.tex": MAIN_V1 });
		const to = await versionDir("v2", { "main.tex": MAIN_V1.replace("45.7", "46.1").replace("Intro.", "Introduction.") });

		const diff = await compareVersions({ id: "2609.35319", from: { version: "v1", dir: from }, to: { version: "v2", dir: to } });

		expect(diff.files.changed).toEqual(["main.tex"]);
		expect(diff.latex.added).toBeGreaterThan(0);
		expect(diff.markdown).toBeUndefined();
		expect(diff.hasMarkdown).toBe(false);
	});

	it("finds the moved number in the table, not only in the text", async () => {
		const from = await versionDir("v1", { "main.tex": MAIN_V1 });
		const to = await versionDir("v2", { "main.tex": MAIN_V1.replace("45.7", "46.1") });

		const diff = await compareVersions({ id: "x", from: { version: "v1", dir: from }, to: { version: "v2", dir: to } });

		expect(diff.tables).toHaveLength(1);
		expect(diff.tables[0]?.cells).toEqual([{ row: 3, column: 2, from: "45.7", to: "46.1" }]);
	});

	it("diffs the converted Markdown when both versions have it", async () => {
		const from = await versionDir("v1", { "main.tex": MAIN_V1, "v1.md": "# Title\n\nOld claim.\n" });
		const to = await versionDir("v2", { "main.tex": MAIN_V1, "v2.md": "# Title\n\nNew claim.\n" });

		const diff = await compareVersions({
			id: "x",
			from: { version: "v1", dir: from },
			to: { version: "v2", dir: to },
			markdown: { from: join(from, "v1.md"), to: join(to, "v2.md") },
		});

		expect(diff.hasMarkdown).toBe(true);
		expect(diff.markdown?.hunks).toHaveLength(1);
		expect(summarizeComparison(diff)).toContain("markdown");
	});

	it("survives a version whose LaTeX cannot be analyzed", async () => {
		const from = await versionDir("v1", { "main.tex": MAIN_V1 });
		const to = await versionDir("v2", { "notes.txt": "no latex here" });

		const diff = await compareVersions({ id: "x", from: { version: "v1", dir: from }, to: { version: "v2", dir: to } });

		expect(diff.tables).toEqual([]);
		expect(diff.files.added).toEqual(["notes.txt"]);
		expect(diff.files.removed).toEqual(["main.tex"]);
	});

	it("reports an identical pair as identical", async () => {
		const dir = await versionDir("same", { "main.tex": MAIN_V1 });
		const diff = await compareVersions({ id: "x", from: { version: "v1", dir }, to: { version: "v1", dir } });

		expect(diff.files.changed).toEqual([]);
		expect(diff.tables).toEqual([]);
		expect(diff.latex.hunks).toEqual([]);
	});
});

describe("summarizeComparison", () => {
	it("counts each layer", async () => {
		const from = await versionDir("v1", { "main.tex": MAIN_V1 });
		const to = await versionDir("v2", { "main.tex": MAIN_V1.replace("45.7", "46.1"), "extra.bib": "x" });

		const summary = summarizeComparison(
			await compareVersions({ id: "x", from: { version: "v1", dir: from }, to: { version: "v2", dir: to } }),
		);

		expect(summary).toContain("1 file(s) added");
		expect(summary).toContain("1 table(s) differ");
		expect(summary).toContain("latex");
	});
});
