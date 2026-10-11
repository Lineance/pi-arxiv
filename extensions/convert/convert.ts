/**
 * Conversion driver: LaTeX source directory → clean Markdown.
 * Everything except `io.exec` is pure; the extension injects `pi.exec`.
 */

import { basename, dirname, join, relative, resolve } from "node:path";
import type { ConvertIO, ConvertOptions, ConvertResult, ConvertStats, ConvertWarning, ExecOptionsLike, ExecResultLike } from "../types.ts";
import { exists, writeFileQueued } from "../util/fsx.ts";
import { LIB_VERSION } from "../version.ts";
import { buildEntry, cachePathFor, digestSources, findValidCache, outputExclusions, toolchainVersions, writeCache } from "./cache.ts";
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

export async function convertSourceDir(options: ConvertOptions, io: ConvertIO): Promise<ConvertResult> {
	io.signal?.throwIfAborted();
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
		io.signal?.throwIfAborted();
	} catch (error) {
		io.signal?.throwIfAborted();
		return { ok: false, figures: [], stats, warnings: [{ rule: "convert", level: "error", message: (error as Error).message }] };
	}

	const outFile = resolve(options.outFile ?? join(workDir, `${basename(workDir)}.md`));

	// Reuse a previous conversion when nothing that affects it changed.
	const cacheEnabled = (options.cache ?? true) && !options.force;
	if (cacheEnabled) {
		const reuse = await findValidCache(outFile, await currentInputs(workDir, outFile, options, io));
		if (reuse) {
			io.signal?.throwIfAborted();
			return {
				ok: true,
				markdownPath: reuse.markdownPath,
				figures: reuse.figures,
				stats: reuse.stats,
				warnings: [...reuse.warnings, { rule: "cache", level: "info", message: `reused the conversion from ${reuse.convertedAt}` }],
				cached: true,
			};
		}
	}

	const pandoc = await runPandoc(io, {
		workDir,
		mainTexFile: relative(workDir, analysis.mainFile).split("\\").join("/"),
		bibNames: analysis.bibFiles,
		signal: io.signal,
	});
	warnings.push(...pandoc.warnings);
	if (!pandoc.ok) return { ok: false, figures: [], stats, warnings };

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
		signal: io.signal,
	};

	for (const rule of rules) {
		io.log?.(`rule: ${rule.id} — ${rule.description}`);
		await rule.run(state);
		io.signal?.throwIfAborted();
	}
	lintMarkdown(state);

	io.signal?.throwIfAborted();
	await writeFileQueued(outFile, state.markdown);

	let rawMarkdownPath: string | undefined;
	if (options.keepIntermediate) {
		rawMarkdownPath = join(dirname(outFile), `${basename(outFile, ".md")}.pandoc.md`);
		await writeFileQueued(rawMarkdownPath, pandoc.markdown);
	}

	io.signal?.throwIfAborted();
	// Record the inputs only after a successful write, so an interrupted run
	// cannot leave a cache entry describing a file that was never produced.
	const inputs = await currentInputs(workDir, outFile, options, io);
	io.signal?.throwIfAborted();
	await writeCache(cachePathFor(outFile), buildEntry(inputs, { markdownPath: outFile, stats, figures: state.figureFiles, warnings }));
	io.signal?.throwIfAborted();

	return {
		ok: true,
		markdownPath: outFile,
		rawMarkdownPath,
		figures: state.figureFiles,
		stats,
		warnings,
	};
}

/** Everything a conversion's output depends on. */
async function currentInputs(
	workDir: string,
	outFile: string,
	options: ConvertOptions,
	io: Pick<ConvertIO, "exec" | "signal">,
): Promise<Parameters<typeof buildEntry>[0]> {
	return {
		sourceDigest: await digestSources(workDir, outputExclusions(outFile, workDir)),
		toolchain: await toolchainVersions(io.exec, io.signal),
		options: {
			figures: options.figures ?? true,
			figureDpi: options.figureDpi ?? 150,
			tableMode: options.tableMode ?? "gfm",
			libVersion: LIB_VERSION,
		},
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
	return await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options?.cwd, signal: options?.signal, shell: false });
		let stdout = "";
		let stderr = "";
		let spawnError: Error | undefined;
		let timedOut = false;
		const timer = options?.timeout
			? setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, options.timeout)
			: undefined;
		child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
		child.on("error", (error) => {
			spawnError = error;
		});
		child.on("close", (code, exitSignal) => {
			if (timer) clearTimeout(timer);
			if (options?.signal?.aborted) {
				reject(options.signal.reason);
				return;
			}
			if (spawnError) {
				resolve({ stdout, stderr: stderr || spawnError.message, code: 127, killed: false });
				return;
			}
			resolve({ stdout, stderr, code: timedOut ? 124 : (code ?? 1), killed: timedOut || exitSignal !== null });
		});
	});
}
