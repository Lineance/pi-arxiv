import { join } from "node:path";
import type { ArxivMeta } from "../types.ts";
import { type ArxivApiOptions, lookupById, parseArxivId, searchByTitle } from "./api.ts";
import { type PullOptions, type PullResult, pull } from "./pull.ts";

export async function searchArxiv(query: string, limit = 5, options: ArxivApiOptions = {}): Promise<ArxivMeta[]> {
	const parsed = parseArxivId(query);
	if (parsed) return [await lookupById(query, options)];
	return await searchByTitle(query, limit, options);
}

export async function resolveArxivPaper(query: string, options: ArxivApiOptions = {}): Promise<ArxivMeta> {
	const matches = await searchArxiv(query, 1, options);
	const meta = matches[0];
	if (!meta) throw new Error(`No arXiv match for: ${query}`);
	return meta;
}

export interface PullArxivOptions extends Omit<PullOptions, "destDir">, ArxivApiOptions {
	destDir?: string;
	papersDir?: string;
}

export async function pullArxivPaper(query: string, options: PullArxivOptions): Promise<{ meta: ArxivMeta; pulled: PullResult }> {
	const meta = await resolveArxivPaper(query, options);
	const destDir = options.destDir ?? join(options.papersDir ?? "papers", meta.id);
	return { meta, pulled: await pull(meta, { ...options, destDir }) };
}
