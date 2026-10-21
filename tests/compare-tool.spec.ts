/**
 * `arxiv_diff` through a faked `pi`: two versions materialised from stubbed
 * downloads, then compared.
 *
 * The point of this suite is the plumbing — which version lands where, that the
 * current version is not downloaded twice, and that a missing version produces an
 * error rather than a misleading diff.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerArxivDiffTool } from "../extensions/compare/tool.ts";
import { makeTar } from "./helpers/fixtures.ts";

/** v2 differs in one number and one file, which is the case worth detecting. */
const MAIN_V1 = String.raw`\documentclass{article}
\title{A Paper}
\begin{document}
\section{Results}
\begin{table}
\caption{Main results}
\begin{tabular}{lcc}
Method & Success & Rounds \\
Baseline & 20.1 & 17.7 \\
Ours & 45.7 & 5.6 \\
\end{tabular}
\end{table}
\end{document}`;

const MAIN_V2 = MAIN_V1.replace("45.7", "46.1");
const EXTRA_V2 = "\\section{Extra}\nNew appendix.\n";

const META_V1 = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/2609.35319v1</id>
  <title>A Paper</title>
  <summary>Abstract.</summary>
  <author><name>A. Author</name></author>
  <category term="cs.LG"/>
</entry></feed>`;

/** The structured payload `arxiv_diff` returns. */
interface DiffPayload {
	id: string;
	from: string;
	to: string;
	summary: string;
	filesAdded: string[];
	filesRemoved: string[];
	filesChanged: string[];
	tables: Array<{ table: number; caption?: string; changes: string[] }>;
	hasMarkdownDiff: boolean;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details?: unknown;
	structuredContent?: DiffPayload;
	isError?: boolean;
}

function load(): Map<string, ToolDefinition> {
	const tools = new Map<string, ToolDefinition>();
	const pi = {
		getSettings: () => ({}),
		getFlag: () => undefined,
		registerFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
	};
	registerArxivDiffTool(pi as unknown as ExtensionAPI);
	return tools;
}

/** Invoke the tool the way pi does, with `cwd` as the only context it needs. */
async function diff(tools: Map<string, ToolDefinition>, params: unknown, cwd: string): Promise<ToolResult> {
	const tool = tools.get("arxiv_diff");
	if (!tool) throw new Error("arxiv_diff is not registered");
	return (await tool.execute("call-1", params as never, undefined, undefined, { cwd } as never)) as unknown as ToolResult;
}

/** Serve the Atom entry plus whatever e-prints the test asks for. */
function stubFetch(archives: Record<string, string>): string[] {
	const calls: string[] = [];
	const impl: typeof fetch = async (input) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url.includes("export.arxiv.org")) return new Response(META_V1, { status: 200 });

		const version = /v\d+$/.exec(new URL(url).pathname)?.[0] ?? "";
		const body = archives[version];
		if (body === undefined) return new Response("not found", { status: 404, statusText: "Not Found" });
		return new Response(new Uint8Array(gzipSync(makeTar([{ name: "main.tex", content: body }]))), { status: 200 });
	};
	vi.stubGlobal("fetch", impl);
	return calls;
}

let root: string;
let papersDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-diff-"));
	papersDir = join(root, "papers");
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("arxiv_diff", () => {
	it("reports the moved number in the table", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v2" }, root);

		expect(result.structuredContent?.summary).toContain("table(s) differ");
		const tables = result.structuredContent?.tables as Array<{ table: number; changes: string[] }>;
		expect(tables[0]?.changes).toEqual(["r3c2: 45.7 → 46.1"]);
	});

	it("does not list its own generated Markdown as a revision change", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v2" }, root);

		// The diff Markdown is written beside source/, not inside it; if it were
		// inside, this list would contain the file the tool just created.
		expect(result.structuredContent?.filesChanged).toEqual(["main.tex"]);
	});

	it("lists a genuinely changed file", async () => {
		stubFetch({ v1: MAIN_V1, v2: `${MAIN_V2}\n${EXTRA_V2}` });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v2" }, root);
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("## Files");
		expect(text).toContain("~ main.tex");
	});

	it("includes a Markdown diff only when both versions already have generated Markdown", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const paperDir = join(papersDir, "2609.35319");
		for (const [version, number] of [
			["v1", "45.7"],
			["v2", "46.1"],
		] as const) {
			const versionDir = join(paperDir, "versions", version);
			await mkdir(versionDir, { recursive: true });
			await writeFile(join(versionDir, "2609.35319.md"), `# Results\n\nOurs: ${number}\n`);
		}
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v2" }, root);
		const text = result.content[0]?.text ?? "";

		expect(text).toContain("## Table changes");
		expect(text).toContain("## LaTeX diff");
		expect(text).toContain("## Converted Markdown diff");
		expect(text).toContain("-Ours: 45.7");
		expect(text).toContain("+Ours: 46.1");
		expect(result.structuredContent?.hasMarkdownDiff).toBe(true);
	});

	it("stores each version under versions/<v> and leaves the corpus root alone", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const tools = load();

		await diff(tools, { id: "2609.35319", from: "v1", to: "v2" }, root);

		expect(existsSync(join(papersDir, "2609.35319", "versions", "v1", "source", "main.tex"))).toBe(true);
		expect(existsSync(join(papersDir, "2609.35319", "versions", "v2", "source", "main.tex"))).toBe(true);
		// Diff no longer starts an implicit Markdown conversion.
		expect(existsSync(join(papersDir, "2609.35319", "versions", "v1", "2609.35319.md"))).toBe(false);
	});

	it("does not mistake an older primary manifest for the current version", async () => {
		stubFetch({ v0: MAIN_V1.replace("45.7", "40.0"), v1: MAIN_V1 });
		const paperDir = join(papersDir, "2609.35319");
		const sourceDir = join(paperDir, "source");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "main.tex"), MAIN_V1.replace("45.7", "39.0"));
		await writeFile(join(paperDir, "manifest.json"), JSON.stringify({ version: "v0" }));
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v0", to: "latest" }, root);

		expect(result.isError).not.toBe(true);
		expect(await readFile(join(papersDir, "2609.35319", "versions", "v1", "source", "main.tex"), "utf8")).toBe(MAIN_V1);
		expect(result.structuredContent?.tables[0]?.changes).toEqual(["r3c2: 40.0 → 45.7"]);
	});

	it("accepts a version without the leading v", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "1", to: "2" }, root);

		expect(result.structuredContent?.from).toBe("v1");
		expect(result.structuredContent?.to).toBe("v2");
	});

	it("refuses to compare a version with itself", async () => {
		stubFetch({ v1: MAIN_V1, v2: MAIN_V2 });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "V1" }, root);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("nothing to compare");
	});

	it("rejects a title, because a diff needs one specific paper", async () => {
		const tools = load();
		const result = await diff(tools, { id: "some paper title", from: "v1", to: "v2" }, root);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("not an arXiv id");
	});

	it("explains which version was unavailable instead of diffing nothing", async () => {
		stubFetch({ v1: MAIN_V1 });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v5" }, root);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Could not obtain both versions");
	});

	it("caps the text diff and says how much it dropped", async () => {
		const long = Array.from({ length: 120 }, (_value, index) => `% filler ${index}\n`).join("");
		stubFetch({ v1: `${MAIN_V1}${long}`, v2: `${MAIN_V2}${long.split("\n").reverse().join("\n")}` });
		const tools = load();

		const result = await diff(tools, { id: "2609.35319", from: "v1", to: "v2", maxDiffLines: 20 }, root);

		expect(result.content[0]?.text).toContain("more diff line(s) omitted");
	});

	it("asks for metadata before anything else", async () => {
		// A diff needs the current version, so one metadata lookup is expected; what
		// must not happen is a download when both sides resolve locally.
		const calls = stubFetch({ v1: MAIN_V1 });
		const tools = load();

		await diff(tools, { id: "2609.35319", from: "v1", to: "v1" }, root);

		expect(calls.some((url) => url.includes("export.arxiv.org"))).toBe(true);
		expect(calls.some((url) => url.includes("/e-print/"))).toBe(false);
	});
});
