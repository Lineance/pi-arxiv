/**
 * `paper_section` — read one section of a converted paper.
 *
 * Lives in its own module because it is the one tool that is purely about
 * reading a document we produced: it needs no network, no external tool and no
 * conversion state, only the Markdown and the outline parser.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveConfig } from "../cfg.ts";
import { readText } from "../util/fsx.ts";
import { locateMarkdown } from "./locate.ts";
import { extractSection, formatTableOfContents, parseOutline, selectSection } from "./outline.ts";

const DEFAULT_MAX_BYTES = 16_000;

const SectionSchema = Type.Object({
	markdownPath: Type.String(),
	section: Type.Optional(Type.String()),
	number: Type.Optional(Type.String()),
	lines: Type.Optional(Type.Number()),
	candidates: Type.Optional(Type.Array(Type.String())),
	text: Type.String(),
});

export function registerPaperSectionTool(pi: ExtensionAPI): void {
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
				maxBytes: Type.Optional(Type.Number({ description: `Cap the returned section (default ${DEFAULT_MAX_BYTES})` })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
			outputSchema: SectionSchema,

			async execute(_id, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
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
				const outline = parseOutline(await readText(markdownPath));

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
				const text = extractSection(outline, heading, {
					includeSubsections: params.includeSubsections ?? true,
					maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES,
				});

				return {
					content: [{ type: "text", text }],
					details: { markdownPath, matched: selected.how, number: heading.number },
					structuredContent: {
						markdownPath,
						section: heading.title,
						...(heading.number ? { number: heading.number } : {}),
						lines: heading.endLine - heading.startLine,
						text,
					},
				};
			},
		}),
	);
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
