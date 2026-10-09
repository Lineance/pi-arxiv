/**
 * Conversion cache: reuse exactly when nothing that affects the output changed.
 *
 * The central risk is self-invalidation — the converter writes into the source
 * directory, so if its own outputs are hashed the cache never hits. That case is
 * asserted directly, along with each input that must invalidate.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachePathFor, digestSources, isCacheValid, outputExclusions, readCache } from "../extensions/convert/cache.ts";
import { childProcessExec, convertSourceDir } from "../extensions/convert/convert.ts";
import type { ExecLike, ExecOptionsLike, ExecResultLike } from "../extensions/types.ts";

const LATEX = "\\documentclass{article}\\title{T}\\begin{document}\\section{S}\\label{sec:s}Body.\\section{T2}Two.\\end{document}";

/**
 * Counts real conversions so "was pandoc run again" is observable.
 *
 * `pandoc --version` is a toolchain probe, not a conversion, and the cache
 * legitimately performs one to know whether its entry is still valid.
 */
function countingExec(): { exec: ExecLike; calls: () => number } {
	let count = 0;
	const exec: ExecLike = async (command: string, args: string[], options?: ExecOptionsLike): Promise<ExecResultLike> => {
		if (command === "pandoc" && !args.includes("--version")) count++;
		return await childProcessExec(command, args, options);
	};
	return { exec, calls: () => count };
}

let root: string;
let workDir: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-cache-"));
	workDir = join(root, "paper");
	await mkdir(workDir, { recursive: true });
	await writeFile(join(workDir, "main.tex"), LATEX);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const convert = (exec: ExecLike, extra: Record<string, unknown> = {}) =>
	convertSourceDir({ workDir, outFile: join(workDir, "paper.md"), figures: false, ...extra }, { exec });

describe("source digest", () => {
	it("is stable for unchanged content", async () => {
		const first = await digestSources(workDir);
		expect(await digestSources(workDir)).toBe(first);
	});

	it("changes when a file's content changes", async () => {
		const before = await digestSources(workDir);
		await writeFile(join(workDir, "main.tex"), `${LATEX}\n% a change\n`);
		expect(await digestSources(workDir)).not.toBe(before);
	});

	it("changes when a file is renamed, even with identical bytes", async () => {
		await writeFile(join(workDir, "extra.tex"), "same bytes");
		const before = await digestSources(workDir);
		await rm(join(workDir, "extra.tex"));
		await writeFile(join(workDir, "renamed.tex"), "same bytes");
		expect(await digestSources(workDir)).not.toBe(before);
	});

	it("ignores rendered figures, which the converter itself writes", async () => {
		const before = await digestSources(workDir);
		await mkdir(join(workDir, "figures", "png"), { recursive: true });
		await writeFile(join(workDir, "figures", "png", "plot.png"), "rendered output");
		expect(await digestSources(workDir)).toBe(before);
	});

	it("honours explicit exclusions", async () => {
		await writeFile(join(workDir, "ignored.txt"), "one");
		const before = await digestSources(workDir, ["ignored.txt"]);
		await writeFile(join(workDir, "ignored.txt"), "two");
		expect(await digestSources(workDir, ["ignored.txt"])).toBe(before);
	});

	it("ignores mtime, so a checkout does not invalidate anything", async () => {
		const before = await digestSources(workDir);
		const past = new Date(Date.now() - 86_400_000);
		await utimes(join(workDir, "main.tex"), past, past);
		expect(await digestSources(workDir)).toBe(before);
	});
});

describe("outputExclusions", () => {
	it("excludes the Markdown, its cache and the raw intermediate", () => {
		expect(outputExclusions(join(workDir, "paper.md"), workDir)).toEqual(["paper.md", "paper.md.cache.json", "paper.pandoc.md"]);
	});

	it("excludes nothing when the output is outside the source directory", () => {
		expect(outputExclusions(join(root, "elsewhere.md"), workDir)).toEqual([]);
	});
});

describe("isCacheValid", () => {
	const base = {
		formatVersion: 1,
		convertedAt: "2026-01-01T00:00:00.000Z",
		markdownPath: "paper.md",
		stats: {} as never,
		figures: [],
		warnings: [],
		sourceDigest: "abc",
		toolchain: { pandoc: "3.12", pdftoppm: "24.04" },
		options: { figures: false, figureDpi: 150, tableMode: "gfm" as const, libVersion: "0.1.0" },
	};

	it("accepts an entry whose inputs all match", () => {
		expect(isCacheValid(base, { sourceDigest: "abc", toolchain: base.toolchain, options: base.options })).toBe(true);
	});

	it.each([
		["source digest", { sourceDigest: "different" }],
		["pandoc version", { toolchain: { pandoc: "2.0", pdftoppm: "24.04" } }],
		["table mode", { options: { ...base.options, tableMode: "html" as const } }],
		["figures flag", { options: { ...base.options, figures: true } }],
		["library version", { options: { ...base.options, libVersion: "0.2.0" } }],
	])("rejects a changed %s", (_label, patch) => {
		const inputs = { sourceDigest: "abc", toolchain: base.toolchain, options: base.options, ...patch };
		expect(isCacheValid(base, inputs)).toBe(false);
	});

	it("rejects a different cache format version", () => {
		expect(isCacheValid({ ...base, formatVersion: 99 }, { sourceDigest: "abc", toolchain: base.toolchain, options: base.options })).toBe(
			false,
		);
	});

	it("ignores the pdftoppm version when no figures are rendered", () => {
		const inputs = { sourceDigest: "abc", toolchain: { pandoc: "3.12", pdftoppm: "99.0" }, options: base.options };
		expect(isCacheValid(base, inputs)).toBe(true);
	});

	it("treats a changed figure DPI as invalidating only when figures are rendered", () => {
		const rendered = { ...base, options: { ...base.options, figures: true } };
		const sameDpi = { sourceDigest: "abc", toolchain: base.toolchain, options: rendered.options };
		const otherDpi = { sourceDigest: "abc", toolchain: base.toolchain, options: { ...rendered.options, figureDpi: 300 } };

		expect(isCacheValid(rendered, sameDpi)).toBe(true);
		expect(isCacheValid(rendered, otherDpi)).toBe(false);
	});
});

