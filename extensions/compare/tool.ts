/**
 * `arxiv_diff` — compare two versions of the same paper.
 *
 * Materialises each requested version under `<papersDir>/<id>/versions/<v>/` and
 * compares them. The current version is reused from the primary directory rather
 * than downloaded twice, so asking for v1 vs the version already on disk costs
 * one download.
 *
 * The output is deliberately bounded: a line-level diff of a revised paper can
 * run to hundreds of lines, and the part that matters is usually a handful of
 * changed numbers. The table deltas come first and are never truncated to
 * nothing; the text diffs are capped and say so.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookupById, parseArxivId } from "../arxiv/api.ts";
import { pull } from "../arxiv/pull.ts";
import { LIB_VERSION, resolveConfig } from "../cfg.ts";
import { convertSourceDir } from "../convert/convert.ts";
import type { ExecLike } from "../types.ts";
import { formatUnified, type LineDiff, summarizeDiff } from "./lines.ts";
import { compareVersions, formatTableDeltas, summarizeComparison } from "./versions.ts";

const DEFAULT_DIFF_LINES = 200;

const TableChangeSchema = Type.Object({
	table: Type.Number(),
	fromTable: Type.Optional(Type.Number()),
	toTable: Type.Optional(Type.Number()),
	alignment: Type.String(),
	label: Type.Optional(Type.String()),
	caption: Type.Optional(Type.String()),
	changes: Type.Array(Type.String()),
});

const DiffSchema = Type.Object({
	id: Type.String(),
	from: Type.String(),
	to: Type.String(),
	summary: Type.String(),
	filesAdded: Type.Array(Type.String()),
	filesRemoved: Type.Array(Type.String()),
	filesChanged: Type.Array(Type.String()),
	tables: Type.Array(TableChangeSchema),
	hasMarkdownDiff: Type.Boolean(),
});

/** One version: where its source lives and, when converted, its Markdown. */
interface Materialised {
	version: string;
	sourceDir: string;
	markdownPath?: string | undefined;
}

