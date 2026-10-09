/**
 * The layer the model actually touches: config resolution, tool definitions and
 * the `/arxiv` command.
 *
 * `pi` is faked, `fetch` is stubbed, and only `pandoc`/`pdftoppm` run for real.
 * That keeps the suite fast while still exercising parameter defaults, output
 * shape (`content` vs `details` vs `structuredContent`) and the conversion path
 * a user actually triggers.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFlags, resolveConfig } from "../extensions/cfg.ts";
import { childProcessExec } from "../extensions/convert/convert.ts";
import { registerTools } from "../extensions/tools.ts";
import { makeTar } from "./helpers/fixtures.ts";

/** A `pi` stand-in that records what the extension registers. */
function fakePi(options: { settings?: unknown; flags?: Record<string, unknown> } = {}) {
	const tools = new Map<string, ToolDefinition>();
	const flags: string[] = [];
	const commands: string[] = [];

	const pi = {
		getSettings: () => options.settings ?? {},
		getFlag: (name: string) => options.flags?.[name],
		registerFlag: (name: string) => flags.push(name),
		registerCommand: (name: string) => commands.push(name),
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		sendUserMessage: vi.fn(),
	};

	return { pi, tools, flags, commands };
}

/** The registration signature, exercised the way `extensions/index.ts` does. */
function loadTools(options: { settings?: unknown; flags?: Record<string, unknown> } = {}) {
	const harness = fakePi(options);
	registerTools(harness.pi as unknown as ExtensionAPI, childProcessExec);
	return harness;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	structuredContent?: unknown;
}

/** Invoke a registered tool with a minimal context. */
async function callTool(tools: Map<string, ToolDefinition>, name: string, params: unknown, cwd: string): Promise<ToolResult> {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool not registered: ${name}`);
	return (await tool.execute("call-1", params as never, undefined, undefined, { cwd } as never)) as ToolResult;
}

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/2609.35319v1</id>
  <title>Outcome-Guided On-Policy Distillation</title>
  <summary>Abstract text.</summary>
  <author><name>Tong Zhang</name></author>
  <category term="cs.LG"/>
  <link title="pdf" href="http://arxiv.org/pdf/2609.35319v1" rel="related"/>
</entry></feed>`;

const SOURCE_ARCHIVE = gzipSync(
	makeTar([
		{
			name: "main.tex",
			content: String.raw`\documentclass{article}
\title{A Tiny Paper}
\author[1]{Ada Lovelace}
\begin{document}
\section{Intro}\label{sec:intro}
Hello, see Equation~\ref{eq:one} and Table~\ref{tab:one}.
\begin{equation}\label{eq:one} a=b \end{equation}
\begin{table}\caption{Small}\label{tab:one}\begin{tabular}{cc} a & b \\ 1 & 2 \end{tabular}\end{table}
\end{document}`,
		},
	]),
);

let root: string;

/** Stub the two URLs the fetch path uses. */
function stubFetch(): string[] {
	const calls: string[] = [];
	const impl: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url.includes("export.arxiv.org")) return new Response(ATOM, { status: 200 });
		if (url.includes("/pdf/")) return new Response(new Uint8Array(Buffer.from("%PDF-1.7")), { status: 200 });
		if (url.includes("/e-print/")) return new Response(new Uint8Array(SOURCE_ARCHIVE), { status: 200 });
		return new Response("not found", { status: 404 });
	};
	vi.stubGlobal("fetch", impl);
	return calls;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-tools-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("configuration precedence", () => {
	const pi = (settings: unknown, flags: Record<string, unknown> = {}) =>
		({ getSettings: () => settings, getFlag: (name: string) => flags[name] }) as unknown as ExtensionAPI;

	it("defaults the papers directory to <cwd>/papers", () => {
		expect(resolveConfig(pi({}), "/work").papersDir).toBe(join("/work", "papers"));
	});

	it("prefers settings over the default", () => {
		expect(resolveConfig(pi({ arxiv: { papersDir: "/from/settings" } }), "/work").papersDir).toBe("/from/settings");
	});

	it("prefers the CLI flag over settings", () => {
		expect(resolveConfig(pi({ arxiv: { papersDir: "/from/settings" } }, { "arxiv-dir": "/from/flag" }), "/work").papersDir).toBe(
			"/from/flag",
		);
	});

	it("prefers an explicit override over everything", () => {
		const config = resolveConfig(pi({ arxiv: { papersDir: "/from/settings" } }, { "arxiv-dir": "/from/flag" }), "/work", {
			papersDir: "/explicit",
		});
		expect(config.papersDir).toBe("/explicit");
	});

	it("lets --arxiv-no-figures win over settings", () => {
		expect(resolveConfig(pi({ arxiv: { figures: true } }, { "arxiv-no-figures": true }), "/work").figures).toBe(false);
	});

	it("accepts only the two documented table modes", () => {
		expect(resolveConfig(pi({ arxiv: { tableMode: "html" } }), "/work").tableMode).toBe("html");
		expect(resolveConfig(pi({ arxiv: { tableMode: "nonsense" } }), "/work").tableMode).toBe("gfm");
	});

	it("survives settings that are absent or malformed", () => {
		expect(resolveConfig(pi(undefined), "/work").figureDpi).toBe(150);
		expect(resolveConfig(pi({ arxiv: "not an object" }), "/work").figureDpi).toBe(150);
	});
});