describe("conversion reuse", () => {
	it("skips the second conversion entirely", async () => {
		const first = countingExec();
		const initial = await convert(first.exec);
		expect(initial.cached).toBeUndefined();
		expect(first.calls()).toBe(1);

		const second = countingExec();
		const again = await convert(second.exec);

		expect(second.calls()).toBe(0);
		expect(again.cached).toBe(true);
		expect(again.markdownPath).toBe(initial.markdownPath);
		expect(again.stats.lines).toBe(initial.stats.lines);
	});

	it("does not invalidate itself by writing the Markdown and cache", async () => {
		// The converter writes into the source directory. If it hashed its own
		// output, the second run would always miss — this is that regression test.
		await convert(childProcessExec);
		expect(existsSync(cachePathFor(join(workDir, "paper.md")))).toBe(true);

		const second = countingExec();
		expect((await convert(second.exec)).cached).toBe(true);
		expect(second.calls()).toBe(0);
	});

	it("reconverts when a source file changes", async () => {
		await convert(childProcessExec);
		await writeFile(join(workDir, "main.tex"), `${LATEX}\n% changed\n`);

		const second = countingExec();
		const again = await convert(second.exec);

		expect(again.cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("reconverts when an option that affects the output changes", async () => {
		await convert(childProcessExec);

		const second = countingExec();
		expect((await convert(second.exec, { tableMode: "html" })).cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("reconverts when the Markdown was deleted", async () => {
		await convert(childProcessExec);
		await rm(join(workDir, "paper.md"));

		const second = countingExec();
		const again = await convert(second.exec);

		expect(again.cached).toBeUndefined();
		expect(existsSync(join(workDir, "paper.md"))).toBe(true);
	});

	it("bypasses the cache when forced", async () => {
		await convert(childProcessExec);

		const second = countingExec();
		expect((await convert(second.exec, { force: true })).cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("can be disabled", async () => {
		await convert(childProcessExec);

		const second = countingExec();
		expect((await convert(second.exec, { cache: false })).cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("reports the reuse as a warning so it is visible in the result", async () => {
		await convert(childProcessExec);
		const again = await convert(childProcessExec);

		expect(again.warnings.some((warning) => warning.rule === "cache" && /reused the conversion/.test(warning.message))).toBe(true);
	});
});

describe("a damaged cache is not a source of truth", () => {
	it("ignores a cache file that is not valid JSON", async () => {
		await convert(childProcessExec);
		await writeFile(cachePathFor(join(workDir, "paper.md")), "{ not json");

		const second = countingExec();
		const again = await convert(second.exec);

		expect(again.ok).toBe(true);
		expect(again.cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("ignores a cache file with the wrong shape", async () => {
		await convert(childProcessExec);
		await writeFile(cachePathFor(join(workDir, "paper.md")), JSON.stringify({ hello: "world" }));

		expect(await readCache(cachePathFor(join(workDir, "paper.md")))).toBeUndefined();
		expect((await convert(countingExec().exec)).cached).toBeUndefined();
	});

	it("ignores an empty cache file", async () => {
		await convert(childProcessExec);
		await writeFile(cachePathFor(join(workDir, "paper.md")), "");

		expect(await readCache(cachePathFor(join(workDir, "paper.md")))).toBeUndefined();
		const second = countingExec();
		expect((await convert(second.exec)).cached).toBeUndefined();
		expect(second.calls()).toBe(1);
	});

	it("records the inputs it used, for inspection", async () => {
		await convert(childProcessExec);
		const entry = await readCache(cachePathFor(join(workDir, "paper.md")));

		expect(entry?.sourceDigest).toHaveLength(64);
		expect(entry?.toolchain.pandoc).toBeTruthy();
		expect(entry?.options.tableMode).toBe("gfm");
		expect(entry?.markdownPath).toContain("paper.md");
	});
});

describe("a failing conversion leaves no cache behind", () => {
	it("does not record an entry when pandoc fails", async () => {
		const failing: ExecLike = vi.fn(async (command: string) => {
			if (command === "pandoc") return { stdout: "", stderr: "boom", code: 1 };
			return await childProcessExec(command, [], undefined);
		});

		const result = await convert(failing);
		expect(result.ok).toBe(false);
		expect(existsSync(cachePathFor(join(workDir, "paper.md")))).toBe(false);
	});

	it("does not record an entry when the source directory is missing", async () => {
		const result = await convertSourceDir({ workDir: join(root, "nope"), outFile: join(root, "nope.md") }, { exec: childProcessExec });
		expect(result.ok).toBe(false);
		expect(existsSync(join(root, "nope.md"))).toBe(false);
	});
});

describe("cache file contents", () => {
	it("is written next to the Markdown and is human-readable", async () => {
		await convert(childProcessExec);
		const raw = await readFile(cachePathFor(join(workDir, "paper.md")), "utf8");

		expect(raw.endsWith("\n")).toBe(true);
		expect(JSON.parse(raw)).toMatchObject({ formatVersion: 1, options: { tableMode: "gfm" } });
	});
});
