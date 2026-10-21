/**
 * `paper_section` and the Markdown locator, through a faked `pi`.
 *
 * The locator's job is guessing where a converted paper lives, so the tests
 * cover the layouts that actually occur: the converter's own
 * `<id>/source/<id>.md`, a hand-picked directory, an explicit file, and a miss.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateMarkdown } from "../extensions/paper/locate.ts";
import { registerPaperSectionTool } from "../extensions/paper/tool.ts";
import type { ExecLike } from "../extensions/types.ts";

const PAPER = `---
title: "Test Paper"
---

# Test Paper

## Abstract

An abstract.

# 1 Introduction

Introduced.

# 2 Method

## 2.1 Empirical Analysis

Paired continuations.

## 2.2 Weighting

Trajectory-relative weights.

# Appendix A. Proofs

## A.1 A lemma

Statement.
`;

/** The text payload every branch of `paper_section` returns. */
interface SectionPayload {
	markdownPath: string;
	section?: string | undefined;
	number?: string | undefined;
	lines?: number | undefined;
	lineStart?: number | undefined;
	lineEnd?: number | undefined;
	evidenceId?: string | undefined;
	contentHash?: string | undefined;
	pdfPages?: { start: number; end: number; confidence: string } | undefined;
	candidates?: string[] | undefined;
	text: string;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	structuredContent?: SectionPayload;
}

function load(settings: unknown = {}, exec?: ExecLike) {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		getSettings: () => settings,
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	};
	registerPaperSectionTool(pi as unknown as ExtensionAPI, exec);
	return tools;
}

async function call(tools: Map<string, ToolDefinition>, params: unknown, cwd: string): Promise<ToolResult> {
	const tool = tools.get("paper_section");
	if (!tool) throw new Error("paper_section is not registered");
	return (await tool.execute("call-1", params as never, undefined, undefined, { cwd } as never)) as unknown as ToolResult;
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-section-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("locateMarkdown", () => {
	it("finds a paper by id in the converter's layout", async () => {
		const source = join(root, "papers", "2609.35319", "source");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "2609.35319.md"), PAPER);

		const found = await locateMarkdown({ id: "2609.35319", papersDir: join(root, "papers"), cwd: root });

		expect(found.markdownPath).toBe(join(source, "2609.35319.md"));
	});

	it("prefers the Markdown named after the paper", async () => {
		const source = join(root, "papers", "2609.35319", "source");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "notes.md"), "other");
		await writeFile(join(source, "2609.35319.md"), PAPER);

		const found = await locateMarkdown({ id: "2609.35319", papersDir: join(root, "papers"), cwd: root });

		expect(found.markdownPath).toBe(join(source, "2609.35319.md"));
	});

	it("prefers the paper-root generated Markdown over a legacy source copy", async () => {
		const paperDir = join(root, "papers", "2609.35319");
		const source = join(paperDir, "source");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "2609.35319.md"), "legacy");
		await writeFile(join(paperDir, "2609.35319.md"), PAPER);

		const found = await locateMarkdown({ id: "2609.35319", papersDir: join(root, "papers"), cwd: root });
		expect(found.markdownPath).toBe(join(paperDir, "2609.35319.md"));
	});

	it("accepts an explicit file", async () => {
		const file = join(root, "converted.md");
		await writeFile(file, PAPER);

		expect((await locateMarkdown({ source: file, papersDir: join(root, "papers"), cwd: root })).markdownPath).toBe(file);
	});

	it("accepts a directory and picks the Markdown inside it", async () => {
		const dir = join(root, "somewhere");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "paper.md"), PAPER);

		expect((await locateMarkdown({ source: dir, papersDir: join(root, "papers"), cwd: root })).markdownPath).toBe(join(dir, "paper.md"));
	});

	it("resolves a relative path against cwd", async () => {
		await mkdir(join(root, "rel"), { recursive: true });
		await writeFile(join(root, "rel", "p.md"), PAPER);

		expect((await locateMarkdown({ source: "./rel/p.md", papersDir: join(root, "papers"), cwd: root })).markdownPath).toBe(
			join(root, "rel", "p.md"),
		);
	});

	it("reports where it looked when nothing matches", async () => {
		const found = await locateMarkdown({ id: "9999.99999", papersDir: join(root, "papers"), cwd: root });

		expect(found.markdownPath).toBeUndefined();
		expect(found.searched.length).toBeGreaterThan(0);
	});

	it("returns nothing when given no input at all", async () => {
		expect((await locateMarkdown({ papersDir: join(root, "papers"), cwd: root })).markdownPath).toBeUndefined();
	});
});

