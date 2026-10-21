import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { DefaultTreeAdapterMap } from "parse5";
import { parse } from "parse5";
import { Type } from "typebox";
import { parseArxivId } from "../arxiv/api.ts";
import { resolveConfig } from "../cfg.ts";
import type { ExecLike } from "../types.ts";
import { exists, readText } from "../util/fsx.ts";
import { fetchWithRetry } from "../util/http.ts";
import { locateMarkdown } from "./locate.ts";
import { extractSection, parseOutline, selectSection } from "./outline.ts";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
const MAX_PAGES = 5;
const DEFAULT_SECTION_BYTES = 16_000;

export interface ArxivReadParams {
	id: string;
	section?: string;
	pageStart?: number;
	pageEnd?: number;
	format?: "text" | "image";
}

export type ArxivReadResult =
	| { source: "html"; sourceUrl: string; section: string; text: string }
	| { source: "markdown"; sourcePath: string; section: string; text: string }
	| { id: string; source: "pdf-text"; pages: Array<{ page: number; text: string }> }
	| { id: string; source: "pdf-image"; pages: Array<{ page: number; data: string; mimeType: "image/png" }> };

export async function readArxivPaper(
	params: ArxivReadParams,
	input: { papersDir: string; cwd: string; exec: ExecLike; signal?: AbortSignal },
): Promise<ArxivReadResult> {
	const parsed = parseArxivId(params.id);
	if (!parsed) throw new Error(`Not an arXiv id: ${params.id}`);
	const hasPages = params.pageStart !== undefined || params.pageEnd !== undefined;
	if (Boolean(params.section) === hasPages) throw new Error("Specify either section or pageStart/pageEnd, but not both.");
	if (params.section) return await readSection(parsed.id, params.section, input);
	return await readPdfPages(parsed.id, params, input);
}

async function readSection(
	id: string,
	section: string,
	input: { papersDir: string; cwd: string; exec: ExecLike; signal?: AbortSignal },
): Promise<Extract<ArxivReadResult, { source: "html" | "markdown" }>> {
	const htmlUrl = `https://arxiv.org/html/${id}`;
	let htmlSections: HtmlSection[] = [];
	let htmlError: unknown;
	try {
		const response = await fetchWithRetry(htmlUrl, { signal: input.signal, timeoutMs: 30_000 });
		htmlSections = parseHtmlSections(await response.text());
	} catch (error) {
		input.signal?.throwIfAborted();
		htmlError = error;
	}
	if (htmlSections.length > 0) {
		const selected = selectHtmlSection(htmlSections, section);
		if (selected.kind === "ambiguous") throw new Error(`Section "${section}" is ambiguous: ${selected.matches.join("; ")}`);
		if (selected.kind === "missing")
			throw new Error(`No HTML section matches "${section}". Available sections: ${selected.matches.join("; ")}`);
		return { source: "html", sourceUrl: htmlUrl, section: selected.section.title, text: selected.section.text };
	}

	const located = await locateMarkdown({ id, papersDir: input.papersDir, cwd: input.cwd });
	if (!located.markdownPath) {
		const reason = htmlError instanceof Error ? ` HTML read failed: ${htmlError.message}.` : "";
		throw new Error(
			`No arXiv HTML or local Markdown is available for ${id}.${reason} Pull the paper and request PDF pages explicitly with pageStart/pageEnd.`,
		);
	}
	const markdown = await readText(located.markdownPath);
	const outline = parseOutline(markdown);
	const selected = selectSection(outline, section);
	if (selected.kind === "ambiguous")
		throw new Error(`Section "${section}" is ambiguous: ${selected.candidates.map((h) => h.title).join("; ")}`);
	if (selected.kind === "missing")
		throw new Error(`No Markdown section matches "${section}". Call arxiv_read without section for the table of contents.`);
	const text = extractSection(outline, selected.heading, { maxBytes: DEFAULT_SECTION_BYTES });
	return { source: "markdown", sourcePath: located.markdownPath, section: selected.heading.title, text };
}

interface HtmlSection {
	number?: string;
	title: string;
	text: string;
}

