/**
 * Captions: renumber by document order and recover captions pandoc dropped.
 *
 * Two real failures are handled here:
 *   - `wrapfigure` captions are silently lost by pandoc  → restored from LaTeX
 *   - a table caption inside a figure float (`\captionsetup{type=table}`) is
 *     emitted as a *figure* caption by pandoc and would be mislabelled
 */

import { FIGURE_CAPTION, TABLE_CAPTION } from "./figures.ts";
import { findTableBlocks } from "./tables.ts";
import { type Rule, warn } from "./types.ts";

const ANY_CAPTION = new RegExp(`^\\s*(?:${FIGURE_CAPTION}|${TABLE_CAPTION})\\s*(.*)$`);
/** Only figure markers: a table caption marker must not be consumed by an earlier image. */
const FIGURE_MARKER = new RegExp(`^\\s*${FIGURE_CAPTION}\\s*(.*)$`);

/** `**Title.** rest` → `**Figure 3 | Title.** rest` (an existing caption label is replaced). */
export function labelCaption(kind: "Figure" | "Table", number: number, raw: string): string {
	const label = `**${kind} ${number} | `;
	let text = raw
		.replace(new RegExp(`${FIGURE_CAPTION}|${TABLE_CAPTION}`, "g"), "")
		.replace(/\s*\{#[^}]*\}/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// strip a leading label, keeping the bold span it lived in
	const boldLabelled = /^\*\*(?:Figure|Table)\s*\d+\s*\|\s*([\s\S]*?)\*\*([\s\S]*)$/.exec(text);
	if (boldLabelled) return `${label}${(boldLabelled[1] ?? "").trim()}**${boldLabelled[2] ?? ""}`;

	const plainLabelled = /^(?:Figure|Table)\s*\d+\s*\|\s*([\s\S]*)$/.exec(text);
	if (plainLabelled) text = (plainLabelled[1] ?? "").trim();

	const bold = /^\*\*([\s\S]*?)\*\*([\s\S]*)$/.exec(text);
	if (bold) return `${label}${(bold[1] ?? "").trim()}**${bold[2] ?? ""}`;

	return `${label}${text}**`;
}

function isImageLine(line: string): boolean {
	return /!\[[^\]]*\]\([^)]+\)/.test(line);
}

function isBoldParagraph(line: string): boolean {
	const trimmed = line.trim();
	return /^\*\*[^*].*\*\*/.test(trimmed) && !/^\*\*\|/.test(trimmed);
}

export const captionsRule: Rule = {
	id: "captions",
	description: "renumber captions by document order and restore dropped ones",
	run(state) {
		const lines = state.markdown.split("\n");

		// ---- figures -------------------------------------------------------
		const imageLines: number[] = [];
		lines.forEach((line, index) => {
			if (isImageLine(line)) imageLines.push(index);
		});

		const consumed = new Set<number>();
		const insertAfter: Array<{ line: number; text: string }> = [];

		imageLines.forEach((lineIndex, ordinal) => {
			const number = ordinal + 1;
			const limit = imageLines[ordinal + 1] ?? lines.length;
			let captionLine = -1;
			for (let i = lineIndex + 1; i < limit; i++) {
				if (FIGURE_MARKER.test(lines[i] ?? "")) {
					captionLine = i;
					break;
				}
			}
			if (captionLine >= 0) {
				const match = FIGURE_MARKER.exec(lines[captionLine] ?? "");
				consumed.add(captionLine);
				lines[captionLine] = labelCaption("Figure", number, match?.[1] ?? "");
				return;
			}
			const fromTex = state.analysis.figureCaptions[ordinal];
			if (fromTex) {
				insertAfter.push({ line: lineIndex, text: labelCaption("Figure", number, fromTex) });
				state.stats.figuresRecovered++;
				warn(state, "captions", `Figure ${number} caption restored from LaTeX source (pandoc dropped it)`);
			} else {
				warn(state, "captions", `image ${ordinal + 1} has no caption in the Markdown or the LaTeX source`, "warn");
			}
		});

		for (const insertion of insertAfter.reverse()) {
			lines.splice(insertion.line + 1, 0, "", insertion.text);
		}

		state.markdown = lines.join("\n");

		// ---- tables --------------------------------------------------------
		const tableLines = state.markdown.split("\n");
		const blocks = findTableBlocks(tableLines);
		const fixes: Array<{ line: number; text: string }> = [];
		const inserts: Array<{ line: number; text: string }> = [];

		blocks.forEach((block, ordinal) => {
			const number = ordinal + 1;
			let captionLine = -1;
			for (let i = block.endLine + 1; i < Math.min(block.endLine + 6, tableLines.length); i++) {
				const line = tableLines[i] ?? "";
				if (!line.trim()) continue;
				if (ANY_CAPTION.test(line) || isBoldParagraph(line)) {
					captionLine = i;
				}
				break;
			}
			const fromMarkdown =
				captionLine >= 0 ? (ANY_CAPTION.exec(tableLines[captionLine] ?? "")?.[1] ?? tableLines[captionLine] ?? "") : undefined;
			const fromTex = state.analysis.tableCaptions[ordinal];
			const raw = fromMarkdown && fromMarkdown.trim().length > 3 ? fromMarkdown : fromTex;
			if (!raw) {
				warn(state, "captions", `table ${number} has no caption in the Markdown or the LaTeX source`, "warn");
				return;
			}
			if (captionLine >= 0) fixes.push({ line: captionLine, text: labelCaption("Table", number, raw) });
			else {
				inserts.push({ line: block.endLine, text: labelCaption("Table", number, raw) });
				warn(state, "captions", `Table ${number} caption inserted from LaTeX source`);
			}
		});

		for (const fix of fixes) tableLines[fix.line] = fix.text;
		for (const insert of inserts.reverse()) tableLines.splice(insert.line + 1, 0, "", insert.text);
		state.markdown = tableLines.join("\n");
		state.stats.tables = findTableBlocks(tableLines).length;
	},
};
