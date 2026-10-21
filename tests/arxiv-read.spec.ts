import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readArxivPaper, registerArxivReadTool } from "../extensions/paper/read.ts";
import type { ExecLike } from "../extensions/types.ts";

let root: string;
const PAPER_ID = "2609.35319";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-read-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

async function makePdf(): Promise<string> {
	const paperDir = join(root, "papers", PAPER_ID);
	await mkdir(paperDir, { recursive: true });
	const pdf = join(paperDir, `${PAPER_ID}.pdf`);
	await writeFile(pdf, "%PDF-fixture");
	return pdf;
}

const noExec: ExecLike = async () => ({ stdout: "", stderr: "", code: 0 });

function loadReadTool(exec: ExecLike): ToolDefinition {
	let registered: ToolDefinition | undefined;
	const pi = {
		getSettings: () => ({}),
		getFlag: () => undefined,
		registerTool: (tool: ToolDefinition) => (registered = tool),
	};
	registerArxivReadTool(pi as unknown as ExtensionAPI, exec);
	if (!registered) throw new Error("arxiv_read was not registered");
	return registered;
}

describe("arxiv_read", () => {
	it("reads a requested HTML section and normalizes its body", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(
					'<html><section class="ltx_section" id="S1"><h2 class="ltx_title_section"><span class="ltx_tag">1</span>Introduction</h2><p>First paragraph.</p><section class="ltx_section"><h3 class="ltx_title_section">1.1 Details</h3><p>Nested text.</p></section></section></html>',
					{ status: 200 },
				),
		);
		const result = await readArxivPaper({ id: PAPER_ID, section: "1" }, { papersDir: join(root, "papers"), cwd: root, exec: noExec });
		expect(result.source).toBe("html");
		if (result.source !== "html") throw new Error("expected HTML section result");
		expect(result.text).toContain("First paragraph.");
		expect(result.text).not.toContain("Nested text.");
	});

	it("reads PDF pages as text by default", async () => {
		await makePdf();
		const exec: ExecLike = async (_command, args) => {
			expect(args).toContain("-f");
			return {
				stdout: args[args.indexOf("-f") + 1] === "2" ? "Page two text.\f" : "Page one text.\fPage two text.\f",
				stderr: "",
				code: 0,
			};
		};
		const result = await readArxivPaper({ id: PAPER_ID, pageStart: 2 }, { papersDir: join(root, "papers"), cwd: root, exec });
		expect(result.source).toBe("pdf-text");
		if (result.source !== "pdf-text") throw new Error("expected text page result");
		expect(result.pages).toEqual([{ page: 2, text: "Page two text." }]);
	});

	it("renders requested PDF pages as image blocks", async () => {
		await makePdf();
		const exec: ExecLike = async (command, args) => {
			expect(command).toBe("pdftoppm");
			await writeFile(`${args.at(-1)}.png`, Buffer.from("png"));
			return { stdout: "", stderr: "", code: 0 };
		};
		const result = await readArxivPaper(
			{ id: PAPER_ID, pageStart: 1, pageEnd: 2, format: "image" },
			{ papersDir: join(root, "papers"), cwd: root, exec },
		);
		expect(result.source).toBe("pdf-image");
		if (result.source !== "pdf-image") throw new Error("expected image result");
		expect(result.pages.map((page) => page.page)).toEqual([1, 2]);
		expect(result.pages[0]?.data).toBe(Buffer.from("png").toString("base64"));
	});

	it("requires a local PDF for page reading and caps ranges", async () => {
		await expect(
			readArxivPaper({ id: PAPER_ID, pageStart: 1 }, { papersDir: join(root, "papers"), cwd: root, exec: noExec }),
		).rejects.toThrow(/run \/arxiv pull/);
		await makePdf();
		await expect(
			readArxivPaper({ id: PAPER_ID, pageStart: 1, pageEnd: 6 }, { papersDir: join(root, "papers"), cwd: root, exec: noExec }),
		).rejects.toThrow(/at most 5 pages/);
	});

	it("exposes text as the default format in the agent tool", async () => {
		await makePdf();
		let invoked: unknown;
		const tool = loadReadTool(async (_command, _args) => {
			invoked = _command;
			return { stdout: "Text", stderr: "", code: 0 };
		});
		await tool.execute("call", { id: PAPER_ID, pageStart: 1 }, undefined, undefined, { cwd: root } as never);
		expect(invoked).toBe("pdftotext");
	});
});
