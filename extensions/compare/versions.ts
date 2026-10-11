/**
 * Version comparison.
 *
 * Three layers, because they answer different questions:
 *
 *   files     what the revision touched (a new appendix figure, a dropped .bib)
 *   text      the line-level diff, for reading
 *   tables    which _numbers_ changed, for trusting
 *
 * The third is the one that matters when a paper is being cited. A camera-ready
 * that moves WebShop success from 45.7 to 46.1 can be a single character in a
 * 900-line diff, and reading a diff for a numeric change is the wrong tool.
 */

import { join } from "node:path";
import { analyzeSourceDir, type ParsedTable } from "../convert/latex.ts";
import { listDir, readText, sha256File } from "../util/fsx.ts";
import { diffLines, type LineDiff } from "./lines.ts";

export interface FileChanges {
	added: string[];
	removed: string[];
	changed: string[];
	unchanged: number;
}

export interface CellChange {
	row: number;
	column: number;
	from: string;
	to: string;
}

export interface TableDelta {
	/** 1-based position in document order, i.e. the LaTeX table number. */
	index: number;
	fromCaption?: string | undefined;
	toCaption?: string | undefined;
	captionChanged: boolean;
	shapeChanged: boolean;
	fromShape: string;
	toShape: string;
	cells: CellChange[];
	rowsAdded: number;
	rowsRemoved: number;
}

export interface VersionDiff {
	id: string;
	from: { version: string; dir: string };
	to: { version: string; dir: string };
	files: FileChanges;
	latex: LineDiff;
	markdown?: LineDiff | undefined;
	tables: TableDelta[];
	/** True when both versions converted, so the Markdown diff exists. */
	hasMarkdown: boolean;
}

export interface CompareInputs {
	id: string;
	from: { version: string; dir: string };
	to: { version: string; dir: string };
	/** Markdown paths, when each version has been converted. */
	markdown?: { from?: string | undefined; to?: string | undefined } | undefined;
}

// ---------------------------------------------------------------- files

/** Relative paths of every regular file under `dir`. */
async function relativeFiles(dir: string, prefix = ""): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await listDir(dir)) {
		const key = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.dir) out.push(...(await relativeFiles(entry.path, key)));
		else out.push(key);
	}
	return out;
}

export async function compareFiles(fromDir: string, toDir: string): Promise<FileChanges> {
	const fromFiles = await relativeFiles(fromDir);
	const toFiles = await relativeFiles(toDir);
	const fromSet = new Set(fromFiles);
	const toSet = new Set(toFiles);

	const changes: FileChanges = { added: [], removed: [], changed: [], unchanged: 0 };

	for (const file of toFiles) {
		if (!fromSet.has(file)) {
			changes.added.push(file);
			continue;
		}
		const [left, right] = await Promise.all([sha256File(join(fromDir, ...file.split("/"))), sha256File(join(toDir, ...file.split("/")))]);
		if (left === right) changes.unchanged++;
		else changes.changed.push(file);
	}
	for (const file of fromFiles) {
		if (!toSet.has(file)) changes.removed.push(file);
	}

	changes.added.sort();
	changes.removed.sort();
	changes.changed.sort();
	return changes;
}

// ---------------------------------------------------------------- tables

