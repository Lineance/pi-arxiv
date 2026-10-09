/**
 * Model-facing tools: arxiv_lookup / arxiv_pull / paper_markdown / papers_index
 * plus paper_toolchain.
 *
 * Results keep the model-facing text short (paths, counts, warnings) and carry
 * the structured payload in `details` + `structuredContent`; the full Markdown
 * is read with the normal file tools.
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { lookupById, parseArxivId, searchByTitle } from "./arxiv/api.ts";
import { pull } from "./arxiv/pull.ts";
import { LIB_VERSION, resolveConfig } from "./cfg.ts";
import { convertSourceDir, summarizeStats, summarizeWarnings } from "./convert/convert.ts";
import { type CorpusBadge, formatReport, indexPapers, issueBadge } from "./corpus/index-papers.ts";
import { registerPaperSectionTool } from "./paper/tool.ts";
import type { ArxivMeta, ConvertResult, ConvertWarning, ExecLike } from "./types.ts";
import { writeFileQueued } from "./util/fsx.ts";
import { detectToolchain } from "./util/toolchain.ts";

const WarningSchema = Type.Object({
	rule: Type.String(),
	level: Type.String(),
	message: Type.String(),
});

/** JSON-safe projections so `structuredContent` satisfies the JsonValue contract. */
function warningJson(warnings: ConvertWarning[]) {
	return warnings.map((warning) => ({ rule: warning.rule, level: warning.level as string, message: warning.message }));
}

function statsJson(stats: {
	lines: number;
	images: number;
	tables: number;
	tablesRebuilt: number;
	figuresRecovered: number;
	refs: number;
	equations: number;
}) {
	return {
		lines: stats.lines,
		images: stats.images,
		tables: stats.tables,
		tablesRebuilt: stats.tablesRebuilt,
		figuresRecovered: stats.figuresRecovered,
		refs: stats.refs,
		equations: stats.equations,
	};
}

function warningLines(warnings: ConvertWarning[]): string[] {
	return summarizeWarnings(warnings, 8);
}

/** Model-facing digest of one paper: citation line plus a bounded abstract. */
function formatMeta(meta: ArxivMeta): string {
	const lines = [
		`${meta.id}${meta.version ?? ""} — ${meta.title}`,
		`Authors: ${meta.authors.slice(0, 6).join(", ")}${meta.authors.length > 6 ? ", et al." : ""}`,
		`Categories: ${meta.categories.join(", ") || "n/a"}`,
		meta.published ? `Published: ${meta.published}` : "",
		"",
		meta.abstract.length > 900 ? `${meta.abstract.slice(0, 900)}…` : meta.abstract,
	].filter(Boolean);
	return lines.join("\n");
}

