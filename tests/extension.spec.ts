/**
 * The extension entry point and its `/arxiv` command.
 *
 * This is the path a user types, so it is tested through the real factory with
 * a faked `pi`, rather than by calling the pieces it happens to use.
 */

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

const SOURCE_ARCHIVE = gzipSync(
	makeTar([
		{
			name: "main.tex",
			content: String.raw`\documentclass{article}\title{A Tiny Paper}\author[1]{Ada Lovelace}\begin{document}
\section{Intro}\label{sec:intro}
Body text.
\end{document}`,
		},
	]),
);

interface CommandHarness {
	handler: (input: string, ctx: unknown) => Promise<void>;
	notify: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	exec: ReturnType<typeof vi.fn>;
}

/** Load the extension the way pi does, capturing the `/arxiv` handler. */
function loadExtension(options: { settings?: unknown } = {}): CommandHarness {
	let handler: ((input: string, ctx: unknown) => Promise<void>) | undefined;
	const notify = vi.fn();
	const sendUserMessage = vi.fn();

	const pi = {
		getSettings: () => options.settings ?? {},
		getFlag: () => undefined,
		registerFlag: vi.fn(),
		registerTool: vi.fn(),
		sendUserMessage,
		exec: childProcessExec,
		registerCommand: (name: string, definition: { handler: (input: string, ctx: unknown) => Promise<void> }) => {
			if (name === "arxiv") handler = definition.handler;
		},
	};

	piArxiv(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("/arxiv command was not registered");
	return { handler, notify, sendUserMessage, exec: vi.fn(childProcessExec) };
}

let root: string;

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
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-ext-"));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(root, { recursive: true, force: true });
});

describe("/arxiv without arguments", () => {
	it("explains the usage instead of doing something surprising", async () => {
		const harness = loadExtension();
		await harness.handler("", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /arxiv"), "error");
	});

	it("rejects a bare title, pointing at the tool that supports search", async () => {
		const harness = loadExtension();
		await harness.handler("some paper title", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("arxiv_pull tool"), "error");
	});
});

describe("/arxiv with an id", () => {
	it("downloads, converts and reports the paths", async () => {
		stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		const messages = harness.notify.mock.calls.map((call) => String(call[0]));
		expect(messages.some((message) => message.includes("Resolving"))).toBe(true);
		expect(messages.some((message) => message.includes("Downloading"))).toBe(true);

		const final = messages.at(-1) ?? "";
		expect(final).toContain("Outcome-Guided On-Policy Distillation");
		expect(final).toContain("markdown:");
		expect(final).toContain("2609.35319.pdf");
	});

	it("hands the converted file to the agent as a follow-up message", async () => {
		stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(harness.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("2609.35319.md"), { deliverAs: "followUp" });
	});

	it("accepts an arXiv URL", async () => {
		const calls = stubFetch();
		const harness = loadExtension();

		await harness.handler("https://arxiv.org/abs/2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(calls.some((url) => url.includes("export.arxiv.org"))).toBe(true);
	});
});

describe("/arxiv flags", () => {
	it("--papers-dir places the paper under a different corpus root", async () => {
		stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319 --papers-dir=./elsewhere", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		// The flag overrides the corpus root, so the paper keeps its <id>/ layout.
		expect(existsSync(join(root, "elsewhere", "2609.35319", "2609.35319.pdf"))).toBe(true);
	});

	it("--no-convert stops after downloading", async () => {
		stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319 --no-convert", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		const final = String(harness.notify.mock.calls.at(-1)?.[0] ?? "");
		expect(final).not.toContain("markdown:");
		expect(harness.sendUserMessage).not.toHaveBeenCalled();
	});

	it("--no-figures is accepted", async () => {
		stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319 --no-figures", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		const final = String(harness.notify.mock.calls.at(-1)?.[0] ?? "");
		expect(final).toContain("markdown:");
	});

	it("re-downloads when --force is given", async () => {
		const calls = stubFetch();
		const harness = loadExtension();

		await harness.handler("2609.35319 --force", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(calls.filter((url) => url.includes("/pdf/"))).toHaveLength(1);
	});
});

describe("/arxiv failures", () => {
	it("reports a network failure without throwing", async () => {
		vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
		const harness = loadExtension();

		await harness.handler("2609.35319", { cwd: root, signal: undefined, ui: { notify: harness.notify } });

		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("arxiv failed"), "error");
	});
});
