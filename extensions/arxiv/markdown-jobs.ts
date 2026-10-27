import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ArxivConfig } from "../cfg.ts";
import { convertSourceDir } from "../convert/convert.ts";
import type { ArxivMeta, ConvertResult, ExecLike } from "../types.ts";
import { writeFileQueued } from "../util/fsx.ts";
import type { Manifest } from "./pull.ts";

export type MarkdownJobState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface MarkdownJob {
	jobId: string;
	paperId: string;
	state: MarkdownJobState;
	phase: string;
	startedAt: string;
	finishedAt?: string;
	markdownPath?: string;
	error?: string;
	warnings: ConvertResult["warnings"];
}

interface MarkdownJobInput {
	meta: ArxivMeta;
	paperDir: string;
	sourceDir: string;
	manifestPath: string;
	manifest: Manifest;
	config: ArxivConfig;
	exec: ExecLike;
	force?: boolean;
}

export interface MarkdownJobManager {
	start(input: MarkdownJobInput): MarkdownJob;
	get(idOrJobId?: string): MarkdownJob[];
	shutdown(): void;
}

export function createMarkdownJobManager(): MarkdownJobManager {
	const jobs = new Map<string, MarkdownJob>();
	const controllers = new Map<string, AbortController>();
	const pending = new Map<string, { input: MarkdownJobInput; controller: AbortController }>();
	const activePaperJobs = new Map<string, string>();
	const queue: string[] = [];
	let pumping = false;

	async function pump(): Promise<void> {
		if (pumping) return;
		pumping = true;
		try {
			while (queue.length > 0) {
				const jobId = queue.shift();
				if (!jobId) continue;
				const entry = pending.get(jobId);
				const job = jobs.get(jobId);
				if (!entry || !job || job.state === "cancelled") continue;
				pending.delete(jobId);
				await run(job, entry.input, entry.controller);
			}
		} finally {
			pumping = false;
		}
	}

	function start(input: MarkdownJobInput): MarkdownJob {
		const activeId = activePaperJobs.get(input.meta.id);
		const active = activeId ? jobs.get(activeId) : undefined;
		if (active && (active.state === "queued" || active.state === "running")) return { ...active };
		if (!input.sourceDir) throw new Error(`No LaTeX source is available for ${input.meta.id}; run /arxiv pull first.`);

		const job: MarkdownJob = {
			jobId: randomUUID(),
			paperId: input.meta.id,
			state: "queued",
			phase: "Waiting to convert",
			startedAt: new Date().toISOString(),
			warnings: [],
		};
		const controller = new AbortController();
		jobs.set(job.jobId, job);
		controllers.set(job.jobId, controller);
		pending.set(job.jobId, { input, controller });
		activePaperJobs.set(job.paperId, job.jobId);
		queue.push(job.jobId);
		void pump();
		return { ...job };
	}

	async function run(job: MarkdownJob, input: MarkdownJobInput, controller: AbortController): Promise<void> {
		job.state = "running";
		job.phase = "Converting LaTeX to Markdown";
		const sourceDir = input.sourceDir;
		const markdownPath = join(input.paperDir, `${job.paperId}.md`);
		try {
			const result = await convertSourceDir(
				{
					workDir: sourceDir,
					outFile: markdownPath,
					figures: input.config.figures,
					figureDpi: input.config.figureDpi,
					tableMode: input.config.tableMode,
					arxivMeta: input.meta,
					force: input.force,
				},
				{ exec: input.exec, signal: controller.signal, log: (phase) => (job.phase = phase) },
			);
			job.warnings = result.warnings;
			if (!result.ok || !result.markdownPath) {
				job.state = "failed";
				job.error = result.warnings.find((warning) => warning.level === "error")?.message ?? "Markdown conversion failed";
				return;
			}
			input.manifest.outputs ??= {};
			input.manifest.warnings ??= [];
			input.manifest.outputs.markdown = result.markdownPath;
			input.manifest.outputs.conversion = result.stats;
			input.manifest.warnings = [...input.manifest.warnings, ...result.warnings];
			await writeFileQueued(input.manifestPath, `${JSON.stringify(input.manifest, null, 2)}\n`);
			job.state = "completed";
			job.markdownPath = result.markdownPath;
			job.phase = result.cached ? "Reused cached Markdown" : "Markdown ready";
		} catch (error) {
			job.state = controller.signal.aborted ? "cancelled" : "failed";
			job.error = controller.signal.aborted ? "Conversion cancelled" : (error as Error).message;
		} finally {
			job.finishedAt = new Date().toISOString();
			controllers.delete(job.jobId);
			if (activePaperJobs.get(job.paperId) === job.jobId) activePaperJobs.delete(job.paperId);
		}
	}

	return {
		start,
		get(idOrJobId) {
			const all = [...jobs.values()];
			if (!idOrJobId) return all.map((job) => ({ ...job }));
			const exact = jobs.get(idOrJobId);
			if (exact) return [{ ...exact }];
			return all
				.filter((job) => job.paperId === idOrJobId)
				.slice(-1)
				.map((job) => ({ ...job }));
		},
		shutdown() {
			for (const controller of controllers.values()) controller.abort();
			for (const jobId of queue) {
				const job = jobs.get(jobId);
				if (job?.state === "queued") {
					job.state = "cancelled";
					job.finishedAt = new Date().toISOString();
				}
			}
			queue.length = 0;
			pending.clear();
		},
	};
}
