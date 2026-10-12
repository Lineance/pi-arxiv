/**
 * `paper_section` — read one section of a converted paper.
 *
 * Lives in its own module because it is the one tool that is purely about
 * reading a document we produced: it needs no network, no external tool and no
 * conversion state, only the Markdown and the outline parser.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveConfig } from "../cfg.ts";
import type { ExecLike } from "../types.ts";
import { exists, readText } from "../util/fsx.ts";
import { type ApproximatePdfPages, makeEvidenceLocation, mapSectionToPdfPages } from "./evidence.ts";
import { locateMarkdown } from "./locate.ts";
import { extractSection, formatTableOfContents, MAX_SECTION_BYTES, MIN_SECTION_BYTES, parseOutline, selectSection } from "./outline.ts";

const DEFAULT_MAX_BYTES = 16_000;

const pdfTextCache = new Map<string, { mtimeMs: number; size: number; text: string }>();
const SectionSchema = Type.Object({
	markdownPath: Type.String(),
	section: Type.Optional(Type.String()),
	number: Type.Optional(Type.String()),
	lines: Type.Optional(Type.Number()),
	lineStart: Type.Optional(Type.Number()),
	lineEnd: Type.Optional(Type.Number()),
	evidenceId: Type.Optional(Type.String()),
	contentHash: Type.Optional(Type.String()),
	pdfPages: Type.Optional(Type.Object({ start: Type.Number(), end: Type.Number(), confidence: Type.String() })),
	candidates: Type.Optional(Type.Array(Type.String())),
	text: Type.String(),
});

export function registerPaperSectionTool(pi: ExtensionAPI, exec?: ExecLike): void {
	pi.registerTool(
		defineTool({
			name: "paper_section",
			label: "Paper section",
			description:
				"Read one section of a converted paper instead of the whole file. Omit `section` to get the table of contents first. Accepts a section number (3.2, A.1), a title, or a fragment of one; returns the section with its subsections, and reports the closest matches when a name is ambiguous or unknown.",
			promptSnippet: "paper_section — read one section of a converted paper, or list its sections",
			promptGuidelines: [
				"Prefer paper_section over reading a whole converted paper: a full paper is ~75 KB and a question usually concerns one section.",
				"Call paper_section without `section` first when you do not know the numbering.",
			],
			parameters: Type.Object({
				source: Type.Optional(Type.String({ description: "Path to a converted .md file, or to a paper directory" })),
				id: Type.Optional(Type.String({ description: "arXiv id to locate under papersDir (alternative to source)" })),
				section: Type.Optional(Type.String({ description: "Section number, title, or a fragment; omit for the table of contents" })),
				includeSubsections: Type.Optional(Type.Boolean({ description: "Include nested subsections (default true)" })),
				maxBytes: Type.Optional(
					Type.Integer({
						minimum: MIN_SECTION_BYTES,
						maximum: MAX_SECTION_BYTES,
						description: `Cap section body in UTF-8 bytes (default ${DEFAULT_MAX_BYTES}, max ${MAX_SECTION_BYTES})`,
					}),
				),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			outputSchema: SectionSchema,

			async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
				signal?.throwIfAborted();
				const config = resolveConfig(pi, ctx.cwd);
				const located = await locateMarkdown({
					source: params.source,
					id: params.id,
					papersDir: config.papersDir,
					cwd: ctx.cwd,
				});

				if (!located.markdownPath) {
					return fail(notFoundMessage(located.searched));
				}

				const markdownPath = located.markdownPath;
				const markdown = await readText(markdownPath);
				signal?.throwIfAborted();
				const outline = parseOutline(markdown);

				// No selector means "tell me what is in here".
				if (!params.section) {
					const toc = formatTableOfContents(outline);
					return {
						content: [{ type: "text", text: `${markdownPath}\n\n${toc}` }],
						details: { markdownPath, sections: outline.headings.length },
						structuredContent: { markdownPath, text: toc },
					};
				}

				const selected = selectSection(outline, params.section);

				if (selected.kind === "ambiguous") {
					const candidates = selected.candidates.map(label);
					return {
						content: [
							{
								type: "text",
								text: `"${params.section}" matches ${candidates.length} sections; pass the number.\n${bullets(candidates)}`,
							},
						],
						details: { markdownPath, candidates },
						structuredContent: { markdownPath, candidates, text: "" },
					};
				}

				if (selected.kind === "missing") {
					const candidates = selected.suggestions.map(label);
					return {
						content: [
							{
								type: "text",
								text: `No section matches "${params.section}". Closest headings:\n${bullets(candidates)}\n\nCall again without "section" for the full table of contents.`,
							},
						],
						details: { markdownPath, candidates },
						structuredContent: { markdownPath, candidates, text: "" },
					};
				}

				const heading = selected.heading;
				const includeSubsections = params.includeSubsections ?? true;
				const childHeading = includeSubsections
					? undefined
					: outline.headings.find((candidate) => candidate.startLine > heading.startLine && candidate.level > heading.level);
				const endLine = childHeading?.startLine ?? heading.endLine;
				const lineStart = heading.startLine + 1;
				const lineEnd = endLine;
				const sectionSource = outline.lines.slice(heading.startLine, endLine).join("\n").trimEnd();
				const paper = await paperMetadata(markdownPath, params.id, config.papersDir);
				const evidence = makeEvidenceLocation(paper.id, paper.version, lineStart, lineEnd, sectionSource);
				const pdfPages = exec ? await findPdfPages(exec, paper.pdfPath, sectionSource, signal) : undefined;
				const text = extractSection(outline, heading, {
					includeSubsections,
					maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES,
				});
				const locator = [
					`evidence: ${evidence.id}`,
					`${markdownPath}:${lineStart}-${lineEnd}`,
					...(pdfPages ? [`approx. PDF pages ${pdfPages.start}-${pdfPages.end}`] : []),
				].join(" | ");

				return {
					content: [{ type: "text", text: `${text}\n\n[${locator}]` }],
					details: {
						markdownPath,
						matched: selected.how,
						number: heading.number,
						lineStart,
						lineEnd,
						evidenceId: evidence.id,
						pdfPages,
					},
					structuredContent: {
						markdownPath,
						section: heading.title,
						...(heading.number ? { number: heading.number } : {}),
						lines: lineEnd - lineStart + 1,
						lineStart,
						lineEnd,
						evidenceId: evidence.id,
						contentHash: evidence.contentHash,
						...(pdfPages ? { pdfPages: { start: pdfPages.start, end: pdfPages.end, confidence: pdfPages.confidence } } : {}),
						text,
					},
				};
			},
		}),
	);
}

interface PaperMetadata {
	id: string;
	version?: string | undefined;
	pdfPath?: string | undefined;
}

async function paperMetadata(markdownPath: string, requestedId: string | undefined, papersDir: string): Promise<PaperMetadata> {
	const markdownDir = dirname(markdownPath);
	const paperDir = basename(markdownDir).toLowerCase() === "source" ? dirname(markdownDir) : markdownDir;
	let manifest: { id?: unknown; version?: unknown } = {};
	try {
		manifest = JSON.parse(await readFile(join(paperDir, "manifest.json"), "utf8")) as typeof manifest;
	} catch {
		// Hand-converted Markdown has no managed manifest.
	}

	const id = typeof manifest.id === "string" ? manifest.id : (requestedId ?? basename(paperDir));
	const version = typeof manifest.version === "string" ? manifest.version : undefined;
	const versioned = markdownPath.split(/[\\/]/).includes("versions");
	const candidates = [
		...(requestedId && !versioned ? [join(papersDir, requestedId, `${requestedId}.pdf`)] : []),
		join(paperDir, `${id}.pdf`),
		join(markdownDir, `${id}.pdf`),
	];
	let pdfPath: string | undefined;
	for (const candidate of new Set(candidates)) {
		if (await exists(candidate)) {
			pdfPath = candidate;
			break;
		}
	}
	return { id, version, pdfPath };
}

async function findPdfPages(
	exec: ExecLike,
	pdfPath: string | undefined,
	sectionText: string,
	signal: AbortSignal | undefined,
): Promise<ApproximatePdfPages | undefined> {
	if (!pdfPath || !(await exists(pdfPath))) return undefined;
	signal?.throwIfAborted();
	try {
		const metadata = await stat(pdfPath);
		const cached = pdfTextCache.get(pdfPath);
		let pdfText = cached?.mtimeMs === metadata.mtimeMs && cached.size === metadata.size ? cached.text : undefined;
		if (!pdfText) {
			const result = await exec("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
				timeout: 60_000,
				signal,
			});
			signal?.throwIfAborted();
			if (result.code !== 0 || result.killed) return undefined;
			pdfText = result.stdout;
			pdfTextCache.set(pdfPath, { mtimeMs: metadata.mtimeMs, size: metadata.size, text: pdfText });
			while (pdfTextCache.size > 4) pdfTextCache.delete(pdfTextCache.keys().next().value as string);
		}
		return mapSectionToPdfPages(sectionText, pdfText);
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

function label(heading: { number?: string | undefined; title: string }): string {
	return heading.number ? `${heading.number} ${heading.title}` : heading.title;
}

function bullets(items: string[]): string {
	return items.map((item) => `  ${item}`).join("\n");
}

function notFoundMessage(searched: string[]): string {
	const hint = searched.length > 0 ? `\nsearched:\n${bullets(searched)}` : "";
	return `No converted Markdown found. Pass source=<path to .md> or id=<arXiv id>, or run arxiv_pull first.${hint}`;
}

function fail(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}
