/**
 * Configuration resolution: tool parameters > CLI flags > settings > defaults.
 * Settings live under the `arxiv` key of pi's settings.json.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TableMode } from "./types.ts";

export const LIB_VERSION = "0.1.0";

export interface ArxivConfig {
	papersDir: string;
	figures: boolean;
	figureDpi: number;
	tableMode: TableMode;
	timeoutMs: number;
}

export interface ArxivConfigOverrides {
	papersDir?: string | undefined;
	figures?: boolean | undefined;
	figureDpi?: number | undefined;
	tableMode?: TableMode | undefined;
}

interface ArxivSettings {
	papersDir?: string | undefined;
	figures?: boolean | undefined;
	figureDpi?: number | undefined;
	tableMode?: TableMode | undefined;
	timeoutMs?: number | undefined;
}

/** The slice of pi settings this package owns (`settings.json` → `"arxiv"`). */
interface SettingsWithArxiv {
	arxiv?: ArxivSettings | undefined;
}

function readSettings(pi: ExtensionAPI): ArxivSettings {
	try {
		const settings = pi.getSettings() as unknown as SettingsWithArxiv;
		return settings.arxiv ?? {};
	} catch {
		return {};
	}
}

export function resolveConfig(pi: ExtensionAPI, cwd: string, overrides: ArxivConfigOverrides = {}): ArxivConfig {
	const settings = readSettings(pi);
	const flagDir = pi.getFlag("arxiv-dir");
	const flagNoFigures = pi.getFlag("arxiv-no-figures");
	const flagTableMode = pi.getFlag("arxiv-table-mode");

	const papersDir = overrides.papersDir ?? (typeof flagDir === "string" ? flagDir : undefined) ?? settings.papersDir ?? join(cwd, "papers");
	const figures = overrides.figures ?? (flagNoFigures === true ? false : (settings.figures ?? true));
	const figureDpi = overrides.figureDpi ?? settings.figureDpi ?? 150;
	const rawTableMode =
		overrides.tableMode ?? (typeof flagTableMode === "string" ? flagTableMode : undefined) ?? settings.tableMode ?? "gfm";
	const tableMode: TableMode = rawTableMode === "html" ? "html" : "gfm";

	return {
		papersDir,
		figures,
		figureDpi,
		tableMode,
		timeoutMs: settings.timeoutMs ?? 120_000,
	};
}

export function registerFlags(pi: ExtensionAPI): void {
	pi.registerFlag("arxiv-dir", { description: "Directory for downloaded papers (default: <cwd>/papers)", type: "string" });
	pi.registerFlag("arxiv-no-figures", { description: "Do not rasterize figure PDFs to PNG", type: "boolean" });
	pi.registerFlag("arxiv-table-mode", { description: "Table output: gfm (default) or html", type: "string" });
}
