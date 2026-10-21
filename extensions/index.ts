import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseArxivId } from "./arxiv/api.ts";
import { createMarkdownJobManager } from "./arxiv/markdown-jobs.ts";
import { readPaperManifest } from "./arxiv/pull.ts";
import { pullArxivPaper, resolveArxivPaper, searchArxiv } from "./arxiv/workflow.ts";
import { type ArxivConfig, LIB_VERSION, registerFlags, resolveConfig } from "./cfg.ts";
import { registerTools } from "./tools.ts";
import type { ExecLike } from "./types.ts";
import { exists } from "./util/fsx.ts";

interface ParsedCommand {
	action: string;
	query: string;
	flags: Map<string, string | true>;
}

interface CommandServices {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	command: ParsedCommand;
	config: ArxivConfig;
	jobs: ReturnType<typeof createMarkdownJobManager>;
	exec: ExecLike;
}

function parseCommand(input: string): ParsedCommand {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const first = tokens[0] ?? "";
	const known = new Set(["search", "pull", "read", "markdown", "status", "diff", "help"]);
	const action = known.has(first) ? first : parseArxivId(first) ? "pull" : "help";
	const rest = action === first ? tokens.slice(1) : tokens;
	const flags = new Map<string, string | true>();
	const query: string[] = [];
	for (const token of rest) {
		if (!token.startsWith("--")) {
			query.push(token);
			continue;
		}
		const equal = token.indexOf("=");
		flags.set(equal < 0 ? token.slice(2) : token.slice(2, equal), equal < 0 ? true : token.slice(equal + 1));
	}
	return { action, query: query.join(" "), flags };
}

function flagString(flags: Map<string, string | true>, key: string): string | undefined {
	const value = flags.get(key);
	return typeof value === "string" ? value : undefined;
}

function flagEnabled(flags: Map<string, string | true>, key: string): boolean {
	return flags.get(key) === true;
}

function statusText(jobs: ReturnType<typeof createMarkdownJobManager>, id?: string): string {
	const found = jobs.get(id);
	if (found.length === 0) return "No matching Markdown jobs in this Pi session.";
	return found
		.map(
			(job) =>
				`${job.jobId} ${job.paperId} ${job.state}: ${job.phase}${job.markdownPath ? ` (${job.markdownPath})` : ""}${job.error ? ` — ${job.error}` : ""}`,
		)
		.join("\n");
}

async function queueMarkdown(
	idInput: string,
	options: {
		pi: ExtensionAPI;
		cwd: string;
		papersDir: string;
		jobs: ReturnType<typeof createMarkdownJobManager>;
		exec: ExecLike;
		force?: boolean;
	},
) {
	const parsed = parseArxivId(idInput);
	if (!parsed) throw new Error(`Not an arXiv id: ${idInput}`);
	const config = resolveConfig(options.pi, options.cwd, { papersDir: options.papersDir });
	const meta = await resolveArxivPaper(parsed.id);
	const paperDir = join(config.papersDir, parsed.id);
	const sourceDir = join(paperDir, "source");
	const manifestPath = join(paperDir, "manifest.json");
	const manifest = await readPaperManifest(manifestPath);
	if (!manifest || !(await exists(sourceDir)))
		throw new Error(`No pulled LaTeX source found for ${parsed.id}; run /arxiv pull ${parsed.id} first.`);
	return options.jobs.start({
		meta,
		paperDir,
		sourceDir,
		manifestPath,
		manifest,
		config,
		exec: options.exec,
		...(options.force !== undefined ? { force: options.force } : {}),
	});
}

async function handleSearch({ command, ctx }: CommandServices): Promise<void> {
	if (!command.query) throw new Error("Usage: /arxiv search <title or query>");
	const limit = Number(flagString(command.flags, "limit")) || 5;
	const matches = await searchArxiv(command.query, limit, { signal: ctx.signal });
	const text = matches.length
		? matches
				.map(
					(meta) =>
						`${meta.id}${meta.version ?? ""} — ${meta.title}\n${meta.authors.slice(0, 5).join(", ")}\n${meta.abstract.slice(0, 400)}`,
				)
				.join("\n\n")
		: `No arXiv matches for: ${command.query}`;
	ctx.ui.notify(text, "info");
}

async function handlePull({ command, config, ctx }: CommandServices): Promise<void> {
	if (!command.query) throw new Error("Usage: /arxiv pull <id|url|title>");
	ctx.ui.notify(`Pulling ${command.query}…`, "info");
	const version = flagString(command.flags, "version");
	const { meta, pulled } = await pullArxivPaper(command.query, {
		papersDir: config.papersDir,
		...(version ? { version } : {}),
		...(flagEnabled(command.flags, "force") ? { force: true } : {}),
		...(ctx.signal ? { signal: ctx.signal } : {}),
		timeoutMs: config.timeoutMs,
		libVersion: LIB_VERSION,
	});
	ctx.ui.notify(
		`${meta.id}${meta.version ?? ""} — ${meta.title}\npdf: ${pulled.pdfPath ?? "not requested"}\nsource: ${pulled.sourceDir ?? "not requested"}\nmanifest: ${pulled.manifestPath}\nMarkdown conversion is separate: /arxiv markdown ${meta.id}`,
		"info",
	);
}

