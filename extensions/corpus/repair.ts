import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readPaperManifest } from "../arxiv/pull.ts";
import { resolveConfig } from "../cfg.ts";
import { convertSourceDir } from "../convert/convert.ts";
import type { ExecLike } from "../types.ts";
import { writeFileQueued } from "../util/fsx.ts";
import { indexPapers } from "./index-papers.ts";

export interface PaperRepairPlan {
	id: string;
	title: string;
	dir: string;
	issues: string[];
	action: "reconvert" | "blocked" | "none";
	markdownPath?: string | undefined;
}

export async function planPaperRepairs(papersDir: string, id?: string): Promise<PaperRepairPlan[]> {
	const report = await indexPapers(papersDir);
	return report.entries
		.filter((entry) => !id || entry.id === id)
		.map((entry) => {
			const issues = entry.issues.map((issue) => issue.message);
			const blocked = entry.issues.some((issue) => issue.kind === "no-source" || issue.kind === "empty");
			const needsConversion = entry.issues.some((issue) => issue.kind === "no-markdown" || issue.kind === "stale-markdown");
			const action: PaperRepairPlan["action"] = blocked ? "blocked" : needsConversion ? "reconvert" : "none";
			return {
				id: entry.id,
				title: entry.title ?? entry.id,
				dir: entry.dir,
				issues,
				action,
				...(entry.markdown ? { markdownPath: entry.markdown } : {}),
			};
		})
		.filter((entry) => entry.issues.length > 0 || entry.action !== "none");
}

export function registerPaperRepairTool(pi: ExtensionAPI, exec: ExecLike): void {
	pi.registerTool(
		defineTool({
			name: "paper_repair",
			label: "Paper corpus repair",
			description:
				"Audit the local paper library and preview Markdown rebuilds. This is a dry run by default; pass apply=true to reconvert papers with missing or stale Markdown from their existing LaTeX source. It never downloads or overwrites PDFs or source archives.",
			promptSnippet: "paper_repair — preview corpus issues and explicitly rebuild stale Markdown",
			promptGuidelines: [
				"Call paper_repair without apply first and show the user the plan.",
				"Only call again with apply=true after the user confirms the planned Markdown rebuilds.",
			],
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "Restrict the audit to one arXiv id" })),
				apply: Type.Optional(Type.Boolean({ description: "Apply planned Markdown reconversions; default false only previews" })),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
			outputSchema: Type.Object({
				applied: Type.Boolean(),
				plans: Type.Array(
					Type.Object({
						id: Type.String(),
						title: Type.String(),
						action: Type.String(),
						issues: Type.Array(Type.String()),
						markdownPath: Type.Optional(Type.String()),
						result: Type.Optional(Type.String()),
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx: ExtensionToolContext) {
				const config = resolveConfig(pi, ctx.cwd);
				const plans = await planPaperRepairs(config.papersDir, params.id);
				const apply = params.apply ?? false;
				const results: Array<PaperRepairPlan & { result?: string | undefined }> = [];

				for (const plan of plans) {
					signal?.throwIfAborted();
					if (!apply || plan.action !== "reconvert") {
						results.push(plan);
						continue;
					}
					const sourceDir = join(plan.dir, "source");
					const markdownPath = plan.markdownPath
						? isAbsolute(plan.markdownPath)
							? plan.markdownPath
							: resolve(plan.dir, plan.markdownPath)
						: join(plan.dir, `${plan.id}.md`);
					const converted = await convertSourceDir(
						{
							workDir: sourceDir,
							outFile: markdownPath,
							figures: config.figures,
							figureDpi: config.figureDpi,
							tableMode: config.tableMode,
							force: true,
						},
						{ exec, signal },
					);
					if (converted.ok && converted.markdownPath) {
						const manifestPath = join(plan.dir, "manifest.json");
						const manifest = await readPaperManifest(manifestPath);
						if (manifest) {
							manifest.outputs ??= {};
							manifest.warnings ??= [];
							manifest.outputs.markdown = converted.markdownPath;
							manifest.outputs.conversion = converted.stats;
							manifest.warnings = [...manifest.warnings, ...converted.warnings];
							await writeFileQueued(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
						}
					}
					results.push({ ...plan, markdownPath, result: converted.ok ? "rebuilt" : "failed" });
				}

				const lines = results.map(
					(plan) =>
						`${plan.id} — ${plan.title}: ${plan.result ?? plan.action}${plan.markdownPath ? ` (${plan.markdownPath})` : ""}${plan.issues.length ? `; ${plan.issues.join("; ")}` : ""}`,
				);
				return {
					content: [
						{
							type: "text",
							text: `${apply ? "Applied repair plan" : "Dry run; no files changed"}\n${lines.join("\n") || "No paper issues found."}`,
						},
					],
					details: { applied: apply, plans: results },
					structuredContent: {
						applied: apply,
						plans: results.map((plan) => ({
							id: plan.id,
							title: plan.title,
							action: plan.action,
							issues: plan.issues,
							...(plan.markdownPath ? { markdownPath: plan.markdownPath } : {}),
							...(plan.result ? { result: plan.result } : {}),
						})),
					},
				};
			},
		}),
	);
}