describe("paper_section", () => {
	/** Write the sample paper into the converter's layout and return its dir. */
	async function withPaper(): Promise<string> {
		const source = join(root, "papers", "2609.35319", "source");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "2609.35319.md"), PAPER);
		return join(root, "papers");
	}

	it("lists the table of contents when no section is given", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319" }, root);

		expect(result.content[0]?.text).toContain("2.1 Empirical Analysis");
		expect(result.structuredContent?.text).toContain("2 Method");
	});

	it("returns one numbered section", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "2.2" }, root);

		expect(result.structuredContent?.number).toBe("2.2");
		expect(result.content[0]?.text).toContain("Trajectory-relative weights.");
		expect(result.content[0]?.text).not.toContain("Paired continuations.");
	});

	it("returns a stable evidence id and Markdown line range", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "2.2" }, root);

		expect(result.structuredContent).toMatchObject({
			lineStart: 21,
			lineEnd: 24,
			lines: 4,
			contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			evidenceId: expect.stringMatching(/^2609\.35319:L21-24:/),
		});
		expect(result.content[0]?.text).toContain("2609.35319:L21-24:");
	});

	it("returns a parent section with its subsections", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "2 Method" }, root);

		expect(result.content[0]?.text).toContain("2.1 Empirical Analysis");
		expect(result.content[0]?.text).toContain("2.2 Weighting");
	});

	it("can exclude subsections", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "2 Method", includeSubsections: false }, root);

		expect(result.content[0]?.text).toContain("2 Method");
		expect(result.content[0]?.text).not.toContain("2.1 Empirical Analysis");
	});

	it("finds an appendix section", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "A.1" }, root);

		expect(result.structuredContent?.number).toBe("A.1");
		expect(result.content[0]?.text).toContain("Statement.");
	});

	it("returns approximate PDF page references when matching text is available", async () => {
		const papersDir = await withPaper();
		const markdownPath = join(papersDir, "2609.35319", "source", "2609.35319.md");
		const sectionBody =
			"Retrieval augmented generation uses sparse embeddings and factual evidence. Reranking improves answer grounding across documents.";
		await writeFile(markdownPath, PAPER.replace("Trajectory-relative weights.", sectionBody));
		await writeFile(join(papersDir, "2609.35319", "2609.35319.pdf"), "%PDF");
		const exec: ExecLike = async () => ({
			stdout: `Introduction discusses prior work.\f${sectionBody}\fConclusion discusses future work.`,
			stderr: "",
			code: 0,
		});
		const result = await call(load({ arxiv: { papersDir } }, exec), { id: "2609.35319", section: "2.2" }, root);

		expect(result.structuredContent?.pdfPages).toEqual({ start: 2, end: 2, confidence: "approximate" });
		expect(result.content[0]?.text).toContain("approx. PDF pages 2-2");
	});

	it("suggests headings when the name is wrong", async () => {
		const papersDir = await withPaper();
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "empirical nonsense" }, root);

		expect(result.content[0]?.text).toContain("No section matches");
		expect(result.structuredContent?.candidates?.[0]).toContain("Empirical");
	});

	it("honours maxBytes", async () => {
		const papersDir = await withPaper();
		const markdownPath = join(papersDir, "2609.35319", "source", "2609.35319.md");
		await writeFile(markdownPath, PAPER.replace("Trajectory-relative weights.", "Long section content. ".repeat(40)));
		const result = await call(load({ arxiv: { papersDir } }), { id: "2609.35319", section: "2 Method", maxBytes: 128 }, root);

		expect(result.content[0]?.text).toContain("Truncated at 128 bytes");
		expect(Buffer.byteLength(result.structuredContent?.text ?? "", "utf8")).toBeLessThanOrEqual(128);
	});

	it("reads an explicit source path, ignoring papersDir", async () => {
		const file = join(root, "elsewhere.md");
		await writeFile(file, PAPER);
		const result = await call(load({ arxiv: { papersDir: join(root, "does-not-exist") } }), { source: file, section: "1" }, root);

		expect(result.structuredContent?.markdownPath).toBe(file);
		expect(result.content[0]?.text).toContain("Introduced.");
	});

	it("explains what to do when no Markdown is found", async () => {
		const result = await call(load({ arxiv: { papersDir: join(root, "empty") } }), { id: "9999.99999" }, root);

		expect(result.content[0]?.text).toContain("No converted Markdown found");
		expect(result.content[0]?.text).toContain("arxiv_markdown");
	});

	it("reads a real converted paper end to end", async () => {
		// Round-trip through the converter rather than a hand-written fixture, so
		// the section numbers are the ones the converter actually emits.
		const workDir = join(root, "converted");
		await mkdir(workDir, { recursive: true });
		await writeFile(
			join(workDir, "main.tex"),
			"\\documentclass{article}\\begin{document}\\section{Alpha}\\label{sec:a}One.\\section{Beta}Two.\\end{document}",
		);
		const { childProcessExec, convertSourceDir } = await import("../extensions/convert/convert.ts");
		const converted = await convertSourceDir(
			{ workDir, outFile: join(workDir, "converted.md"), figures: false },
			{ exec: childProcessExec },
		);
		expect(converted.ok, converted.warnings[0]?.message).toBe(true);

		const result = await call(load({ arxiv: { papersDir: workDir } }), { source: converted.markdownPath as string, section: "1" }, root);

		expect(result.structuredContent?.number).toBe("1");
		expect(result.content[0]?.text).toContain("One.");
		expect(await readFile(converted.markdownPath as string, "utf8")).toContain("Alpha");
	});
});
