/**
 * Conversion driver: LaTeX source directory → clean Markdown.
 * Everything except `io.exec` is pure; the extension injects `pi.exec`.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import type { ConvertOptions, ConvertResult, ConvertStats, ConvertWarning, ExecLike, ExecOptionsLike, ExecResultLike } from "../types.ts";
import { exists, writeFileQueued } from "../util/fsx.ts";
import { analyzeSourceDir, type TexAnalysis } from "./latex.ts";
import { runPandoc } from "./pandoc.ts";
import { lintMarkdown, rules } from "./rules/index.ts";
import type { ConvertState } from "./rules/types.ts";

export function emptyStats(): ConvertStats {
	return {
		lines: 0,
		images: 0,
		tables: 0,
		tablesRebuilt: 0,
		figuresRecovered: 0,
		refs: 0,
		equations: 0,
		citationsUnresolved: false,
	};
}

export async function convertSourceDir(
	options: ConvertOptions,
	io: { exec: ExecLike; log?: (message: string) => void },
): Promise<ConvertResult> {
	if (typeof options.workDir !== "string" || options.workDir.trim() === "") {
		return {
			ok: false,
			figures: [],
			stats: emptyStats(),
			warnings: [{ rule: "convert", level: "error", message: "workDir is required (the directory holding main.tex)" }],
		};
	}
	const workDir = resolve(options.workDir);
	const warnings: ConvertWarning[] = [];
	const stats = emptyStats();

	if (!(await exists(workDir))) {
		return {
			ok: false,
			figures: [],
			stats,
			warnings: [{ rule: "convert", level: "error", message: `source directory not found: ${workDir}` }],
		};
	}

	let analysis: TexAnalysis;
	try {
		analysis = await analyzeSourceDir(workDir, options.mainTex);
	} catch (error) {
		return { ok: false, figures: [], stats, warnings: [{ rule: "convert", level: "error", message: (error as Error).message }] };
	}

	const pandoc = await runPandoc(io, {
		workDir,
		mainTexFile: relative(workDir, analysis.mainFile).split("\\").join("/"),
		bibNames: analysis.bibFiles,
	});
	warnings.push(...pandoc.warnings);
	if (!pandoc.ok) return { ok: false, figures: [], stats, warnings };

	const outFile = resolve(options.outFile ?? join(workDir, `${basename(workDir)}.md`));
	const state: ConvertState = {
		markdown: pandoc.markdown.replace(/\r\n?/g, "\n"),
		analysis,
		workDir,
		outDir: dirname(outFile),
		io,
		arxiv: options.arxivMeta,
		renderFigures: options.figures ?? true,
		figureDpi: options.figureDpi ?? 150,
		tableMode: options.tableMode ?? "gfm",
		warnings,
		stats,
		figureFiles: [],
	};

	for (const rule of rules) {
		io.log?.(`rule: ${rule.id} — ${rule.description}`);
		await rule.run(state);
	}
	lintMarkdown(state);

	await writeFileQueued(outFile, state.markdown);

	let rawMarkdownPath: string | undefined;
	if (options.keepIntermediate) {
		rawMarkdownPath = join(dirname(outFile), `${basename(outFile, ".md")}.pandoc.md`);
		await writeFileQueued(rawMarkdownPath, pandoc.markdown);
	}

	return {
		ok: true,
		markdownPath: outFile,
		rawMarkdownPath,
		figures: state.figureFiles,
		stats,
		warnings,
	};
}

/** Human-readable one-liner set for tool results and the `/arxiv` command. */
export function summarizeWarnings(warnings: ConvertWarning[], limit = 6): string[] {
	const rank: Record<ConvertWarning["level"], number> = { error: 0, warn: 1, info: 2 };
	return [...warnings]
		.sort((a, b) => rank[a.level] - rank[b.level])
		.slice(0, limit)
		.map((warning) => `${warning.level === "info" ? "·" : warning.level === "warn" ? "!" : "✗"} [${warning.rule}] ${warning.message}`);
}

export function summarizeStats(stats: ConvertStats): string {
	return [
		`${stats.lines} lines`,
		`${stats.images} figure(s)`,
		`${stats.tables} table(s)${stats.tablesRebuilt > 0 ? ` (${stats.tablesRebuilt} rebuilt)` : ""}`,
		`${stats.refs} reference(s)`,
		`${stats.equations} display equation(s)`,
	].join(", ");
}

/** Convenience ExecLike over node:child_process for standalone use. */
export async function childProcessExec(command: string, args: string[], options?: ExecOptionsLike): Promise<ExecResultLike> {
	const { spawn } = await import("node:child_process");
	return await new Promise((ok) => {
		const child = spawn(command, args, { cwd: options?.cwd, signal: options?.signal, shell: false });
		let stdout = "";
		let stderr = "";
		const timer = options?.timeout ? setTimeout(() => child.kill("SIGKILL"), options.timeout) : undefined;
		child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			ok({ stdout, stderr: stderr || error.message, code: 127, killed: false });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			ok({ stdout, stderr, code: code ?? 0, killed: false });
		});
	});
}
