/**
 * Rule pipeline contracts.
 *
 * Every fix that was once a hand-edit of the generated Markdown lives here as a
 * named rule: it reports what it changed, so the model reading the result knows
 * which parts were machine-repaired.
 */

import type { ArxivMeta, ConvertIO, ConvertStats, ConvertWarning } from "../../types.ts";
import type { TexAnalysis } from "../latex.ts";

export interface ConvertState {
	markdown: string;
	analysis: TexAnalysis;
	workDir: string;
	outDir: string;
	io: ConvertIO;
	arxiv?: ArxivMeta | undefined;
	renderFigures: boolean;
	figureDpi: number;
	tableMode: "gfm" | "html";
	signal?: AbortSignal | undefined;
	warnings: ConvertWarning[];
	stats: ConvertStats;
	figureFiles: string[];
}

export interface Rule {
	id: string;
	/** Human sentence used in reports, e.g. "regenerate table captions and renumber them". */
	description: string;
	run(state: ConvertState): Promise<void> | void;
}

export function warn(state: ConvertState, rule: string, message: string, level: ConvertWarning["level"] = "info"): void {
	state.warnings.push({ rule, level, message });
}
