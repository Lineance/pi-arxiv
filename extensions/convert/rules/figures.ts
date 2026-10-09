/**
 * Figures: unwrap pandoc's float HTML, point images at PNGs, rasterize figure PDFs.
 *
 * pandoc keeps the LaTeX float id on <figure id="fig:x">/<figure id="tab:x">,
 * which is how we tell a figure caption from a table caption that LaTeX placed
 * inside a figure float (the `\captionsetup{type=table}` idiom).
 */

import { basename, extname, isAbsolute, join, relative } from "node:path";
import { ensureDir, exists } from "../../util/fsx.ts";
import { probeTool } from "../../util/toolchain.ts";
import { type ConvertState, type Rule, warn } from "./types.ts";

export const FIGURE_CAPTION = "@@CAPTION@@";
export const TABLE_CAPTION = "@@TCAPTION@@";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

interface ImageRef {
	full: string;
	texPath: string;
}

function captionText(raw: string): string {
	return (
		raw
			// pandoc's HTML fallback carries MathML: <mi>±</mi> plus a TeX annotation.
			// Prefer the TeX annotation, otherwise dropping the tags would keep both.
			.replace(
				/<math\b[^>]*>[\s\S]*?<annotation[^>]*encoding="application\/x-tex"[^>]*>([\s\S]*?)<\/annotation>[\s\S]*?<\/math>/g,
				(_match, tex: string) => `$${tex.trim()}$`,
			)
			.replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/g, "")
			.replace(/<strong>([\s\S]*?)<\/strong>/g, "**$1**")
			.replace(/<em>([\s\S]*?)<\/em>/g, "*$1*")
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

function markerFor(attrs: string): string {
	const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? "";
	return id.startsWith("tab:") ? TABLE_CAPTION : FIGURE_CAPTION;
}

function unwrapFloats(markdown: string): string {
	// 1) complete float with a caption → body, blank line, caption marker
	let text = markdown.replace(
		/<figure\b([^>]*)>([\s\S]*?)<figcaption>([\s\S]*?)<\/figcaption>\s*<\/figure>/g,
		(_match, attrs: string, body: string, caption: string) => `${body.trim()}\n\n${markerFor(attrs)} ${captionText(caption)}\n`,
	);
	// 2) leftover <figure> wrappers (caption lost or never present)
	text = text
		.replace(/<figure\b([^>]*)>\s*/g, (_match, attrs: string) => `${markerFor(attrs)}\n`)
		.replace(/<\/figure>\s*/g, "")
		.replace(/<figcaption>([\s\S]*?)<\/figcaption>/g, (_match, body: string) => `${captionText(body)}\n`)
		// 3) pandoc's embed/img output → plain Markdown images
		.replace(/<embed\s+src="([^"]+)"\s*\/?>/g, (_match, src: string) => `![](${src})`)
		.replace(/<img\s+src="([^"]+)"[^>]*\/?>/g, (_match, src: string) => `![](${src})`)
		// 4) minipage width remnants like `r0.50 ![](…)` and `{width=90%}` attributes
		.replace(/^[ \t]*(?:r|c|l|R|C|L)?[0-9.]+[ \t]+(?=!\[)/gm, "")
		.replace(/(!\[[^\]]*\]\([^)]+\))\{[^}]*\}/g, "$1");

	// 5) a marker on its own line directly before an image belongs after it
	text = text.replace(new RegExp(`(${FIGURE_CAPTION}|${TABLE_CAPTION})\\n(!\\[[^\\]]*\\]\\([^)]+\\))\\n`, "g"), "$2\n\n$1\n");
	return text;
}

function collectImages(markdown: string): string[] {
	const out: string[] = [];
	for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
		if (match[1]) out.push(match[1]);
	}
	return out;
}

async function rasterize(state: ConvertState, images: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (!state.renderFigures) return map;

	const pending: ImageRef[] = [];
	for (const image of new Set(images)) {
		if (/^(?:https?:|data:)/.test(image)) continue;
		const texPath = image.replace(/^(figures|figs|images)\/png\//, "$1/");
		const extension = extname(texPath).toLowerCase();
		if (extension !== ".pdf") {
			if (IMAGE_EXT.has(extension)) continue;
			const withPdf = `${texPath}.pdf`;
			if (await exists(isAbsolute(withPdf) ? withPdf : join(state.workDir, withPdf))) {
				pending.push({ full: isAbsolute(withPdf) ? withPdf : join(state.workDir, withPdf), texPath: withPdf });
			}
			continue;
		}
		const full = isAbsolute(texPath) ? texPath : join(state.workDir, texPath);
		if (await exists(full)) pending.push({ full, texPath });
	}
	if (pending.length === 0) return map;

	const status = await probeTool(state.io.exec, { name: "pdftoppm", args: ["-v"], hint: "rasterizes figure PDFs to PNG" }, state.signal);
	if (!status.available) {
		warn(state, "figures", `${pending.length} figure PDF(s) left as .pdf links (pdftoppm not found)`, "warn");
		return map;
	}

	const outDir = join(state.outDir, "figures", "png");
	await ensureDir(outDir);
	let rendered = 0;
	for (const image of pending) {
		const target = join(outDir, `${basename(image.texPath, extname(image.texPath))}.png`);
		if (!(await exists(target))) {
			const result = await state.io.exec(
				"pdftoppm",
				["-png", "-r", String(state.figureDpi), "-singlefile", image.full, target.replace(/\.png$/, "")],
				{ cwd: state.workDir, signal: state.signal, timeout: 120_000 },
			);
			if (result.code !== 0) {
				warn(state, "figures", `pdftoppm failed for ${image.texPath}: ${result.stderr.trim().split("\n")[0] ?? "unknown error"}`, "warn");
				continue;
			}
		}
		rendered++;
		const relativeTarget = relative(state.outDir, target).split("\\").join("/");
		map.set(`](${image.texPath})`, `](${relativeTarget})`);
		state.figureFiles.push(relativeTarget);
	}
	if (rendered > 0)
		warn(state, "figures", `${rendered} figure PDF(s) rendered to ${relative(state.outDir, outDir).split("\\").join("/")}/`);
	return map;
}

export const figuresRule: Rule = {
	id: "figures",
	description: "unwrap float HTML, rasterize figure PDFs, normalize image links",
	async run(state) {
		state.markdown = unwrapFloats(state.markdown);
		const { map } = { map: await rasterize(state, collectImages(state.markdown)) };
		for (const [from, to] of map) state.markdown = state.markdown.split(from).join(to);
		state.stats.images = collectImages(state.markdown).length;
	},
};
