/**
 * arXiv metadata lookup over the official Atom API.
 * Requests are serialized with a polite delay (arXiv asks for ~3s between calls).
 */

import { parser as createSaxParser, type QualifiedAttribute, type QualifiedTag, type SAXOptions, type Tag } from "sax";
import type { ArxivMeta } from "../types.ts";
import { fetchWithRetry, type HttpOptions } from "../util/http.ts";

const API_ENDPOINT = "https://export.arxiv.org/api/query";
const ATOM_NAMESPACE = "http://www.w3.org/2005/Atom";
const ARXIV_NAMESPACE = "http://arxiv.org/schemas/atom";

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

interface AtomNode {
	localName: string;
	namespaceURI: string;
	attributes: Record<string, string>;
	content: Array<string | AtomNode>;
}

/** Build only the small tree arXiv metadata needs, using strict XML and namespace parsing. */
function parseAtom(xml: string): AtomNode[] {
	const roots: AtomNode[] = [];
	const stack: AtomNode[] = [];
	let parseError: Error | undefined;
	const options = { xmlns: true, strictEntities: true, maxEntityCount: 512, maxEntityDepth: 4 } as SAXOptions & {
		strictEntities: boolean;
		maxEntityCount: number;
		maxEntityDepth: number;
	};
	const parser = createSaxParser(true, options);

	parser.onopentag = (tag: Tag | QualifiedTag) => {
		const attributes: Record<string, string> = {};
		for (const [name, value] of Object.entries(tag.attributes)) {
			attributes[name] = typeof value === "string" ? value : (value as QualifiedAttribute).value;
		}
		const qualifiedTag = tag as QualifiedTag;
		const node: AtomNode = {
			localName: qualifiedTag.local ?? tag.name.split(":").at(-1) ?? tag.name,
			namespaceURI: qualifiedTag.uri,
			attributes,
			content: [],
		};
		const parent = stack.at(-1);
		if (parent) parent.content.push(node);
		else roots.push(node);
		stack.push(node);
	};
	parser.ontext = (text) => stack.at(-1)?.content.push(text);
	parser.oncdata = (text) => stack.at(-1)?.content.push(text);
	parser.onclosetag = () => stack.pop();
	parser.ondoctype = () => (parseError ??= new Error("DOCTYPE is not permitted in arXiv Atom feeds"));
	parser.onerror = (error) => (parseError ??= error);

	try {
		parser.write(xml).close();
	} catch (error) {
		parseError ??= error instanceof Error ? error : new Error(String(error));
	}
	if (parseError) throw new Error(`Malformed arXiv Atom feed: ${parseError.message}`);
	return roots;
}

function children(node: AtomNode, localName: string, namespaceURI?: string): AtomNode[] {
	return node.content.filter(
		(item): item is AtomNode =>
			typeof item !== "string" && item.localName === localName && (namespaceURI === undefined || item.namespaceURI === namespaceURI),
	);
}

function child(node: AtomNode, localName: string, namespaceURI?: string): AtomNode | undefined {
	return children(node, localName, namespaceURI)[0];
}

function textContent(node: AtomNode | undefined): string {
	if (!node) return "";
	return node.content
		.map((item) => (typeof item === "string" ? item : textContent(item)))
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function childText(node: AtomNode, localName: string, namespaceURI = ATOM_NAMESPACE): string | undefined {
	const value = textContent(child(node, localName, namespaceURI));
	return value || undefined;
}

function atomEntries(xml: string): AtomNode[] {
	return parseAtom(xml).flatMap((root) =>
		root.localName === "feed" && root.namespaceURI === ATOM_NAMESPACE ? children(root, "entry", ATOM_NAMESPACE) : [],
	);
}

function attr(node: AtomNode, name: string): string | undefined {
	return node.attributes[name];
}

function toMeta(entry: AtomNode): ArxivMeta | undefined {
	const rawId = childText(entry, "id");
	const idMatch = rawId ? ID_PATTERN.exec(rawId) : undefined;
	if (!idMatch?.[1]) return undefined;
	const id = idMatch[1];
	const version = idMatch[2];

	const links = children(entry, "link", ATOM_NAMESPACE);
	const href = (predicate: (link: AtomNode) => boolean): string | undefined => {
		const link = links.find(predicate);
		return link ? attr(link, "href") : undefined;
	};
	const pdfUrl = href((link) => attr(link, "title")?.toLowerCase() === "pdf") ?? `https://arxiv.org/pdf/${id}${version ?? ""}`;
	const absUrl =
		href((link) => attr(link, "rel") === "alternate" && attr(link, "type")?.toLowerCase() === "text/html") ??
		`https://arxiv.org/abs/${id}${version ?? ""}`;
	const categories = children(entry, "category", ATOM_NAMESPACE)
		.map((category) => attr(category, "term"))
		.filter((value): value is string => Boolean(value));
	const primaryCategoryNode = child(entry, "primary_category", ARXIV_NAMESPACE);
	const primaryCategory = primaryCategoryNode ? attr(primaryCategoryNode, "term") : undefined;

	return {
		id,
		version,
		title: childText(entry, "title") ?? id,
		authors: children(entry, "author")
			.map((author) => childText(author, "name"))
			.filter((name): name is string => Boolean(name)),
		abstract: childText(entry, "summary") ?? "",
		categories,
		primaryCategory,
		published: childText(entry, "published"),
		updated: childText(entry, "updated"),
		doi: childText(entry, "doi", ARXIV_NAMESPACE),
		comment: childText(entry, "comment", ARXIV_NAMESPACE),
		journalRef: childText(entry, "journal_ref", ARXIV_NAMESPACE),
		absUrl,
		pdfUrl,
		htmlUrl: `https://arxiv.org/html/${id}${version ?? ""}`,
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
	const first = atomEntries(xml)[0];
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
	return atomEntries(xml)
		.map((entry) => toMeta(entry))
		.filter((meta): meta is ArxivMeta => Boolean(meta));
}
