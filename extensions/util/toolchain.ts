/**
 * External toolchain detection with caching. Everything is optional:
 * the pipeline degrades to fewer outputs instead of failing.
 */

import type { ExecLike } from "../types.ts";

export interface ToolStatus {
	name: string;
	available: boolean;
	version?: string | undefined;
	hint: string;
}

interface Probe {
	name: string;
	args: string[];
	versionPattern?: RegExp;
	hint: string;
}

const PROBES: Probe[] = [
	{ name: "pandoc", args: ["--version"], versionPattern: /pandoc(?:\.exe)?\s+([0-9][^\s]*)/i, hint: "required for LaTeX → Markdown" },
	{ name: "pdftotext", args: ["-v"], versionPattern: /pdftotext version\s+([0-9.]+)/i, hint: "optional, produces the plain-text extract" },
	{ name: "pdftoppm", args: ["-v"], versionPattern: /pdftoppm version\s+([0-9.]+)/i, hint: "optional, rasterizes figure PDFs to PNG" },
];

const cache = new Map<string, ToolStatus>();

export async function probeTool(exec: ExecLike, probe: Probe, signal?: AbortSignal): Promise<ToolStatus> {
	const cached = cache.get(probe.name);
	if (cached) return cached;

	let status: ToolStatus = { name: probe.name, available: false, hint: probe.hint };
	try {
		const result = await exec(probe.name, probe.args, { timeout: 20_000, signal });
		// pdftotext -v / pdftoppm -v exit non-zero on some builds while still printing a banner.
		const banner = `${result.stdout}\n${result.stderr}`;
		const version = probe.versionPattern?.exec(banner)?.[1];
		if (result.code === 0 || version) {
			status = { name: probe.name, available: true, version, hint: probe.hint };
		}
	} catch {
		/* not installed */
	}
	cache.set(probe.name, status);
	return status;
}

export async function detectToolchain(exec: ExecLike, signal?: AbortSignal): Promise<Record<string, ToolStatus>> {
	const out: Record<string, ToolStatus> = {};
	for (const probe of PROBES) out[probe.name] = await probeTool(exec, probe, signal);
	return out;
}
