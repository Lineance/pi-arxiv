/**
 * Integration test: load pi-arxiv the way pi itself does.
 *
 * Uses pi's own extension loader (jiti + module mapping) so a broken import, a
 * bad tool schema, or a TypeBox misconfiguration fails here instead of at the
 * user's next session start.
 *
 *   node --experimental-strip-types tests/integration.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { check, equal as eq } from "./harness.ts";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(HERE, "extensions", "index.ts");

export async function runIntegration(): Promise<void> {
	// An empty agent dir keeps the user's own extensions out of the result, so the
	// assertions below describe pi-arxiv only.
	const isolatedAgentDir = await mkdtemp(join(tmpdir(), "pi-arxiv-agent-"));
	try {
		await assertLoads(isolatedAgentDir);
	} finally {
		await rm(isolatedAgentDir, { recursive: true, force: true });
	}
}

async function assertLoads(agentDir: string): Promise<void> {
	const loaded = await discoverAndLoadExtensions([ENTRY], HERE, agentDir);

	eq("extension loads without errors", loaded.errors.length, 0);
	for (const error of loaded.errors) console.log(`    load error: ${error.error}`);

	eq("exactly one extension loaded", loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	if (!extension) return;

	const toolNames = [...extension.tools.keys()].sort();
	for (const expected of ["arxiv_lookup", "arxiv_pull", "paper_markdown", "paper_toolchain"]) {
		check(`tool registered: ${expected}`, toolNames.includes(expected), toolNames.join(", "));
	}
	eq("four tools registered", toolNames.length, 4);

	const commandNames = [...extension.commands.keys()];
	check("command registered: arxiv", commandNames.includes("arxiv"), commandNames.join(", "));

	const flagNames = [...extension.flags.keys()];
	for (const expected of ["arxiv-dir", "arxiv-no-figures", "arxiv-table-mode"]) {
		check(`flag registered: ${expected}`, flagNames.includes(expected), flagNames.join(", "));
	}

	// Tool metadata must be model-usable: name, label, description and a schema.
	for (const [name, tool] of extension.tools) {
		const definition = tool.definition;
		check(`${name}: has a description`, definition.description.length > 40, definition.description);
		check(`${name}: has a parameter schema`, Boolean(definition.parameters), definition.parameters);
		check(`${name}: has a label`, definition.label.length > 0, definition.label);
	}

	// Flags must be readable through the extension API surface used at runtime.
	check("flags include a directory override", flagNames.includes("arxiv-dir"), flagNames.join(", "));
}
