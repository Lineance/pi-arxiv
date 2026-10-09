/**
 * External toolchain detection with caching.
 *
 * Everything is optional: the pipeline degrades to fewer outputs instead of
 * failing, and the caller learns which tool is missing so it can say why.
 */

import type { ExecLike } from "../types.ts";

export interface ToolStatus {
	name: string;
	available: boolean;
	version?: string | undefined;
	hint: string;
}

/**
 * Named fields rather than a `Record<string, ToolStatus>`: the probe list is
 * fixed, and a typed result means a caller cannot misspell a tool name or have
 * to index with a string. It also removes the friction between the linter's
 * literal-key rule and TypeScript's index-signature rule.
 */
export interface Toolchain {
	pandoc: ToolStatus;
	pdftoppm: ToolStatus;
	pdftotext: ToolStatus;
}

interface Probe {
	name: keyof Toolchain;
	args: string[];
	versionPattern?: RegExp;
	hint: string;
}

const PROBES: Record<keyof Toolchain, Probe> = {
	pandoc: {
		name: "pandoc",
		args: ["--version"],
		versionPattern: /pandoc(?:\.exe)?\s+([0-9][^\s]*)/i,
		hint: "required for LaTeX → Markdown",
	},
	pdftoppm: {
		name: "pdftoppm",
		args: ["-v"],
		versionPattern: /pdftoppm version\s+([0-9.]+)/i,
		hint: "optional, rasterizes figure PDFs to PNG",
	},
	pdftotext: {
		name: "pdftotext",
		args: ["-v"],
		versionPattern: /pdftotext version\s+([0-9.]+)/i,
		hint: "optional, produces the plain-text extract",
	},
};

const cache = new Map<string, ToolStatus>();

export async function probeTool(exec: ExecLike, probe: Probe, signal?: AbortSignal): Promise<ToolStatus> {
	const cached = cache.get(probe.name);
	if (cached) return cached;

	let status: ToolStatus = { name: probe.name, available: false, hint: probe.hint };
	try {
		const result = await exec(probe.name, probe.args, { timeout: 20_000, signal });
		// `pdftotext -v` and `pdftoppm -v` exit non-zero on some builds while still
		// printing a banner, so a parsed version also counts as success.
		const banner = `${result.stdout}\n${result.stderr}`;
		const version = probe.versionPattern?.exec(banner)?.[1];
		if (result.code === 0 || version) {
			status = { name: probe.name, available: true, version, hint: probe.hint };
		}
	} catch {
		/* not installed: leave the status as unavailable */
	}
	cache.set(probe.name, status);
	return status;
}

/** Probe every tool, in parallel. Results are cached per process. */
export async function detectToolchain(exec: ExecLike, signal?: AbortSignal): Promise<Toolchain> {
	const [pandoc, pdftoppm, pdftotext] = await Promise.all([
		probeTool(exec, PROBES.pandoc, signal),
		probeTool(exec, PROBES.pdftoppm, signal),
		probeTool(exec, PROBES.pdftotext, signal),
	]);
	return { pandoc, pdftoppm, pdftotext };
}
