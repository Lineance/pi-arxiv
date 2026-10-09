/**
 * pi-arxiv — pi extension entry point.
 *
 * Fetch arXiv papers (PDF + LaTeX e-print) and convert them into clean,
 * KaTeX-safe Markdown with pandoc plus a post-processing rule pipeline.
 *
 * `pi install ./pi-arxiv`  ·  `/arxiv 2609.35319`
 */

import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { lookupById, parseArxivId } from "./arxiv/api.ts";
import { pull } from "./arxiv/pull.ts";
import { LIB_VERSION, registerFlags, resolveConfig } from "./cfg.ts";
import { convertSourceDir, summarizeStats, summarizeWarnings } from "./convert/convert.ts";
import { registerTools } from "./tools.ts";
import type { ExecLike } from "./types.ts";
import { writeFileQueued } from "./util/fsx.ts";

interface CommandArgs {
	query: string;
	papersDir?: string;
	force: boolean;
	convert: boolean;
	figures?: boolean;
	version?: string;
}

function parseArgs(input: string): CommandArgs {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const args: CommandArgs = { query: "", force: false, convert: true };
	const rest: string[] = [];
	for (const token of tokens) {
		if (token === "--force") args.force = true;
		else if (token === "--no-convert") args.convert = false;
		else if (token === "--no-figures") args.figures = false;
		else if (token.startsWith("--papers-dir=")) args.papersDir = token.slice("--papers-dir=".length);
		else if (token.startsWith("--version=")) args.version = token.slice(10);
		else rest.push(token);
	}
	args.query = rest.join(" ");
	return args;
}

export default function piArxiv(pi: ExtensionAPI) {
	// Build pi's ExecOptions without passing explicit `undefined` values, which
	// `exactOptionalPropertyTypes` (rightly) rejects.
	const exec: ExecLike = (command, args, options) => {
		if (!options) return pi.exec(command, args);
		const piOptions: { cwd?: string; timeout?: number; signal?: AbortSignal } = {};
		if (options.cwd !== undefined) piOptions.cwd = options.cwd;
		if (options.timeout !== undefined) piOptions.timeout = options.timeout;
		if (options.signal !== undefined) piOptions.signal = options.signal;
		return pi.exec(command, args, piOptions);
	};

	registerFlags(pi);
	registerTools(pi, exec);

	pi.registerCommand("arxiv", {
		description:
			"Fetch an arXiv paper and convert it to Markdown (usage: /arxiv <id|url|title> [--force] [--no-convert] [--no-figures] [--papers-dir=path] [--version=v1])",
		handler: async (input: string, ctx: ExtensionCommandContext) => {
			const args = parseArgs(input);
			if (!args.query) {
				ctx.ui.notify("Usage: /arxiv <id|url|title> [--force] [--no-convert] [--no-figures] [--papers-dir=path]", "error");
				return;
			}
			if (!parseArxivId(args.query)) {
				ctx.ui.notify("Provide an arXiv id or URL (title search is available through the arxiv_pull tool).", "error");
				return;
			}

			try {
				ctx.ui.notify(`Resolving ${args.query}…`, "info");
				const meta = await lookupById(args.query, {
					signal: ctx.signal,
					onRetry: (attempt, error) => ctx.ui.notify(`retry ${attempt}: ${error.message}`, "info"),
				});
				const config = resolveConfig(pi, ctx.cwd, {
					papersDir: args.papersDir ? resolve(ctx.cwd, args.papersDir) : undefined,
					figures: args.figures,
				});
				const destDir = join(config.papersDir, meta.id);

				ctx.ui.notify(`Downloading ${meta.id}${meta.version ?? ""}…`, "info");
				const pulled = await pull(meta, {
					destDir,
					version: args.version,
					force: args.force,
					timeoutMs: config.timeoutMs,
					libVersion: LIB_VERSION,
				});

				let markdownPath: string | undefined;
				let statsLine = "";
				let warnings = [...pulled.warnings];
				if (args.convert && pulled.sourceDir) {
					ctx.ui.notify("Converting LaTeX source to Markdown…", "info");
					const converted = await convertSourceDir(
						{
							workDir: pulled.sourceDir,
							outFile: join(pulled.sourceDir, `${meta.id}.md`),
							figures: config.figures,
							figureDpi: config.figureDpi,
							tableMode: config.tableMode,
							arxivMeta: meta,
							// A forced pull re-downloads, so its conversion must not be reused.
							force: args.force,
						},
						{ exec },
					);
					markdownPath = converted.markdownPath;
					statsLine = summarizeStats(converted.stats);
					warnings = [...warnings, ...converted.warnings];
					pulled.manifest.outputs.markdown = converted.markdownPath;
					pulled.manifest.outputs.conversion = converted.stats;
					pulled.manifest.warnings = warnings;
					await writeFileQueued(pulled.manifestPath, `${JSON.stringify(pulled.manifest, null, 2)}\n`);
				}

				const lines = [
					`${meta.id}${meta.version ?? ""} — ${meta.title}`,
					pulled.pdfPath ? `pdf: ${pulled.pdfPath}` : "",
					pulled.sourceDir ? `source: ${pulled.sourceDir}` : "",
					markdownPath ? `markdown: ${markdownPath}` : "",
					statsLine ? `stats: ${statsLine}` : "",
					...summarizeWarnings(warnings, 4),
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), warnings.some((warning) => warning.level === "error") ? "error" : "info");

				if (markdownPath) {
					pi.sendUserMessage(`Read the converted Markdown at ${markdownPath} and summarise the key contributions.`, {
						deliverAs: "followUp",
					});
				}
			} catch (error) {
				ctx.ui.notify(`arxiv failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
