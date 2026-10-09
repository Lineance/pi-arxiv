/**
 * Tables: pandoc cannot express LaTeX `\multirow`/`\multicolumn` in GFM, so it
 * silently emits empty cells (or a raw HTML table). We detect those blocks and
 * rebuild them from the parsed LaTeX tabular instead.
 */

import { toGfmTable } from "../latex.ts";
import { type Rule, warn } from "./types.ts";

export interface TableBlock {
	kind: "gfm" | "html";
	startLine: number;
	endLine: number;
	lines: string[];
	broken: boolean;
	columns: number;
	reason?: string | undefined;
}

function splitRow(line: string): string[] {
	const cells: string[] = [];
	let current = "";
	let escaped = false;
	for (const char of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			current += char;
			escaped = true;
			continue;
		}
		if (char === "|") {
			cells.push(current.trim());
			current = "";
			continue;
		}
		current += char;
	}
	cells.push(current.trim());
	return cells;
}

/** Locate GFM pipe tables and raw HTML tables, and judge whether each is trustworthy. */
export function findTableBlocks(lines: string[]): TableBlock[] {
	const blocks: TableBlock[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (/^\s*\|/.test(line)) {
			const start = i;
			while (i < lines.length && /^\s*\|/.test(lines[i] ?? "")) i++;
			const slice = lines.slice(start, i);
			const rows = slice.map(splitRow).filter((cells) => cells.length > 0);
			const header = rows[0] ?? [];
			const counts = new Set(rows.map((cells) => cells.length));
			const dataRows = rows.slice(2);
			const emptyHeavy =
				dataRows.length > 1 &&
				dataRows.filter((cells) => cells.filter((cell) => cell === "").length > cells.length * 0.4).length > dataRows.length / 2;
			const lostValues = rows.some((cells) => cells.some((cell) => /^\s*(?:\\pm|±)/.test(cell)));
			const reason =
				counts.size > 1
					? "inconsistent column count"
					: lostValues
						? "only ± fragments survived"
						: emptyHeavy
							? "majority-empty data rows"
							: undefined;
			blocks.push({
				kind: "gfm",
				startLine: start,
				endLine: i - 1,
				lines: slice,
				broken: Boolean(reason) || header.length === 0,
				reason: reason ?? (header.length === 0 ? "missing header" : undefined),
				columns: Math.max(...rows.map((cells) => cells.length), 0),
			});
			continue;
		}
		if (/^\s*<table[\s>]/.test(line)) {
			const start = i;
			while (i < lines.length && !/<\/table>/.test(lines[i] ?? "")) i++;
			const end = i;
			blocks.push({
				kind: "html",
				startLine: start,
				endLine: end,
				lines: lines.slice(start, end + 1),
				broken: true,
				reason: "pandoc fell back to raw HTML",
				columns: 0,
			});
			i = end + 1;
			continue;
		}
		i++;
	}
	return blocks;
}

export const tablesRule: Rule = {
	id: "tables",
	description: "rebuild LaTeX tables pandoc could not render (multirow/multicolumn)",
	run(state) {
		const lines = state.markdown.split("\n");
		const blocks = findTableBlocks(lines);
		const tabulars = state.analysis.tables.filter((table) => table.rows.length > 0);
		if (blocks.length === 0) return;

		if (state.tableMode === "html") {
			for (const block of blocks) {
				if (block.broken) warn(state, "tables", `table ${block.startLine + 1}: ${block.reason} (kept raw, tableMode=html)`, "warn");
			}
			return;
		}

		const used = new Set<number>();
		const pick = (block: TableBlock, ordinal: number): number | undefined => {
			if (blocks.length === tabulars.length && !used.has(ordinal)) return ordinal;
			const byColumns = tabulars.findIndex((table, index) => !used.has(index) && table.columns === block.columns);
			if (byColumns >= 0) return byColumns;
			return !used.has(ordinal) ? ordinal : undefined;
		};

		const replacements: Array<{ start: number; end: number; text: string }> = [];
		let ordinal = 0;
		for (const block of blocks) {
			const index = pick(block, ordinal);
			ordinal++;
			if (index === undefined) continue;
			used.add(index);
			if (!block.broken) continue;
			const table = tabulars[index];
			if (!table) continue;
			const rebuilt = toGfmTable(table);
			if (!rebuilt) continue;
			replacements.push({ start: block.startLine, end: block.endLine, text: rebuilt });
			state.stats.tablesRebuilt++;
			warn(state, "tables", `table ${index + 1} rebuilt from LaTeX source (${block.reason})`);
		}

		if (blocks.length !== tabulars.length && blocks.some((block) => block.broken)) {
			warn(
				state,
				"tables",
				`Markdown has ${blocks.length} table block(s) but the source has ${tabulars.length}; rebuilt positionally`,
				"warn",
			);
		}

		for (const replacement of replacements.reverse()) {
			lines.splice(replacement.start, replacement.end - replacement.start + 1, ...replacement.text.split("\n"));
		}
		state.markdown = lines.join("\n");
		state.stats.tables = findTableBlocks(state.markdown.split("\n")).length;
	},
};