describe("tool registration", () => {
	it("registers the six tools", () => {
		const { tools } = loadTools();
		expect([...tools.keys()].sort()).toEqual([
			"arxiv_lookup",
			"arxiv_pull",
			"paper_markdown",
			"paper_section",
			"paper_toolchain",
			"papers_index",
		]);
	});

	it.each(["arxiv_lookup", "arxiv_pull", "paper_markdown", "paper_section", "paper_toolchain", "papers_index"])(
		"%s is model-usable",
		(name) => {
			const definition = loadTools().tools.get(name);
			expect(definition?.description.length).toBeGreaterThan(40);
			expect(definition?.parameters).toBeDefined();
			expect(definition?.annotations).toBeDefined();
		},
	);
});

describe("flag registration", () => {
	it("registers the three CLI flags", () => {
		const harness = fakePi();
		registerFlags(harness.pi as unknown as ExtensionAPI);
		expect(harness.flags.sort()).toEqual(["arxiv-dir", "arxiv-no-figures", "arxiv-table-mode"]);
	});
});

describe("arxiv_lookup tool", () => {
	it("returns paper metadata", async () => {
		stubFetch();
		const { tools } = loadTools();

		const result = await callTool(tools, "arxiv_lookup", { query: "2609.35319" }, root);

		expect(result.content[0]?.text).toContain("Outcome-Guided On-Policy Distillation");
		expect(result.content[0]?.text).toContain("Tong Zhang");
		expect(result.structuredContent).toMatchObject({ matched: [{ id: "2609.35319" }] });
	});

	it("reports a miss instead of throwing", async () => {
		vi.stubGlobal("fetch", (async () => new Response(`<feed></feed>`, { status: 200 })) as unknown as typeof fetch);
		const { tools } = loadTools();

		const result = await callTool(tools, "arxiv_lookup", { query: "nothing at all here" }, root);

		expect(result.content[0]?.text).toContain("No arXiv match");
	});
});

