/**
 * pandoc invocation. The converter never compiles LaTeX (no `\write18` exposure);
 * pandoc only parses text, which is the safe half of the toolchain.
 */

import { join } from "node:path";
import type { ConvertIO, ConvertWarning } from "../types.ts";
import { exists, listDir } from "../util/fsx.ts";
import { probeTool } from "../util/toolchain.ts";

export interface PandocOptions {
	workDir: string;
	mainTexFile: string;
	bibNames: string[];
	signal?: AbortSignal;
}

export interface PandocResult {
	ok: boolean;
	markdown: string;
	command: string;
	warnings: ConvertWarning[];
}

/** Pick a bibliography pandoc can actually read (.bib); .bbl alone is not supported. */
export async function resolveBibliography(workDir: string, bibNames: string[]): Promise<string | undefined> {
	for (const name of bibNames) {
		for (const candidate of [`${name}.bib`, name]) {
			const full = join(workDir, candidate);
			if (await exists(full)) return candidate;
		}
	}
	const entries = await listDir(workDir);
	return entries.find((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".bib"))?.name;
}

export async function runPandoc(io: ConvertIO, options: PandocOptions): Promise<PandocResult> {
	const warnings: ConvertWarning[] = [];
	const status = await probeTool(io.exec, { name: "pandoc", args: ["--version"], hint: "required for LaTeX → Markdown" }, options.signal);
	if (!status.available) {
		return {
			ok: false,
			markdown: "",
			command: "pandoc",
			warnings: [
				{
					rule: "pandoc",
					level: "error",
					message: "pandoc not found on PATH — install pandoc (https://pandoc.org) to convert LaTeX sources to Markdown",
				},
			],
		};
	}

	const bibliography = await resolveBibliography(options.workDir, options.bibNames);
	const args = [options.mainTexFile, "-f", "latex", "-t", "gfm", "--wrap=none"];
	if (bibliography) {
		args.push("--citeproc", `--bibliography=${bibliography}`);
	} else {
		warnings.push({
			rule: "pandoc",
			level: "warn",
			message: "no .bib file found — citations stay unresolved (add the .bib next to the source)",
		});
	}

	const result = await io.exec("pandoc", args, { cwd: options.workDir, signal: options.signal, timeout: 300_000 });
	if (result.code !== 0) {
		warnings.push({
			rule: "pandoc",
			level: "error",
			message: `pandoc exited with ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").slice(0, 3).join(" ")}`,
		});
	}
	for (const line of result.stderr.split("\n")) {
		if (!line.startsWith("[WARNING]")) continue;
		if (/Deprecated|already defined|Parsing include file/.test(line)) continue;
		warnings.push({ rule: "pandoc", level: "info", message: line.replace(/^\[WARNING\]\s*/, "").trim() });
	}

	return { ok: result.code === 0, markdown: result.stdout, command: `pandoc ${args.join(" ")}`, warnings };
}
