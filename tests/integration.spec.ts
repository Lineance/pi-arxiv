/**
 * Integration: load the extension the way pi itself does.
 *
 * A broken import, a malformed tool schema or a TypeBox misconfiguration then
 * fails here rather than at the user's next session start.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(HERE, "extensions", "index.ts");

/** The tools the package promises to expose. */
const EXPECTED_TOOLS = [
	"arxiv_diff",
	"arxiv_lookup",
	"arxiv_markdown",
	"arxiv_pull",
	"arxiv_read",
	"arxiv_status",
	"paper_markdown",
	"paper_repair",
	"paper_search",
	"paper_section",
	"paper_toolchain",
	"papers_index",
];
const EXPECTED_FLAGS = ["arxiv-dir", "arxiv-no-figures", "arxiv-table-mode"];

let isolatedAgentDir: string;
let loaded: Awaited<ReturnType<typeof discoverAndLoadExtensions>>;

beforeAll(async () => {
	// An empty agent dir keeps the user's own extensions out of the result, so the
	// assertions describe pi-arxiv and nothing else.
	isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-arxiv-agent-"));
	loaded = await discoverAndLoadExtensions([ENTRY], HERE, isolatedAgentDir);
});

afterAll(async () => {
	await rm(isolatedAgentDir, { recursive: true, force: true });
});

describe("extension loading", () => {
	it("loads without errors", () => {
		expect(loaded.errors.map((error) => error.error)).toEqual([]);
	});

	it("registers exactly one extension", () => {
		expect(loaded.extensions).toHaveLength(1);
	});

	it("registers the arxiv command", () => {
		expect([...(loaded.extensions[0]?.commands.keys() ?? [])]).toContain("arxiv");
	});

	it.each(EXPECTED_TOOLS)("registers the %s tool", (name) => {
		expect([...(loaded.extensions[0]?.tools.keys() ?? [])]).toContain(name);
	});

	it.each(EXPECTED_FLAGS)("registers the %s flag", (name) => {
		expect([...(loaded.extensions[0]?.flags.keys() ?? [])]).toContain(name);
	});

	it("exposes the twelve documented tools", () => {
		expect([...(loaded.extensions[0]?.tools.keys() ?? [])].sort()).toEqual([...EXPECTED_TOOLS].sort());
	});
});

describe("tool definitions", () => {
	/** A definition the model cannot use is worse than a missing tool. */
	it.each(EXPECTED_TOOLS)("%s has a label, a description and a parameter schema", (name) => {
		const definition = loaded.extensions[0]?.tools.get(name)?.definition;
		expect(definition).toBeDefined();
		expect(definition?.label.length).toBeGreaterThan(0);
		expect(definition?.description.length).toBeGreaterThan(40);
		expect(definition?.parameters).toBeDefined();
	});
});
