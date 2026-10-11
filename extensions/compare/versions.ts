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

export type TableAlignment = "label" | "caption" | "structure" | "unmatched";

export interface TableDelta {
	/** Displayed document order, preferring the newer version's table number. */
	index: number;
	fromIndex?: number | undefined;
	toIndex?: number | undefined;
	alignment: TableAlignment;
	label?: string | undefined;
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
	const pairs: Array<{ fromIndex?: number; toIndex?: number; alignment: TableAlignment }> = [];
	const fromRemaining = new Set(fromTables.map((_table, index) => index));
	const toRemaining = new Set(toTables.map((_table, index) => index));

	const pairByKey = (keyFor: (table: ParsedTable) => string | undefined, alignment: Exclude<TableAlignment, "unmatched">) => {
		const fromKeys = uniqueTableKeys(fromTables, fromRemaining, keyFor);
		const toKeys = uniqueTableKeys(toTables, toRemaining, keyFor);
		for (const [key, fromIndex] of fromKeys) {
			const toIndex = toKeys.get(key);
			if (toIndex === undefined) continue;
			pairs.push({ fromIndex, toIndex, alignment });
			fromRemaining.delete(fromIndex);
			toRemaining.delete(toIndex);
		}
	};

	pairByKey((table) => nonEmpty(table.label), "label");
	pairByKey((table) => {
		const caption = normalizeIdentity(table.caption ?? "");
		return caption || undefined;
	}, "caption");
	pairByKey((table) => tableStructureKey(table), "structure");

	for (const fromIndex of fromRemaining) pairs.push({ fromIndex, alignment: "unmatched" });
	for (const toIndex of toRemaining) pairs.push({ toIndex, alignment: "unmatched" });

	return pairs
		.map(({ fromIndex, toIndex, alignment }) => makeTableDelta(fromTables, toTables, fromIndex, toIndex, alignment))
		.filter(
			(delta) =>
				delta.alignment === "unmatched" ||
				delta.captionChanged ||
				delta.shapeChanged ||
				delta.rowsAdded > 0 ||
				delta.rowsRemoved > 0 ||
				delta.cells.length > 0,
		)
		.sort((a, b) => a.index - b.index || (a.fromIndex ?? 0) - (b.fromIndex ?? 0));
}

function uniqueTableKeys(
	tables: ParsedTable[],
	remaining: Set<number>,
	keyFor: (table: ParsedTable) => string | undefined,
): Map<string, number> {
	const indexes = new Map<string, number[]>();
	for (const index of remaining) {
		const table = tables[index];
		const key = table ? keyFor(table) : undefined;
		if (!key) continue;
		indexes.set(key, [...(indexes.get(key) ?? []), index]);
	}
	return new Map([...indexes].filter(([, matches]) => matches.length === 1).map(([key, matches]) => [key, matches[0] as number]));
}

function nonEmpty(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized || undefined;
}

function normalizeIdentity(value: string): string {
	return value
		.replace(/\\(?:textbf|emph|textit)\s*\{([^{}]*)\}/g, "$1")
		.replace(/[{}*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function tableStructureKey(table: ParsedTable): string | undefined {
	const header = table.rows[0]?.map(normalizeIdentity).filter(Boolean).join("|");
	return header ? `${table.columns}:${header}` : undefined;
}

function makeTableDelta(
	fromTables: ParsedTable[],
	toTables: ParsedTable[],
	fromIndex: number | undefined,
	toIndex: number | undefined,
	alignment: TableAlignment,
): TableDelta {
	const from = fromIndex === undefined ? undefined : fromTables[fromIndex];
	const to = toIndex === undefined ? undefined : toTables[toIndex];
	const fromCaption = from?.caption;
	const toCaption = to?.caption;
	const fromShape = from ? `${from.columns}x${from.rows.length}` : "-";
	const toShape = to ? `${to.columns}x${to.rows.length}` : "-";
	const shapeChanged = Boolean(from && to && from.columns !== to.columns);
	const cells: CellChange[] = [];

	if (from && to && alignment !== "unmatched" && !shapeChanged) {
		for (let row = 0; row < Math.min(from.rows.length, to.rows.length); row++) {
			const fromRow = from.rows[row] ?? [];
			const toRow = to.rows[row] ?? [];
			for (let column = 0; column < Math.max(fromRow.length, toRow.length); column++) {
				const before = fromRow[column] ?? "";
				const after = toRow[column] ?? "";
				if (normaliseCell(before) !== normaliseCell(after)) cells.push({ row: row + 1, column: column + 1, from: before, to: after });
			}
		}
	}

	return {
		index: (toIndex ?? fromIndex ?? 0) + 1,
		...(fromIndex !== undefined ? { fromIndex: fromIndex + 1 } : {}),
		...(toIndex !== undefined ? { toIndex: toIndex + 1 } : {}),
		alignment,
		...((from?.label ?? to?.label) ? { label: from?.label ?? to?.label } : {}),
		fromCaption,
		toCaption,
		captionChanged: Boolean(from && to && (fromCaption ?? "") !== (toCaption ?? "")),
		shapeChanged: shapeChanged || alignment === "unmatched",
		fromShape,
		toShape,
		cells,
		rowsAdded: from && to ? Math.max(0, to.rows.length - from.rows.length) : 0,
		rowsRemoved: from && to ? Math.max(0, from.rows.length - to.rows.length) : 0,
	};
}

/** One line per changed cell, the form a reader can scan. */
export function formatTableDeltas(deltas: TableDelta[], limit = 40): string[] {
	const out: string[] = [];
	for (const delta of deltas) {
		const caption = delta.toCaption ?? delta.fromCaption ?? delta.label ?? `table ${delta.index}`;
		const moved = delta.fromIndex !== undefined && delta.toIndex !== undefined && delta.fromIndex !== delta.toIndex;
		const tableNumber = `Table ${delta.toIndex ?? delta.fromIndex ?? delta.index}${moved ? ` (was ${delta.fromIndex})` : ""}`;
		const heading = `${tableNumber}: ${caption}`;
		const notes: string[] = [];
		if (delta.alignment === "unmatched") notes.push("not aligned; cell comparison omitted");
		else notes.push(`matched by ${delta.alignment}`);
		if (delta.captionChanged && delta.fromCaption && delta.toCaption) notes.push("caption changed");
		if (delta.shapeChanged) notes.push(`shape ${delta.fromShape} → ${delta.toShape}`);
		if (delta.rowsAdded > 0) notes.push(`${delta.rowsAdded} row(s) added`);
		if (delta.rowsRemoved > 0) notes.push(`${delta.rowsRemoved} row(s) removed`);
		out.push(`${heading} (${notes.join(", ")})`);

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
