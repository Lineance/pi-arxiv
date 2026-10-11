import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveConfig } from "../cfg.ts";
import { indexPapers } from "../corpus/index-papers.ts";
import { listDir, readText } from "../util/fsx.ts";
import { parseOutline } from "./outline.ts";

export interface PaperSearchHit {
	id: string;
	title: string;
	version?: string | undefined;
	file: string;
	section?: string | undefined;
	sectionNumber?: string | undefined;
	lineStart: number;
	lineEnd: number;
	snippet: string;
	score: number;
	matchedTerms: string[];
}

export interface PaperSearchOptions {
	id?: string | undefined;
	limit?: number | undefined;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_SNIPPET_CHARS = 420;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

function tokens(value: string): string[] {
	return [...new Set(value.toLowerCase().match(TOKEN_RE) ?? [])];
}

function scoreBlock(text: string, queryTerms: string[], phrase: string): { score: number; matched: string[] } {
	const normalized = text.toLowerCase();
	const matched = queryTerms.filter((term) => normalized.includes(term));
	if (matched.length === 0) return { score: 0, matched };
	const occurrences = matched.reduce((sum, term) => sum + (normalized.match(new RegExp(escapeRegExp(term), "gu"))?.length ?? 0), 0);
	return {
		score: matched.length * 10 + Math.min(occurrences, 20) + (phrase && normalized.includes(phrase) ? 8 : 0),
		matched,
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippet(text: string, queryTerms: string[]): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= MAX_SNIPPET_CHARS) return compact;
	const lower = compact.toLowerCase();
	const firstMatch = Math.min(...queryTerms.map((term) => lower.indexOf(term)).filter((index) => index >= 0));
	const start = Number.isFinite(firstMatch) ? Math.max(0, firstMatch - 120) : 0;
	const end = Math.min(compact.length, start + MAX_SNIPPET_CHARS);
	return `${start > 0 ? "…" : ""}${compact.slice(start, end).trim()}${end < compact.length ? "…" : ""}`;
}

async function markdownFiles(entry: Awaited<ReturnType<typeof indexPapers>>["entries"][number]): Promise<string[]> {
	const files = new Set<string>();
	if (entry.markdown) files.add(entry.markdown);
	if (entry.abstractMd) files.add(entry.abstractMd);
	if (entry.sourceDir) {
		for (const file of await listDir(entry.sourceDir)) {
			if (!file.dir && file.name.toLowerCase().endsWith(".md")) files.add(file.path);
		}
	}
	return [...files].sort();
}

async function searchFile(
	entry: Awaited<ReturnType<typeof indexPapers>>["entries"][number],
	file: string,
	queryTerms: string[],
	phrase: string,
): Promise<PaperSearchHit | undefined> {
	let markdown: string;
	try {
		markdown = await readText(file);
	} catch {
		return undefined;
	}

	const lines = markdown.split("\n");
	const outline = parseOutline(markdown);
	let best: PaperSearchHit | undefined;
	let start = 0;
	while (start < lines.length) {
		while (start < lines.length && !(lines[start] ?? "").trim()) start++;
		if (start >= lines.length) break;
		let end = start + 1;
		while (end < lines.length && (lines[end] ?? "").trim()) end++;

		const text = lines.slice(start, end).join(" ");
		const result = scoreBlock(text, queryTerms, phrase);
		if (result.score > (best?.score ?? 0)) {
			const heading = [...outline.headings].reverse().find((item) => item.startLine <= start && item.endLine > start);
			best = {
				id: entry.id,
				title: entry.title ?? entry.id,
				...(entry.version ? { version: entry.version } : {}),
				file,
				...(heading ? { section: heading.title, ...(heading.number ? { sectionNumber: heading.number } : {}) } : {}),
				lineStart: start + 1,
				lineEnd: end,
				snippet: snippet(text, queryTerms),
				score: result.score,
				matchedTerms: result.matched,
			};
		}
		start = end + 1;
	}
	return best;
}

/** Search locally converted Markdown and abstracts; no network or re-conversion. */
export async function searchPapers(papersDir: string, query: string, options: PaperSearchOptions = {}): Promise<PaperSearchHit[]> {
	const queryTerms = tokens(query);
	if (queryTerms.length === 0) return [];
	const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(options.limit ?? DEFAULT_LIMIT)));
	const phrase = query.trim().toLowerCase();
	const corpus = await indexPapers(papersDir);
	const hits: PaperSearchHit[] = [];

	for (const entry of corpus.entries) {
		if (options.id && entry.id !== options.id) continue;
		let best: PaperSearchHit | undefined;
		for (const file of await markdownFiles(entry)) {
			const hit = await searchFile(entry, file, queryTerms, phrase);
			if (hit && hit.score > (best?.score ?? 0)) best = hit;
		}
		if (best) hits.push(best);
	}

	return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function registerPaperSearchTool(pi: ExtensionAPI): void {
	pi.registerTool(
		defineTool({
			name: "paper_search",
			label: "Local paper search",
			description:
				"Search downloaded paper abstracts and converted Markdown without network access. Returns the best matching passage per paper with its section, file, line range, and matched terms.",
			promptSnippet: "paper_search — find passages across the local paper library",
			promptGuidelines: [
				"Use paper_search to find relevant passages across downloaded papers before opening a whole paper.",
				"Use the returned paper id and section with paper_section to read the surrounding section.",
			],
			parameters: Type.Object({
				query: Type.String({ minLength: 1, description: "Words or phrase to find in local abstracts and converted papers" }),
				id: Type.Optional(Type.String({ description: "Restrict search to one arXiv id" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT, description: `Maximum results (default ${DEFAULT_LIMIT})` })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			outputSchema: Type.Object({
				query: Type.String(),
				count: Type.Number(),
				hits: Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.String(),
						version: Type.Optional(Type.String()),
						file: Type.String(),
						section: Type.Optional(Type.String()),
						sectionNumber: Type.Optional(Type.String()),
						lineStart: Type.Number(),
						lineEnd: Type.Number(),
						snippet: Type.String(),
						score: Type.Number(),
						matchedTerms: Type.Array(Type.String()),
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
				const config = resolveConfig(pi, ctx.cwd);
				const hits = await searchPapers(config.papersDir, params.query, { id: params.id, limit: params.limit });
				const structuredHits = hits.map((hit) => ({
					id: hit.id,
					title: hit.title,
					...(hit.version ? { version: hit.version } : {}),
					file: hit.file,
					...(hit.section ? { section: hit.section } : {}),
					...(hit.sectionNumber ? { sectionNumber: hit.sectionNumber } : {}),
					lineStart: hit.lineStart,
					lineEnd: hit.lineEnd,
					snippet: hit.snippet,
					score: hit.score,
					matchedTerms: hit.matchedTerms,
				}));
				return {
					content: [{ type: "text", text: hits.length ? hits.map(formatSearchHit).join("\n\n") : `No local matches for: ${params.query}` }],
					details: { query: params.query, count: hits.length, hits },
					structuredContent: { query: params.query, count: hits.length, hits: structuredHits },
				};
			},
		}),
	);
}

export function formatSearchHit(hit: PaperSearchHit): string {
	const section = hit.section ? ` · ${hit.sectionNumber ? `${hit.sectionNumber} ` : ""}${hit.section}` : "";
	const version = hit.version ? ` ${hit.version}` : "";
	return `${hit.id}${version} — ${hit.title}${section}\n${hit.file}:${hit.lineStart}-${hit.lineEnd}\n${hit.snippet}`;
}