describe("papers_index tool", () => {
	it("reports an empty corpus without failing", async () => {
		const result = await callTool(loadTools().tools, "papers_index", {}, root);

		expect(result.structuredContent).toMatchObject({ total: 0, broken: 0, incomplete: 0 });
		expect(result.content[0]?.text).toContain("all healthy");
	});

	it("classifies a complete and an incomplete paper", async () => {
		const papersDir = join(root, "papers");
		await mkdir(join(papersDir, "2609.00001", "source"), { recursive: true });
		await writeFile(join(papersDir, "2609.00001", "2609.00001.pdf"), "%PDF");
		await writeFile(join(papersDir, "2609.00001", "source", "main.tex"), "\\documentclass{article}");
		await writeFile(join(papersDir, "2609.00001", "source", "2609.00001.md"), "# md");
		await writeFile(join(papersDir, "2609.00001", "manifest.json"), JSON.stringify({ title: "Complete", version: "v1" }));
		await mkdir(join(papersDir, "2609.00002"), { recursive: true });
		await writeFile(join(papersDir, "2609.00002", "2609.00002.pdf"), "%PDF");

		const { tools } = loadTools({ settings: { arxiv: { papersDir } } });
		const result = await callTool(tools, "papers_index", {}, root);
		const structured = result.structuredContent as { total: number; broken: number; entries: Array<{ id: string; status: string }> };

		expect(structured.total).toBe(2);
		expect(structured.broken).toBe(1);
		expect(structured.entries.find((entry) => entry.id === "2609.00001")?.status).toBe("ok");
		expect(structured.entries.find((entry) => entry.id === "2609.00002")?.status).toBe("error");
	});
});

describe("paper_toolchain tool", () => {
	it("reports each external tool's availability", async () => {
		const result = await callTool(loadTools().tools, "paper_toolchain", {}, root);

		expect(result.content[0]?.text).toContain("pandoc");
		expect(result.content[0]?.text).toContain("pdftoppm");
	});
});

describe("paper_markdown tool", () => {
	it("converts a local LaTeX directory and reports the repairs", async () => {
		const sourceDir = join(root, "paper");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(
			join(sourceDir, "main.tex"),
			String.raw`\documentclass{article}\title{T}\begin{document}
\section{S}\label{sec:s}
See Table~\ref{tab:x}.
\begin{table}\caption{Cap}\label{tab:x}\begin{tabular}{cc} a & b \\ 1 & 2 \end{tabular}\end{table}
\end{document}`,
		);

		const result = await callTool(loadTools().tools, "paper_markdown", { sourceDir, figures: false }, root);

		expect(result.structuredContent).toMatchObject({ ok: true });
		const markdownPath = (result.structuredContent as { markdownPath: string }).markdownPath;
		expect(existsSync(markdownPath)).toBe(true);
	});

	it("fails cleanly for a directory with no LaTeX", async () => {
		const empty = join(root, "empty");
		await mkdir(empty, { recursive: true });

		const result = await callTool(loadTools().tools, "paper_markdown", { sourceDir: empty }, root);

		expect(result.structuredContent).toMatchObject({ ok: false });
		expect(result.content[0]?.text).toContain("conversion failed");
	});
});

describe("arxiv_pull tool", () => {
	it("downloads, converts and points at the Markdown", async () => {
		stubFetch();
		const { tools } = loadTools();

		const result = await callTool(tools, "arxiv_pull", { query: "2609.35319" }, root);

		const structured = result.structuredContent as { markdownPath?: string; pdfPath?: string; manifestPath: string; dir: string };
		expect(result.content[0]?.text).toContain("Outcome-Guided On-Policy Distillation");
		expect(structured.pdfPath && existsSync(structured.pdfPath)).toBe(true);
		expect(structured.markdownPath && existsSync(structured.markdownPath)).toBe(true);
		expect(existsSync(structured.manifestPath)).toBe(true);
	});

	it("honours an explicit destination directory", async () => {
		stubFetch();
		const { tools } = loadTools();

		const result = await callTool(tools, "arxiv_pull", { query: "2609.35319", destDir: "./custom" }, root);

		expect((result.structuredContent as { dir: string }).dir).toBe(join(root, "custom"));
	});

	it("can skip conversion", async () => {
		stubFetch();
		const { tools } = loadTools();

		const result = await callTool(tools, "arxiv_pull", { query: "2609.35319", convert: false }, root);

		expect(result.structuredContent).not.toHaveProperty("markdownPath");
		expect((result.structuredContent as { sourceDir?: string }).sourceDir).toBeDefined();
	});

	it("reports a download failure as an error result rather than crashing", async () => {
		vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
		const { tools } = loadTools();

		await expect(callTool(tools, "arxiv_pull", { query: "2609.35319" }, root)).rejects.toThrow(/500/);
	});
});