/** Compare cells without their Markdown emphasis, so bolding is not a change. */
function normaliseCell(cell: string): string {
	return cell
		.replace(/\*\*|\*|`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function diffTables(fromTables: ParsedTable[], toTables: ParsedTable[]): TableDelta[] {
	const deltas: TableDelta[] = [];
	const count = Math.max(fromTables.length, toTables.length);

	for (let index = 0; index < count; index++) {
		const from = fromTables[index];
		const to = toTables[index];
		const fromCaption = from?.caption;
		const toCaption = to?.caption;
		const fromShape = from ? `${from.columns}x${from.rows.length}` : "-";
		const toShape = to ? `${to.columns}x${to.rows.length}` : "-";

		const delta: TableDelta = {
			index: index + 1,
			fromCaption,
			toCaption,
			captionChanged: (fromCaption ?? "") !== (toCaption ?? ""),
			shapeChanged: fromShape !== toShape,
			fromShape,
			toShape,
			cells: [],
			rowsAdded: Math.max(0, (to?.rows.length ?? 0) - (from?.rows.length ?? 0)),
			rowsRemoved: Math.max(0, (from?.rows.length ?? 0) - (to?.rows.length ?? 0)),
		};

		// Cell-by-cell only makes sense while the tables still line up. Once the
		// shape changes, positions no longer identify the same cell, and guessing
		// would invent changes.
		if (from && to && !delta.shapeChanged) {
			for (let row = 0; row < from.rows.length; row++) {
				const fromRow = from.rows[row] ?? [];
				const toRow = to.rows[row] ?? [];
				for (let column = 0; column < Math.max(fromRow.length, toRow.length); column++) {
					const before = fromRow[column] ?? "";
					const after = toRow[column] ?? "";
					if (normaliseCell(before) !== normaliseCell(after)) {
						delta.cells.push({ row: row + 1, column: column + 1, from: before, to: after });
					}
				}
			}
		}

		// A table is reported only when something about it moved. Comparing the
		// observable parts (shape, caption, cells) beats trusting a boolean chain.
		const unchanged = Boolean(from) && Boolean(to) && !delta.captionChanged && !delta.shapeChanged && delta.cells.length === 0;
		if (!unchanged) deltas.push(delta);
	}

	return deltas;
}

/** One line per changed cell, the form a reader can scan. */
export function formatTableDeltas(deltas: TableDelta[], limit = 40): string[] {
	const out: string[] = [];
	for (const delta of deltas) {
		const caption = delta.toCaption ?? delta.fromCaption ?? `table ${delta.index}`;
		const heading = `Table ${delta.index}: ${caption}`;
		const notes: string[] = [];
		if (delta.captionChanged && delta.fromCaption && delta.toCaption) notes.push("caption changed");
		if (delta.shapeChanged) notes.push(`shape ${delta.fromShape} → ${delta.toShape}`);
		if (delta.rowsAdded > 0) notes.push(`${delta.rowsAdded} row(s) added`);
		if (delta.rowsRemoved > 0) notes.push(`${delta.rowsRemoved} row(s) removed`);
		out.push(notes.length > 0 ? `${heading} (${notes.join(", ")})` : heading);

		for (const cell of delta.cells.slice(0, limit)) {
			out.push(`  r${cell.row}c${cell.column}: ${cell.from || "(empty)"} → ${cell.to || "(empty)"}`);
		}
		if (delta.cells.length > limit) out.push(`  … ${delta.cells.length - limit} more changed cell(s)`);
	}
	return out;
}

// ---------------------------------------------------------------- driver

export async function compareVersions(input: CompareInputs): Promise<VersionDiff> {
	const [files, fromAnalysis, toAnalysis] = await Promise.all([
		compareFiles(input.from.dir, input.to.dir),
		analyzeSourceDir(input.from.dir).catch(() => undefined),
		analyzeSourceDir(input.to.dir).catch(() => undefined),
	]);

	const latex = diffLines(fromAnalysis ? await readText(fromAnalysis.mainFile) : "", toAnalysis ? await readText(toAnalysis.mainFile) : "");

	const tables = fromAnalysis && toAnalysis ? diffTables(fromAnalysis.tables, toAnalysis.tables) : [];

	let markdown: LineDiff | undefined;
	if (input.markdown?.from && input.markdown.to) {
		markdown = diffLines(await readText(input.markdown.from), await readText(input.markdown.to));
	}

	return {
		id: input.id,
		from: input.from,
		to: input.to,
		files,
		latex,
		markdown,
		tables,
		hasMarkdown: markdown !== undefined,
	};
}

/** Short verdict for a tool result. */
export function summarizeComparison(diff: VersionDiff): string {
	const parts = [
		`${diff.files.added.length} file(s) added`,
		`${diff.files.removed.length} removed`,
		`${diff.files.changed.length} changed`,
		`${diff.tables.length} table(s) differ`,
		`latex +${diff.latex.added}/-${diff.latex.removed}`,
	];
	if (diff.markdown) parts.push(`markdown +${diff.markdown.added}/-${diff.markdown.removed}`);
	return parts.join(", ");
}
