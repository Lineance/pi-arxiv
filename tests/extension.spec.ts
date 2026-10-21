import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childProcessExec } from "../extensions/convert/convert.ts";
import piArxiv from "../extensions/index.ts";
import { makeTar } from "./helpers/fixtures.ts";

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <id>http://arxiv.org/abs/2609.35319v1</id>
  <title>Outcome-Guided On-Policy Distillation</title>
  <summary>Abstract text.</summary>
  <author><name>Tong Zhang</name></author>
  <category term="cs.LG"/>
</entry></feed>`;
const SOURCE_ARCHIVE = gzipSync(makeTar([{ name: "main.tex", content: "\\documentclass{article}\\begin{document}Text\\end{document}" }]));

interface CommandHarness {
	handler: (input: string, ctx: unknown) => Promise<void>;
	notify: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
}

function loadExtension(): CommandHarness {
	let handler: ((input: string, ctx: unknown) => Promise<void>) | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn();
	const pi = {
		getSettings: () => ({}),
		getFlag: () => undefined,
		registerFlag: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
		sendUserMessage,
		exec: childProcessExec,
		registerCommand: (name: string, definition: { handler: (input: string, ctx: unknown) => Promise<void> }) => {
			if (name === "arxiv") handler = definition.handler;
		},
	};
	piArxiv(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("/arxiv command was not registered");
	return { handler, notify, sendUserMessage };
}

let root: string;

function stubFetch(): string[] {
	const calls: string[] = [];
	vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push(url);
		if (url.includes("export.arxiv.org")) return new Response(ATOM, { status: 200 });
		if (url.includes("/pdf/")) return new Response(new Uint8Array(Buffer.from("%PDF-1.7")), { status: 200 });
		if (url.includes("/e-print/")) return new Response(new Uint8Array(SOURCE_ARCHIVE), { status: 200 });
		return new Response("not found", { status: 404 });
	}) as unknown as typeof fetch);
	return calls;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-ext-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("/arxiv commands", () => {
	it("lists the explicit subcommands", async () => {
		const harness = loadExtension();
		await harness.handler("help", { cwd: root, ui: { notify: harness.notify } });
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("search <query>"), "info");
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("markdown <id>"), "info");
	});

	it("searches and displays candidates without downloading", async () => {
		stubFetch();
		const harness = loadExtension();
		await harness.handler("search on-policy distillation", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(String(harness.notify.mock.calls.at(-1)?.[0])).toContain("2609.35319");
		expect(existsSync(join(root, "papers"))).toBe(false);
	});

	it("pulls source and PDF without implicitly converting", async () => {
		const calls = stubFetch();
		const harness = loadExtension();
		await harness.handler("pull 2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(calls.some((url) => url.includes("/pdf/"))).toBe(true);
		expect(existsSync(join(root, "papers", "2609.35319", "2609.35319.pdf"))).toBe(true);
		expect(existsSync(join(root, "papers", "2609.35319", "source", "2609.35319.md"))).toBe(false);
		expect(String(harness.notify.mock.calls.at(-1)?.[0])).toContain("Markdown conversion is separate");
	});

	it("keeps the old bare-id syntax as a pull alias", async () => {
		stubFetch();
		const harness = loadExtension();
		await harness.handler("2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(existsSync(join(root, "papers", "2609.35319", "2609.35319.pdf"))).toBe(true);
		expect(existsSync(join(root, "papers", "2609.35319", "2609.35319.md"))).toBe(false);
	});

	it("hands a section read to the agent tool", async () => {
		const harness = loadExtension();
		await harness.handler("read 2609.35319 --section=3.2", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('"section":"3.2"'), { deliverAs: "followUp" });
	});

	it("hands PDF page and image mode options to the agent tool", async () => {
		const harness = loadExtension();
		await harness.handler("read 2609.35319 --pages=2-3 --format=image", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining('"pageStart":2,"pageEnd":3,"format":"image"'), {
			deliverAs: "followUp",
		});
	});

	it("uses the working-directory papers flag for downloads", async () => {
		stubFetch();
		const harness = loadExtension();
		await harness.handler("pull 2609.35319 --papers-dir=./elsewhere", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(existsSync(join(root, "elsewhere", "2609.35319", "2609.35319.pdf"))).toBe(true);
	});

	it("reports network failures without throwing", async () => {
		vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
		const harness = loadExtension();
		await harness.handler("pull 2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("arxiv failed"), "error");
	});
});