export function registerTools(pi: ExtensionAPI, exec: ExecLike): void {
	// ------------------------------------------------------------ arxiv_lookup
	pi.registerTool(
		defineTool({
			name: "arxiv_lookup",
			label: "arXiv lookup",
			description:
				"Look up arXiv metadata by id (e.g. 2609.35319), URL, or title. Returns title, authors, abstract, categories, and the abs/pdf/html/source URLs. Read-only and cheap; use it before downloading.",
			promptSnippet: "arxiv_lookup — resolve an arXiv id/URL/title to metadata",
			promptGuidelines: ["Use arxiv_lookup when you need paper metadata or when turning a title into an id before arxiv_pull."],
			parameters: Type.Object({
				query: Type.String({ description: "arXiv id (2609.35319 / arXiv:2609.35319v1), arxiv.org URL, or a paper title" }),
				limit: Type.Optional(Type.Number({ description: "Max title-search matches (default 3)" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
			outputSchema: Type.Object({
				matched: Type.Array(
					Type.Object({
						id: Type.String(),
						version: Type.Optional(Type.String()),
						title: Type.String(),
						authors: Type.Array(Type.String()),
						abstract: Type.String(),
						categories: Type.Array(Type.String()),
						absUrl: Type.String(),
						pdfUrl: Type.String(),
						htmlUrl: Type.String(),
					}),
				),
			}),
			async execute(_id, params, signal) {
				const query = params.query.trim();
				const byId = parseArxivId(query);
				const matches = byId ? [await lookupById(query, { signal })] : await searchByTitle(query, params.limit ?? 3, { signal });
				if (matches.length === 0) return { content: [{ type: "text", text: `No arXiv match for: ${query}` }], details: undefined };
				const text = matches.map((meta) => formatMeta(meta)).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text }],
					details: { count: matches.length, ids: matches.map((match) => match.id) },
					structuredContent: {
						matched: matches.map((match) => ({
							id: match.id,
							...(match.version ? { version: match.version } : {}),
							title: match.title,
							authors: match.authors,
							abstract: match.abstract,
							categories: match.categories,
							absUrl: match.absUrl,
							pdfUrl: match.pdfUrl,
							htmlUrl: match.htmlUrl,
						})),
					},
				};
			},
		}),
	);

	// ------------------------------------------------------------ arxiv_pull
	pi.registerTool(
		defineTool({
			name: "arxiv_pull",
			label: "arXiv download",
			description:
				"Download an arXiv paper: PDF, LaTeX e-print source (extracted, path-traversal safe), metadata, and a manifest.json for provenance. With convert=true the source is immediately turned into clean Markdown (KaTeX-safe math, rebuilt tables, restored captions/abstract). Existing files are reused unless force=true.",
			promptSnippet: "arxiv_pull — download PDF + LaTeX source (+ optional Markdown) for an arXiv paper",
			promptGuidelines: [
				"For 'read/summarise this arXiv paper' requests, call arxiv_pull with convert=true, then read the returned markdownPath with the read tool.",
				"Prefer the converted Markdown over the PDF: the Markdown URL and mode for each artifact are listed in the tool result and manifest.json.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "arXiv id, URL, or title" }),
				destDir: Type.Optional(Type.String({ description: "Directory for this paper (default: <papersDir>/<id>)" })),
				version: Type.Optional(Type.String({ description: "Pin a version, e.g. v1 (default: latest)" })),
				parts: Type.Optional(
					Type.Array(Type.String({ description: "pdf | source | abs" }), { description: "Which parts to download (default all)" }),
				),
				convert: Type.Optional(Type.Boolean({ description: "Convert the LaTeX source to Markdown right away (default true)" })),
				figures: Type.Optional(Type.Boolean({ description: "Rasterize figure PDFs to PNG (default from settings)" })),
				force: Type.Optional(Type.Boolean({ description: "Re-download even if files exist" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
			outputSchema: Type.Object({
				id: Type.String(),
				version: Type.String(),
				dir: Type.String(),
				pdfPath: Type.Optional(Type.String()),
				sourceDir: Type.Optional(Type.String()),
				markdownPath: Type.Optional(Type.String()),
				manifestPath: Type.String(),
				warnings: Type.Array(WarningSchema),
			}),
			async execute(_id, params, signal, onUpdate, ctx: ExtensionToolContext) {
				const config = resolveConfig(pi, ctx.cwd, {
					papersDir: params.destDir ? resolve(ctx.cwd, params.destDir) : undefined,
					figures: params.figures,
				});
				const byId = parseArxivId(params.query);
				onUpdate?.({ content: [{ type: "text", text: byId ? `Resolving ${byId.id}…` : "Searching arXiv…" }], details: undefined });
				const matches = byId ? [await lookupById(params.query, { signal })] : await searchByTitle(params.query, 1, { signal });
				const meta = matches[0];
				if (!meta) return { content: [{ type: "text", text: `No arXiv match for: ${params.query}` }], details: undefined };

				const destDir = params.destDir ? resolve(ctx.cwd, params.destDir) : join(config.papersDir, meta.id);
				const parts = (params.parts ?? ["pdf", "source", "abs"]).filter(
					(part): part is "pdf" | "source" | "abs" => part === "pdf" || part === "source" || part === "abs",
				);
				const pulled = await pull(meta, {
					destDir,
					parts,
					version: params.version,
					force: params.force,
					timeoutMs: config.timeoutMs,
					signal,
					libVersion: LIB_VERSION,
					onRetry: (attempt, error) =>
						onUpdate?.({ content: [{ type: "text", text: `retry ${attempt}: ${error.message}` }], details: undefined }),
				});

				let converted: ConvertResult | undefined;
				if ((params.convert ?? true) && pulled.sourceDir) {
					onUpdate?.({ content: [{ type: "text", text: `Converting ${meta.id} to Markdown…` }], details: undefined });
					converted = await convertSourceDir(
						{
							workDir: pulled.sourceDir,
							outFile: join(pulled.sourceDir, `${meta.id}.md`),
							figures: config.figures,
							figureDpi: config.figureDpi,
							tableMode: config.tableMode,
							arxivMeta: meta,
						},
						{ exec, log: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: undefined }) },
					);
					pulled.manifest.outputs.markdown = converted.markdownPath;
					pulled.manifest.outputs.conversion = converted.stats;
					pulled.manifest.warnings = [...pulled.manifest.warnings, ...(converted.warnings ?? [])];
					await writeFileQueued(pulled.manifestPath, `${JSON.stringify(pulled.manifest, null, 2)}\n`);
				}

				const lines = [
					`${meta.id}${meta.version ?? ""} — ${meta.title}`,
					`directory: ${destDir}`,
					pulled.pdfPath ? `pdf: ${pulled.pdfPath}` : "",
					pulled.sourceDir ? `source: ${pulled.sourceDir}` : "",
					converted?.markdownPath ? `markdown: ${converted.markdownPath}` : "",
					`manifest: ${pulled.manifestPath}`,
					converted?.markdownPath ? `stats: ${summarizeStats(converted.stats)}` : "",
					pulled.reused.length > 0 ? `reused: ${pulled.reused.length} existing file(s)` : "",
					...warningLines([...pulled.warnings, ...(converted?.warnings ?? [])]),
				].filter(Boolean);

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						id: meta.id,
						version: pulled.version,
						markdownPath: converted?.markdownPath,
						stats: converted?.stats,
						figures: converted?.figures,
						warnings: [...pulled.warnings, ...(converted?.warnings ?? [])],
					},
					structuredContent: {
						id: meta.id,
						version: pulled.version,
						dir: destDir,
						...(pulled.pdfPath ? { pdfPath: pulled.pdfPath } : {}),
						...(pulled.sourceDir ? { sourceDir: pulled.sourceDir } : {}),
						...(converted?.markdownPath ? { markdownPath: converted.markdownPath } : {}),
						manifestPath: pulled.manifestPath,
						warnings: warningJson([...pulled.warnings, ...(converted?.warnings ?? [])]),
					},
				};
			},
		}),
	);

	// ------------------------------------------------------------ paper_markdown
	pi.registerTool(
		defineTool({
			name: "paper_markdown",
			label: "LaTeX → Markdown",
			description:
				"Convert a local LaTeX source directory (or a downloaded arXiv e-print) into clean Markdown with pandoc plus post-processing: correct \\ref numbering from LaTeX counters, rebuilt multirow/multicolumn tables, restored dropped captions and abstracts, KaTeX-safe math, numbered headings, flattened bibliography. Reports everything it had to repair.",
			promptSnippet: "paper_markdown — convert a LaTeX paper directory into clean Markdown",
			parameters: Type.Object({
				sourceDir: Type.String({ description: "Directory containing main.tex (and figures/)" }),
				mainTex: Type.Optional(Type.String({ description: "Explicit main .tex file name" })),
				outFile: Type.Optional(Type.String({ description: "Output .md path (default <sourceDir>/<dir>.md)" })),
				figures: Type.Optional(Type.Boolean({ description: "Rasterize figure PDFs to PNG" })),
				tableMode: Type.Optional(Type.String({ description: "gfm (default) or html" })),
				keepIntermediate: Type.Optional(Type.Boolean({ description: "Also write the raw pandoc output next to the result" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			outputSchema: Type.Object({
				ok: Type.Boolean(),
				markdownPath: Type.Optional(Type.String()),
				stats: Type.Object({
					lines: Type.Number(),
					images: Type.Number(),
					tables: Type.Number(),
					tablesRebuilt: Type.Number(),
					figuresRecovered: Type.Number(),
					refs: Type.Number(),
					equations: Type.Number(),
				}),
				warnings: Type.Array(WarningSchema),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				const sourceDir = resolve(ctx.cwd, params.sourceDir);
				const config = resolveConfig(pi, ctx.cwd, { figures: params.figures });
				const result = await convertSourceDir(
					{
						workDir: sourceDir,
						mainTex: params.mainTex,
						outFile: params.outFile ? resolve(ctx.cwd, params.outFile) : undefined,
						figures: config.figures,
						figureDpi: config.figureDpi,
						tableMode: params.tableMode === "html" ? "html" : config.tableMode,
						keepIntermediate: params.keepIntermediate,
					},
					{ exec },
				);
				const text = [
					result.ok ? `markdown: ${result.markdownPath}` : "conversion failed",
					result.ok ? `stats: ${summarizeStats(result.stats)}` : "",
					result.figures.length > 0 ? `figures: ${result.figures.length}` : "",
					...warningLines(result.warnings),
				]
					.filter(Boolean)
					.join("\n");
				return {
					content: [{ type: "text", text }],
					details: { ...result },
					structuredContent: {
						ok: result.ok,
						...(result.markdownPath ? { markdownPath: result.markdownPath } : {}),
						stats: statsJson(result.stats),
						warnings: warningJson(result.warnings),
					},
				};
			},
		}),
	);

	// ------------------------------------------------------------ papers_index
	pi.registerTool(
		defineTool({
			name: "papers_index",
			label: "Paper corpus index",
			description:
				"Inventory the local paper corpus: how many papers are present, which lack a PDF, LaTeX source or converted Markdown, which have a Markdown older than its source, and which are left over from the older flat layout. Read-only — it reports, it never repairs.",
			promptSnippet: "papers_index — list the local paper corpus and what each entry is missing",
			promptGuidelines: [
				"Run papers_index before assuming a paper is already downloaded: it reports which entries lack a converted Markdown.",
			],
			parameters: Type.Object({
				includeHealthy: Type.Optional(
					Type.Boolean({ description: "List healthy papers too (default true); false shows only entries needing attention" }),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			outputSchema: Type.Object({
				papersDir: Type.String(),
				total: Type.Number(),
				broken: Type.Number(),
				incomplete: Type.Number(),
				legacy: Type.Array(Type.String()),
				entries: Type.Array(
					Type.Object({
						id: Type.String(),
						status: Type.String(),
						hasPdf: Type.Boolean(),
						hasSource: Type.Boolean(),
						hasMarkdown: Type.Boolean(),
						issues: Type.Array(Type.String()),
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				const config = resolveConfig(pi, ctx.cwd);
				const report = await indexPapers(config.papersDir);
				const render = formatReport(report, { includeHealthy: params.includeHealthy ?? true });

				const counts = new Map<CorpusBadge, number>();
				for (const entry of report.entries) {
					const badge = issueBadge(entry);
					counts.set(badge, (counts.get(badge) ?? 0) + 1);
				}

				return {
					content: [{ type: "text", text: render }],
					details: { report },
					structuredContent: {
						papersDir: report.papersDir,
						total: report.entries.length,
						broken: counts.get("error") ?? 0,
						incomplete: counts.get("warn") ?? 0,
						legacy: report.legacy,
						entries: report.entries.map((entry) => ({
							id: entry.id,
							status: issueBadge(entry),
							hasPdf: Boolean(entry.pdf),
							hasSource: Boolean(entry.sourceDir),
							hasMarkdown: Boolean(entry.markdown),
							issues: entry.issues.map((issue) => issue.message),
						})),
					},
				};
			},
		}),
	);

	// ------------------------------------------------------------ paper_section
	registerPaperSectionTool(pi);

	// ------------------------------------------------------------ toolchain
	pi.registerTool(
		defineTool({
			name: "paper_toolchain",
			label: "Paper toolchain check",
			description:
				"Report whether the external tools needed by the paper pipeline are available (pandoc for LaTeX→Markdown, pdftotext for text extracts, pdftoppm for figure rasterization), with versions and install hints.",
			promptSnippet: "paper_toolchain — check pandoc/pdftotext/pdftoppm availability",
			parameters: Type.Object({}),
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			async execute(_id, _params, signal) {
				const statuses = await detectToolchain(exec, signal);
				const lines = Object.values(statuses).map((status) =>
					status.available ? `✓ ${status.name} ${status.version ?? ""}`.trim() : `✗ ${status.name} — ${status.hint}`,
				);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { statuses },
				};
			},
		}),
	);
}
