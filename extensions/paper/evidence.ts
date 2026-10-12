import { sha256Text } from "../util/fsx.ts";

export interface EvidenceLocation {
	id: string;
	lineStart: number;
	lineEnd: number;
	contentHash: string;
}

export interface ApproximatePdfPages {
	start: number;
	end: number;
	confidence: "approximate";
}

const TOKEN_RE = /[\p{L}\p{N}]{3,}/gu;
const STOP_WORDS = new Set([
	"and",
	"are",
	"for",
	"from",
	"has",
	"have",
	"into",
	"not",
	"our",
	"that",
	"the",
	"their",
	"this",
	"with",
	"were",
	"which",
	"while",
]);

function terms(text: string): Set<string> {
	return new Set((text.toLowerCase().match(TOKEN_RE) ?? []).filter((term) => !STOP_WORDS.has(term)));
}

export function makeEvidenceLocation(
	paperId: string,
	version: string | undefined,
	lineStart: number,
	lineEnd: number,
	text: string,
): EvidenceLocation {
	const contentHash = sha256Text(text);
	const versionPart = version ? `@${version}` : "";
	return {
		id: `${paperId}${versionPart}:L${lineStart}-${lineEnd}:${contentHash.slice(0, 16)}`,
		lineStart,
		lineEnd,
		contentHash,
	};
}

/** Best-effort lexical mapping; the caller must present the result as approximate. */
export function mapSectionToPdfPages(sectionText: string, pdfText: string): ApproximatePdfPages | undefined {
	const sectionTerms = terms(sectionText);
	if (sectionTerms.size < 8) return undefined;

	const pages = pdfText.split("\f").map((page) => terms(page));
	const matches = pages.map((page) => [...sectionTerms].filter((term) => page.has(term)).length);
	const best = Math.max(0, ...matches);
	if (best < 3) return undefined;

	const minimum = Math.max(3, Math.ceil(best * 0.45));
	const matchedPages = matches.flatMap((count, index) => (count >= minimum ? [index + 1] : []));
	if (matchedPages.length === 0) return undefined;
	return { start: Math.min(...matchedPages), end: Math.max(...matchedPages), confidence: "approximate" };
}
