/**
 * Cache behaviour as the model and the user see it: through the tools, not the
 * driver. A cache that works but is invisible would still surprise people.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childProcessExec } from "../extensions/convert/convert.ts";
import { registerTools } from "../extensions/tools.ts";
import { makeTar } from "./helpers/fixtures.ts";

const LATEX = "\\documentclass{article}\\title{T}\\begin{document}\\section{S}Body.\\end{document}";

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/2609.35319v1</id>
  <title>A Paper</title>
  <summary>Abstract.</summary>
  <author><name>A. Author</name></author>
  <category term="cs.LG"/>
</entry></feed>`;

const ARCHIVE = gzipSync(makeTar([{ name: "main.tex", content: LATEX }]));

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	structuredContent?: Record<string, unknown>;
}

function load() {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		getSettings: () => ({}),
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendUserMessage: vi.fn(),
		exec: childProcessExec,
	};
	registerTools(pi as unknown as ExtensionAPI, childProcessExec);
	return tools;
}

async function call(tools: Map<string, ToolDefinition>, name: string, params: unknown, cwd: string): Promise<ToolResult> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`${name} is not registered`);
	return (await tool.execute("call-1", params as never, undefined, undefined, { cwd } as never)) as unknown as ToolResult;
}

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-cache-tool-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

async function makePaper(): Promise<string> {
	const dir = join(root, "paper");
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "main.tex"), LATEX);
	return dir;
}

describe("paper_markdown", () => {
	it("says when it reused a conversion instead of converting again", async () => {
		const sourceDir = await makePaper();
		const tools = load();

		const first = await call(tools, "paper_markdown", { sourceDir, figures: false }, root);
		expect(first.content[0]?.text).not.toContain("cached:");

		const second = await call(tools, "paper_markdown", { sourceDir, figures: false }, root);
		expect(second.content[0]?.text).toContain("cached:");
		expect(second.content[0]?.text).toContain("force=true");
	});

	it("converts again when forced", async () => {
		const sourceDir = await makePaper();
		const tools = load();

		await call(tools, "paper_markdown", { sourceDir, figures: false }, root);
		const forced = await call(tools, "paper_markdown", { sourceDir, figures: false, force: true }, root);

		expect(forced.content[0]?.text).not.toContain("cached:");
	});

	it("writes a cache file the caller can delete to force a rebuild", async () => {
		const sourceDir = await makePaper();
		await call(load(), "paper_markdown", { sourceDir, figures: false }, root);

		const markdownPath = join(sourceDir, "paper.md");
		expect(existsSync(`${markdownPath}.cache.json`)).toBe(true);
	});
});

describe("arxiv_pull", () => {
	function stubFetch(): void {
		const impl: typeof fetch = async (input) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url.includes("export.arxiv.org")) return new Response(ATOM, { status: 200 });
			if (url.includes("/pdf/")) return new Response(new Uint8Array(Buffer.from("%PDF-1.7")), { status: 200 });
			if (url.includes("/e-print/")) return new Response(new Uint8Array(ARCHIVE), { status: 200 });
			return new Response("not found", { status: 404 });
		};
		vi.stubGlobal("fetch", impl);
	}

	it("reuses the conversion on a second pull", async () => {
		stubFetch();
		const tools = load();

		const first = await call(tools, "arxiv_pull", { query: "2609.35319" }, root);
		const markdownPath = (first.structuredContent as { markdownPath: string }).markdownPath;
		expect(existsSync(markdownPath)).toBe(true);

		const second = await call(tools, "arxiv_pull", { query: "2609.35319" }, root);

		// The pull itself reuses the downloads, and the conversion is reused too.
		expect((second.structuredContent as { markdownPath: string }).markdownPath).toBe(markdownPath);
		expect(second.content[0]?.text).toContain("reused");
	});

	it("does not reuse a conversion after a forced re-download", async () => {
		stubFetch();
		const tools = load();

		await call(tools, "arxiv_pull", { query: "2609.35319" }, root);
		const forced = await call(tools, "arxiv_pull", { query: "2609.35319", force: true }, root);

		// A forced pull rewrites the source, so reusing the old Markdown would be
		// wrong even if the bytes happen to match.
		expect(forced.content[0]?.text).not.toContain("cached:");
	});
});