function parseHtmlSections(html: string): HtmlSection[] {
	const document = parse(html);
	const sections: HtmlSection[] = [];
	walk(document, (node) => {
		if (!isElement(node) || !hasClass(node, "ltx_section")) return;
		const heading = findHeading(node);
		if (!heading) return;
		const tag = findElementByClass(heading, "ltx_tag");
		const tagText = tag ? nodeText(tag).replace(/\s+/g, " ").trim() : "";
		const titleText = nodeText(heading, false, true, "ltx_tag").replace(/\s+/g, " ").trim();
		const title = `${tagText} ${titleText}`.trim();
		const numberMatch = /^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)*)\s+(.+)$/.exec(title);
		const body = nodeText(node, true)
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		sections.push({
			...(numberMatch?.[1] ? { number: numberMatch[1] } : {}),
			title: numberMatch?.[2] ?? title,
			text: body.length > DEFAULT_SECTION_BYTES ? `${body.slice(0, DEFAULT_SECTION_BYTES)}\n\n[section truncated]` : body,
		});
	});
	return sections;
}

function selectHtmlSection(
	sections: HtmlSection[],
	query: string,
): { kind: "found"; section: HtmlSection } | { kind: "missing"; matches: string[] } | { kind: "ambiguous"; matches: string[] } {
	const normalized = normalize(query);
	const exactNumber = sections.find((section) => section.number === normalized);
	if (exactNumber) return { kind: "found", section: exactNumber };
	const candidates = sections.filter((section) => normalize(`${section.number ?? ""} ${section.title}`).includes(normalized));
	if (candidates.length === 1) return { kind: "found", section: candidates[0] as HtmlSection };
	return candidates.length > 1
		? { kind: "ambiguous", matches: candidates.map((section) => `${section.number ?? ""} ${section.title}`.trim()) }
		: { kind: "missing", matches: sections.slice(0, 40).map((section) => `${section.number ?? ""} ${section.title}`.trim()) };
}

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function findHeading(node: Element): Element | undefined {
	for (const child of node.childNodes) {
		if (!isElement(child)) continue;
		if (/^h[1-6]$/.test(child.tagName) || hasClass(child, "ltx_title_section")) return child;
		const nested = findHeading(child);
		if (nested) return nested;
	}
	return undefined;
}

function findElementByClass(node: Element, className: string): Element | undefined {
	if (hasClass(node, className)) return node;
	for (const child of node.childNodes) {
		if (!isElement(child)) continue;
		const match = findElementByClass(child, className);
		if (match) return match;
	}
	return undefined;
}

function nodeText(node: Node, skipNestedSections = false, root = true, skipClass?: string): string {
	if ("value" in node) return node.value;
	if (!isElement(node) && node.nodeName !== "#document") return "";
	if (isElement(node) && skipClass && hasClass(node, skipClass)) return "";
	if (skipNestedSections && !root && isElement(node) && hasClass(node, "ltx_section")) return "\n";
	if (isElement(node) && ["script", "style", "nav"].includes(node.tagName)) return "";
	const content = (node as ParentNode).childNodes.map((child) => nodeText(child, skipNestedSections, false, skipClass)).join("");
	if (isElement(node) && (node.tagName === "br" || /^(?:p|div|li|h[1-6]|tr|section)$/.test(node.tagName))) return `\n${content}\n`;
	return content;
}

function walk(node: Node, visit: (node: Node) => void): void {
	visit(node);
	if (isElement(node) || node.nodeName === "#document") {
		for (const child of (node as ParentNode).childNodes) walk(child, visit);
	}
}

function isElement(node: Node): node is Element {
	return "tagName" in node;
}

function hasClass(node: Element, className: string): boolean {
	return node.attrs.some((attr) => attr.name === "class" && attr.value.split(/\s+/).includes(className));
}

