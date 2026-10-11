import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { childProcessExec, convertSourceDir } from "../extensions/convert/convert.ts";
import type { ExecLike } from "../extensions/types.ts";
import { detectToolchain } from "../extensions/util/toolchain.ts";

const MINI = fileURLToPath(new URL("./fixtures/mini-paper", import.meta.url));
let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi-arxiv-cancel-"));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("conversion cancellation", () => {
	it("stops the rule pipeline when cancellation arrives between Pandoc and rules", async () => {
		const controller = new AbortController();
		const exec: ExecLike = async (_command, args) => {
			if (args.includes("--version")) return { stdout: "pandoc 3.1", stderr: "", code: 0 };
			return { stdout: "plain text", stderr: "", code: 0 };
		};
		const outFile = join(root, "paper.md");
		let loggedRules = 0;

		await expect(
			convertSourceDir(
				{ workDir: MINI, outFile, force: true },
				{
					exec,
					signal: controller.signal,
					log: () => {
						loggedRules++;
						controller.abort();
					},
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(loggedRules).toBe(1);
		expect(existsSync(outFile)).toBe(false);
		expect(existsSync(`${outFile}.cache.json`)).toBe(false);
	});

	it("removes partial raster output when a figure process is aborted", async () => {
		await detectToolchain(childProcessExec);
		const sourceDir = join(root, "source");
		await mkdir(sourceDir, { recursive: true });
		await writeFile(join(sourceDir, "main.tex"), "\\documentclass{article}\\begin{document}x\\end{document}");
		await writeFile(join(sourceDir, "one.pdf"), "%PDF");
		const controller = new AbortController();
		const exec: ExecLike = async (command, args) => {
			if (command === "pandoc") return { stdout: "![](one.pdf)", stderr: "", code: 0 };
			if (command === "pdftoppm") {
				const outputPrefix = args.at(-1);
				if (outputPrefix) await writeFile(`${outputPrefix}.png`, "partial image");
				controller.abort();
				return { stdout: "", stderr: "terminated", code: 1 };
			}
			throw new Error(`unexpected command: ${command}`);
		};
		const outFile = join(root, "paper.md");
		const pngDir = join(root, "figures", "png");

		await expect(convertSourceDir({ workDir: sourceDir, outFile, force: true }, { exec, signal: controller.signal })).rejects.toMatchObject(
			{ name: "AbortError" },
		);
		expect(await readdir(pngDir)).toEqual([]);
		expect(existsSync(outFile)).toBe(false);
		expect(existsSync(`${outFile}.cache.json`)).toBe(false);
	});

	it("does not start toolchain work when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const exec: ExecLike = async () => {
			throw new Error("exec must not run");
		};
		const outFile = join(root, "paper.md");

		await expect(convertSourceDir({ workDir: MINI, outFile }, { exec, signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(existsSync(outFile)).toBe(false);
		expect(existsSync(`${outFile}.cache.json`)).toBe(false);
	});

	it("does not write Markdown or cache when Pandoc is aborted", async () => {
		const controller = new AbortController();
		const exec: ExecLike = async (_command, args) => {
			if (args.includes("--version")) return { stdout: "pandoc 3.1", stderr: "", code: 0 };
			controller.abort();
			return { stdout: "partial output", stderr: "", code: 0 };
		};
		const outFile = join(root, "paper.md");

		await expect(convertSourceDir({ workDir: MINI, outFile, force: true }, { exec, signal: controller.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(existsSync(outFile)).toBe(false);
		expect(existsSync(`${outFile}.cache.json`)).toBe(false);
	});
});

describe("childProcessExec termination", () => {
	it("rejects after aborting and reaping the child", async () => {
		const controller = new AbortController();
		const pending = childProcessExec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
		setTimeout(() => controller.abort(), 30);

		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	});

	it("reports a timeout as a terminated, non-successful process", async () => {
		const result = await childProcessExec(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 30 });

		expect(result).toMatchObject({ code: 124, killed: true });
	});
});