export function registerArxivDiffTool(pi: ExtensionAPI, exec: ExecLike): void {
	pi.registerTool(
		defineTool({
			name: "arxiv_diff",
			label: "arXiv version diff",
			description:
				"Compare two versions of the same arXiv paper (for example v1 and v2). Reports which source files were added, removed or changed, which table cells changed value, and a bounded line-level diff of the LaTeX and of the converted Markdown. Use it to see what a revision actually changed before citing a number.",
			promptSnippet: "arxiv_diff — compare two versions of a paper, including changed table numbers",
			promptGuidelines: [
				"Use arxiv_diff before quoting a number from a paper that has more than one version, to check whether it moved.",
				"The table section lists changed cells; treat those as the citation-relevant part of the revision.",
			],
			parameters: Type.Object({
				id: Type.String({ description: "arXiv id (both sides are versions of this one paper)" }),
				from: Type.String({ description: 'Base version, e.g. "v1"' }),
				to: Type.String({ description: 'Compared version, e.g. "v2", or "latest"' }),
				maxDiffLines: Type.Optional(
					Type.Integer({ minimum: 1, maximum: 2000, description: `Cap on each text diff (default ${DEFAULT_DIFF_LINES}, max 2000)` }),
				),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			outputSchema: DiffSchema,

			async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
				const parsed = parseArxivId(params.id);
				if (!parsed) {
					return fail(`"${params.id}" is not an arXiv id. A version diff needs one specific paper, so a title is not enough.`);
				}

				const config = resolveConfig(pi, ctx.cwd);
				const meta = await lookupById(parsed.id, { signal });
				const paperDir = join(config.papersDir, meta.id);
				const want = {
					from: normaliseVersion(params.from),
					to: normaliseVersion(params.to === "latest" ? (meta.version ?? "latest") : params.to),
				};

				if (want.from === want.to) {
					return fail(`Both sides are ${want.from}; nothing to compare.`);
				}

				let from: Materialised;
				let to: Materialised;
				try {
					from = await materialise(want.from, meta, paperDir, exec, signal);
					to = await materialise(want.to, meta, paperDir, exec, signal);
				} catch (error) {
					return fail(`Could not obtain both versions: ${(error as Error).message}`, { id: meta.id, from: want.from, to: want.to });
				}

				const diff = await compareVersions({
					id: meta.id,
					from: { version: want.from, dir: from.sourceDir },
					to: { version: want.to, dir: to.sourceDir },
					markdown: { from: from.markdownPath, to: to.markdownPath },
				});

				const maxLines = params.maxDiffLines ?? DEFAULT_DIFF_LINES;
				const tableLines = formatTableDeltas(diff.tables);
				const sections: string[] = [
					`${meta.id}: ${want.from} → ${want.to}`,
					summarizeComparison(diff),
					"",
					"## Table changes",
					tableLines.length > 0 ? tableLines.join("\n") : "_no table cell changed value_",
				];

				if (diff.files.added.length + diff.files.removed.length + diff.files.changed.length > 0) {
					sections.push("", "## Files");
					for (const file of diff.files.added) sections.push(`  + ${file}`);
					for (const file of diff.files.removed) sections.push(`  - ${file}`);
					for (const file of diff.files.changed) sections.push(`  ~ ${file}`);
				}

				sections.push("", "## LaTeX diff", renderDiff(`a/main.tex`, `b/main.tex`, diff.latex, maxLines));
				if (diff.markdown) {
					sections.push("", "## Converted Markdown diff", renderDiff("a/paper.md", "b/paper.md", diff.markdown, maxLines));
				}

				return {
					content: [{ type: "text", text: sections.join("\n") }],
					details: { id: meta.id, from: want.from, to: want.to, tables: diff.tables },
					structuredContent: {
						id: meta.id,
						from: want.from,
						to: want.to,
						summary: summarizeComparison(diff),
						filesAdded: diff.files.added,
						filesRemoved: diff.files.removed,
						filesChanged: diff.files.changed,
						tables: diff.tables.map((delta) => ({
							table: delta.index,
							...(delta.fromIndex !== undefined ? { fromTable: delta.fromIndex } : {}),
							...(delta.toIndex !== undefined ? { toTable: delta.toIndex } : {}),
							alignment: delta.alignment,
							...(delta.label ? { label: delta.label } : {}),
							...((delta.toCaption ?? delta.fromCaption) ? { caption: delta.toCaption ?? delta.fromCaption ?? "" } : {}),
							changes: delta.cells.map((cell) => `r${cell.row}c${cell.column}: ${cell.from || "(empty)"} → ${cell.to || "(empty)"}`),
						})),
						hasMarkdownDiff: diff.hasMarkdown,
					},
				};
			},
		}),
	);
}

function normaliseVersion(value: string): string {
	const trimmed = value.trim().toLowerCase();
	return /^v?\d+$/.test(trimmed) ? (trimmed.startsWith("v") ? trimmed : `v${trimmed}`) : trimmed;
}

/**
 * Ensure one version is on disk and converted.
 *
 * The version already in the primary directory is reused as-is; anything else is
 * downloaded into `versions/<v>/`, which keeps the primary paper untouched.
 */
async function materialise(
	version: string,
	meta: Awaited<ReturnType<typeof lookupById>>,
	paperDir: string,
	exec: ExecLike,
	signal: AbortSignal | undefined,
): Promise<Materialised> {
	const primarySource = join(paperDir, "source");
	if (meta.version === version && existsSync(primarySource) && (await primaryManifestMatches(paperDir, version))) {
		return { version, sourceDir: primarySource, markdownPath: await convert(primarySource, meta.id, exec, signal) };
	}

	const destDir = join(paperDir, "versions", version);
	const pulled = await pull(meta, { destDir, version, parts: ["source"], timeoutMs: 120_000, signal, libVersion: LIB_VERSION });
	if (!pulled.sourceDir) throw new Error(`no LaTeX source available for ${version}`);

	return { version, sourceDir: pulled.sourceDir, markdownPath: await convert(pulled.sourceDir, meta.id, exec, signal) };
}

async function primaryManifestMatches(paperDir: string, version: string): Promise<boolean> {
	try {
		const manifest = JSON.parse(await readFile(join(paperDir, "manifest.json"), "utf8")) as { version?: unknown };
		return typeof manifest.version === "string" && normaliseVersion(manifest.version) === version;
	} catch {
		return false;
	}
}

/**
 * Convert a version for the Markdown diff; figures are irrelevant to a diff.
 *
 * The output goes *beside* the source directory rather than inside it: the
 * comparison walks everything under `source/`, so a generated file there would
 * show up as a changed file in every diff — our own output masquerading as a
 * revision.
 */
async function convert(workDir: string, id: string, exec: ExecLike, signal: AbortSignal | undefined): Promise<string | undefined> {
	const result = await convertSourceDir(
		{ workDir, outFile: join(dirname(workDir), `${id}.diff.md`), figures: false },
		{ exec, log: () => undefined, signal },
	);
	return result.ok ? result.markdownPath : undefined;
}

function renderDiff(fromLabel: string, toLabel: string, diff: LineDiff, maxLines: number): string {
	const rendered = formatUnified(fromLabel, toLabel, diff);
	if (rendered === "") return `_${summarizeDiff(diff)}_`;

	const lines = rendered.split("\n");
	if (lines.length <= maxLines) return rendered;
	const omitted = lines.length - maxLines;
	return [`${lines.slice(0, maxLines).join("\n")}`, `… ${omitted} more diff line(s) omitted (raise maxDiffLines to see them)`].join("\n");
}

function fail(text: string, details?: unknown) {
	return { content: [{ type: "text" as const, text }], details, isError: true as const };
}
