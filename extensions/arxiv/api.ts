/**
 * arXiv metadata lookup over the official Atom API.
 * Requests are serialized with a polite delay (arXiv asks for ~3s between calls).
 */

import type { ArxivMeta } from "../types.ts";
import { fetchWithRetry, type HttpOptions } from "../util/http.ts";

const API_ENDPOINT = "https://export.arxiv.org/api/query";

/** arXiv asks for a gap between requests; production keeps it, tests set 0. */
export const DEFAULT_MIN_INTERVAL_MS = 3_000;

export interface ArxivApiOptions extends HttpOptions {
	/**
	 * Minimum gap between requests, serialized across the process.
	 *
	 * Configurable rather than a module constant because the queue is global: a
	 * request scheduled now may run seconds later, after the caller's ambient
	 * state (a stubbed `fetch`, a proxy) has changed. Tests set 0 to keep request
	 * boundaries inside the test that issued them.
	 */
	minIntervalMs?: number | undefined;
}

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** Run `task` after the polite gap, serialized with every other request. */
function scheduled<T>(task: () => Promise<T>, minIntervalMs: number): Promise<T> {
	const run = queue.then(async () => {
		const wait = minIntervalMs - (Date.now() - lastRequestAt);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
		try {
			return await task();
		} finally {
			lastRequestAt = Date.now();
		}
	});
	queue = run.catch(() => undefined);
	return run;
}

const ID_PATTERN = /((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|(?:\d{4}\.\d{4,5}))(v\d+)?/i;

/** Accepts a bare id, `arXiv:2609.35319v1`, or any arxiv.org abs/pdf/html URL. */
export function parseArxivId(input: string): { id: string; version?: string | undefined } | undefined {
	const text = input.trim().replace(/^arxiv:/i, "");
	const match = ID_PATTERN.exec(text);
	if (!match?.[1]) return undefined;
	return { id: match[1], version: match[2] };
}

function tag(xml: string, name: string): string | undefined {
	const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
	if (!match?.[1]) return undefined;
	return decodeEntities(match[1]).replace(/\s+/g, " ").trim();
}

function tagAll(xml: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "gi");
	for (const match of xml.matchAll(re)) {
		const value = decodeEntities(match[1] ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (value) out.push(value);
	}
	return out;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&");
}

function entries(xml: string): string[] {
	const out: string[] = [];
	for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
		if (match[1]) out.push(match[1]);
	}
	return out;
}

function toMeta(entry: string): ArxivMeta | undefined {
	const rawId = tag(entry, "id");
	const idMatch = rawId ? ID_PATTERN.exec(rawId) : undefined;
	if (!idMatch?.[1]) return undefined;
	const id = idMatch[1];
	const version = idMatch[2];

	const links = [...entry.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1] ?? "");
	const href = (predicate: (attrs: string) => boolean): string | undefined => {
		for (const attrs of links) {
			if (!predicate(attrs)) continue;
			const hrefMatch = /href="([^"]+)"/i.exec(attrs);
			if (hrefMatch?.[1]) return decodeEntities(hrefMatch[1]);
		}
		return undefined;
	};

	const pdfUrl = href((attrs) => /title="pdf"/i.test(attrs)) ?? `https://arxiv.org/pdf/${id}${version ?? ""}`;
	const absUrl =
		href((attrs) => /rel="alternate"/i.test(attrs) && /text\/html/i.test(attrs)) ?? `https://arxiv.org/abs/${id}${version ?? ""}`;
	const htmlUrl = `https://arxiv.org/html/${id}${version ?? ""}`;

	const categories = [...entry.matchAll(/<category\b[^>]*term="([^"]+)"/gi)].map((m) => m[1] ?? "").filter(Boolean);
	const primary = /<arxiv:primary_category\b[^>]*term="([^"]+)"/i.exec(entry)?.[1];

	return {
		id,
		version,
		title: tag(entry, "title") ?? id,
		authors: tagAll(entry, "name"),
		abstract: tag(entry, "summary") ?? "",
		categories,
		primaryCategory: primary,
		published: tag(entry, "published"),
		updated: tag(entry, "updated"),
		doi: tag(entry, "arxiv:doi"),
		comment: tag(entry, "arxiv:comment"),
		journalRef: tag(entry, "arxiv:journal_ref"),
		absUrl,
		pdfUrl,
		htmlUrl,
	};
}

async function fetchAtom(query: string, options: ArxivApiOptions = {}): Promise<string> {
	const { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, ...http } = options;
	return await scheduled(async () => {
		const response = await fetchWithRetry(`${API_ENDPOINT}?${query}`, {
			headers: { accept: "application/atom+xml" },
			...http,
		});
		return await response.text();
	}, minIntervalMs);
}

/** Exact-id lookup. Returns metadata for the requested id (latest version unless pinned). */
export async function lookupById(idOrUrl: string, options: ArxivApiOptions = {}): Promise<ArxivMeta> {
	const parsed = parseArxivId(idOrUrl);
	if (!parsed) throw new Error(`Not an arXiv id or URL: ${idOrUrl}`);
	const params = new URLSearchParams({ id_list: parsed.id, max_results: "1" });
	const xml = await fetchAtom(params.toString(), options);
	const first = entries(xml)[0];
	const meta = first ? toMeta(first) : undefined;
	if (!meta) throw new Error(`arXiv returned no entry for ${parsed.id}`);
	return meta;
}

/** Title search; returns the best candidate list (title matching on arXiv is fuzzy). */
export async function searchByTitle(title: string, limit = 3, options: ArxivApiOptions = {}): Promise<ArxivMeta[]> {
	const cleaned = title
		.replace(/[$\\{}*_`~^]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	const params = new URLSearchParams({ search_query: `ti:"${cleaned}"`, max_results: String(limit) });
	const xml = await fetchAtom(params.toString(), options);
	return entries(xml)
		.map((entry) => toMeta(entry))
		.filter((meta): meta is ArxivMeta => Boolean(meta));
}