async function readPdfPages(
	id: string,
	params: ArxivReadParams,
	input: { papersDir: string; cwd: string; exec: ExecLike; signal?: AbortSignal },
): Promise<Extract<ArxivReadResult, { source: "pdf-text" | "pdf-image" }>> {
	const start = params.pageStart;
	const end = params.pageEnd ?? start;
	if (!start || !end || start < 1 || end < start) throw new Error("Provide a valid pageStart and optional pageEnd.");
	if (end - start + 1 > MAX_PAGES) throw new Error(`Read at most ${MAX_PAGES} pages per call.`);
	const pdfPath = join(input.papersDir, id, `${id}.pdf`);
	if (!(await exists(pdfPath))) throw new Error(`PDF not found at ${pdfPath}; run /arxiv pull ${id} first.`);
	input.signal?.throwIfAborted();
	if ((params.format ?? "text") === "image") {
		const pages: Array<{ page: number; data: string; mimeType: "image/png" }> = [];
		for (let page = start; page <= end; page++) {
			input.signal?.throwIfAborted();
			const dir = await mkdtemp(join(tmpdir(), "pi-arxiv-page-"));
			const outputBase = join(dir, `page-${page}`);
			try {
				const result = await input.exec(
					"pdftoppm",
					["-f", String(page), "-l", String(page), "-singlefile", "-png", "-r", "130", pdfPath, outputBase],
					{
						timeout: 60_000,
						signal: input.signal,
					},
				);
				if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || `pdftoppm failed on page ${page}`);
				pages.push({ page, data: (await readFile(`${outputBase}.png`)).toString("base64"), mimeType: "image/png" });
			} finally {
				await rm(dir, { recursive: true, force: true });
			}
		}
		return { id, source: "pdf-image", pages };
	}
	const result = await input.exec("pdftotext", ["-f", String(start), "-l", String(end), "-layout", "-enc", "UTF-8", pdfPath, "-"], {
		timeout: 60_000,
		signal: input.signal,
	});
	if (result.code !== 0 || result.killed) throw new Error(result.stderr.trim() || "pdftotext failed");
	const pages = result.stdout
		.split("\f")
		.filter((text, index, all) => text.trim() || index < all.length - 1)
		.slice(0, end - start + 1);
	return {
		id,
		source: "pdf-text",
		pages: pages.map((text, index) => ({ page: start + index, text: text.trim() })),
	};
}

export function registerArxivReadTool(pi: ExtensionAPI, exec: ExecLike): void {
	pi.registerTool(
		defineTool({
			name: "arxiv_read",
			label: "Read arXiv paper",
			description:
				"Read a paper by section from arXiv HTML (or existing local Markdown), or read local PDF pages as text or rendered images. PDF pages require arxiv_pull first. Text is the default output mode.",
			promptSnippet: "arxiv_read — read a section or selected PDF pages, as text or page images",
			promptGuidelines: [
				"Prefer section reads for conceptual questions. They use arXiv HTML when available and local Markdown otherwise.",
				"Use pageStart/pageEnd for PDF fallback. Select format=image when layout, equations, or figures matter; text is the default.",
			],
			parameters: Type.Object({
				id: Type.String({ description: "arXiv id" }),
				papersDir: Type.Optional(Type.String({ description: "Override the configured local paper-library root" })),
				section: Type.Optional(Type.String({ description: "Section number or title; mutually exclusive with pageStart/pageEnd" })),
				pageStart: Type.Optional(Type.Integer({ minimum: 1, description: "First 1-based PDF page; requires a locally pulled PDF" })),
				pageEnd: Type.Optional(Type.Integer({ minimum: 1, description: `Last PDF page (inclusive), at most ${MAX_PAGES} pages per call` })),
				format: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("image")], { default: "text" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },
			async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
				const config = resolveConfig(pi, ctx.cwd, params.papersDir ? { papersDir: resolve(ctx.cwd, params.papersDir) } : {});
				const result = await readArxivPaper(params, { papersDir: config.papersDir, cwd: ctx.cwd, exec, ...(signal ? { signal } : {}) });
				if ("pages" in result && result.source === "pdf-image") {
					const imagePages = result.pages.filter((page): page is { page: number; data: string; mimeType: "image/png" } => "data" in page);
					return {
						content: imagePages.flatMap((page) => [
							{ type: "text" as const, text: `PDF page ${page.page}` },
							{ type: "image" as const, data: page.data, mimeType: page.mimeType },
						]),
						details: { id: result.id, source: result.source, pages: imagePages.map(({ page }) => page) },
						structuredContent: { id: result.id, source: result.source, pages: imagePages.map(({ page }) => page) },
					};
				}
				const text =
					"pages" in result
						? result.pages.map((page) => `## PDF page ${page.page}\n\n${"text" in page ? page.text : ""}`).join("\n\n")
						: result.text;
				return {
					content: [{ type: "text", text: `${result.source}${"sourceUrl" in result ? ` (${result.sourceUrl})` : ""}\n\n${text}` }],
					details: result,
					structuredContent: result,
				};
			},
		}),
	);
}
