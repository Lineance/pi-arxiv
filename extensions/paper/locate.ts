/**
 * Locating a paper's converted Markdown on disk.
 *
 * Kept separate from the tool so path resolution can be tested without the tool
 * plumbing, and so both `paper_section` and any future reader share one rule.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { listDir } from "../util/fsx.ts";

export interface LocateResult {
	markdownPath?: string | undefined;
	/** Where the search looked, for an actionable failure message. */
	searched: string[];
}

/**
 * Find the Markdown for a paper.
 *
 * Accepts an explicit file, a paper directory, or a corpus root plus id. The
 * layout the converter writes is `<papersDir>/<id>/source/<id>.md`, but an
 * explicit path always wins so a hand-edited copy can be read.
 */
export async function locateMarkdown(input: {
	source?: string | undefined;
	id?: string | undefined;
	papersDir: string;
	cwd: string;
}): Promise<LocateResult> {
	const searched: string[] = [];

	/** Accept a path only when it is an existing *file*: a directory is not a result. */
	const considerFile = (candidate: string): string | undefined => {
		const full = resolve(input.cwd, candidate);
		searched.push(full);
		return isFile(full) ? full : undefined;
	};

	if (input.source) {
		// An explicit path is either the file itself or a directory containing it.
		const direct = considerFile(input.source);
		if (direct) return { markdownPath: direct, searched };

		const dir = resolve(input.cwd, input.source);
		const found = await firstMarkdownIn(dir);
		if (found) return { markdownPath: found, searched };
		return { searched };
	}

	if (input.id) {
		const paperDir = join(input.papersDir, input.id);
		const fromSource = await firstMarkdownIn(join(paperDir, "source"));
		if (fromSource) return { markdownPath: fromSource, searched };

		const named = considerFile(join(paperDir, "source", `${input.id}.md`));
		if (named) return { markdownPath: named, searched };

		const fromPaperDir = await firstMarkdownIn(paperDir);
		if (fromPaperDir) return { markdownPath: fromPaperDir, searched };
	}

	return { searched };
}

/** True only for an existing regular file. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/** The first `.md` in a directory, preferring one named after the directory. */
async function firstMarkdownIn(dir: string): Promise<string | undefined> {
	if (!existsSync(dir)) return undefined;
	const entries = await listDir(dir);
	const markdown = entries.filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".md"));
	const preferred = markdown.find((entry) => entry.name.toLowerCase() === `${dir.split(/[\\/]/).pop()?.toLowerCase()}.md`);
	return (preferred ?? markdown[0])?.path;
}