function queueRead({ command, ctx, pi, config }: CommandServices): void {
	if (!command.query) throw new Error("Usage: /arxiv read <id> --section=<title> | --pages=1-2 [--format=text|image]");
	const pages = flagString(command.flags, "pages");
	const pageRange = pages ? /^(\d+)(?:-(\d+))?$/.exec(pages) : undefined;
	if (pages && !pageRange) throw new Error("--pages must be a page number or inclusive range, e.g. --pages=2-4");
	const section = flagString(command.flags, "section");
	if (!pageRange && !section) throw new Error("Choose --section=<title> or --pages=1-2.");
	const format = flagString(command.flags, "format") ?? "text";
	if (format !== "text" && format !== "image") throw new Error("--format must be text or image.");
	const args = pageRange
		? {
				id: command.query,
				papersDir: config.papersDir,
				pageStart: Number(pageRange[1]),
				pageEnd: Number(pageRange[2] ?? pageRange[1]),
				format,
			}
		: { id: command.query, papersDir: config.papersDir, section };
	pi.sendUserMessage(
		`Use arxiv_read with these arguments: ${JSON.stringify(args)}. Return the requested paper content and cite its section or page locator.`,
		{ deliverAs: "followUp" },
	);
	ctx.ui.notify("Reading request queued for the agent.", "info");
}

async function handleMarkdown({ command, ctx, pi, config, jobs, exec }: CommandServices): Promise<void> {
	if (!command.query) throw new Error("Usage: /arxiv markdown <id> [--force]");
	const job = await queueMarkdown(command.query, {
		pi,
		cwd: ctx.cwd,
		papersDir: config.papersDir,
		jobs,
		exec,
		force: flagEnabled(command.flags, "force"),
	});
	ctx.ui.notify(`Markdown ${job.state}: ${job.jobId} (${job.paperId}). Check with /arxiv status ${job.jobId}.`, "info");
}

function handleDiff({ command, ctx, pi, config }: CommandServices): void {
	if (!command.query) throw new Error("Usage: /arxiv diff <id> --from=v1 --to=v2");
	const from = flagString(command.flags, "from");
	const to = flagString(command.flags, "to");
	if (!from || !to) throw new Error("Both --from and --to are required.");
	pi.sendUserMessage(
		`Use arxiv_diff with these arguments: ${JSON.stringify({ id: command.query, from, to, papersDir: config.papersDir })}.`,
		{ deliverAs: "followUp" },
	);
	ctx.ui.notify("Version comparison queued for the agent.", "info");
}

function showHelp(ctx: ExtensionCommandContext, error: boolean): void {
	ctx.ui.notify(
		[
			"Usage: /arxiv <search|pull|read|markdown|status|diff> ...",
			"/arxiv search <query> [--limit=5]",
			"/arxiv pull <id|url|title> [--version=v1] [--force]",
			"/arxiv read <id> --section=<title> | --pages=1-2 [--format=text|image]",
			"/arxiv markdown <id> [--force]",
			"/arxiv status [job-id|paper-id]",
			"/arxiv diff <id> --from=v1 --to=v2",
		].join("\n"),
		error ? "error" : "info",
	);
}

export default function piArxiv(pi: ExtensionAPI) {
	const exec: ExecLike = (command, args, options) => {
		if (!options) return pi.exec(command, args);
		const piOptions: { cwd?: string; timeout?: number; signal?: AbortSignal } = {};
		if (options.cwd !== undefined) piOptions.cwd = options.cwd;
		if (options.timeout !== undefined) piOptions.timeout = options.timeout;
		if (options.signal !== undefined) piOptions.signal = options.signal;
		return pi.exec(command, args, piOptions);
	};
	const jobs = createMarkdownJobManager();

	registerFlags(pi);
	registerTools(pi, exec, jobs);
	pi.on("session_shutdown", () => jobs.shutdown());

	pi.registerCommand("arxiv", {
		description: "Search, pull, read, convert to Markdown, check status, or diff arXiv papers. Use /arxiv help for syntax.",
		handler: async (input: string, ctx: ExtensionCommandContext) => {
			const command = parseCommand(input);
			const papersDir = flagString(command.flags, "papers-dir");
			const config = resolveConfig(pi, ctx.cwd, papersDir ? { papersDir: resolve(ctx.cwd, papersDir) } : {});
			const services: CommandServices = { pi, ctx, command, config, jobs, exec };
			try {
				switch (command.action) {
					case "search":
						await handleSearch(services);
						return;
					case "pull":
						await handlePull(services);
						return;
					case "read":
						queueRead(services);
						return;
					case "markdown":
						await handleMarkdown(services);
						return;
					case "status":
						ctx.ui.notify(statusText(jobs, command.query || undefined), "info");
						return;
					case "diff":
						handleDiff(services);
						return;
					default:
						showHelp(ctx, command.action !== "help");
				}
			} catch (error) {
				if (ctx.signal?.aborted) return;
				ctx.ui.notify(`arxiv failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
