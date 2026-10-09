/**
 * End-to-end conversion of a real LaTeX paper.
 *
 * The assertions are the invariants the repair rules exist to guarantee; every
 * one of them corresponds to a failure mode observed while building the
 * converter. The golden file is a snapshot, so `vitest -u` refreshes it and a
 * diff shows exactly what changed.
 *
 * Point PI_ARXIV_FIXTURE_SOURCE at another LaTeX source directory to retarget.
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { childProcessExec, convertSourceDir, summarizeStats } from "../extensions/convert/convert.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Checked in, so the end-to-end path is covered everywhere, CI included. */
const MINI = join(HERE, "fixtures", "mini-paper");
/** An external full-size paper; opt-in because it is not in the repository. */
const SOURCE = process.env["PI_ARXIV_FIXTURE_SOURCE"] ?? "D:/Code/Research/opd/papers/og-opd";
const OUT = join(HERE, "_out");
const GOLDEN = join(HERE, "..", "fixtures", "2609.35319", "expected.md");

/**
 * These tests are about the rule pipeline, so they must always run it.
 *
 * Without `cache: false` a second `npm test` would hit the cache left by the
 * first and skip every rule: the suite would still pass while silently stopping
 * to test the thing it exists for.
 */
const CONVERT = { cache: false } as const;

beforeAll(async () => {
	// Outputs persist between runs; clear them so nothing is read back by accident.
	await rm(OUT, { recursive: true, force: true });
});

/** Each pattern is something the converter must never emit again. */
const FORBIDDEN: Array<[RegExp, string]> = [
	[/\{#(?:tab|fig|eq|sec|app):[^}]*\}/, "LaTeX label attributes"],
	[/<figure\b|<figcaption\b|<table>|<tr>/, "raw float/table HTML"],
	[/data-reference=/, "unresolved pandoc reference anchors"],
	[/<span\s+(?:class|id)=/, "HTML spans"],
	[/<math\b|application\/x-tex/, "MathML"],
	[/±\\pm|\\pm±/, "duplicated ± (MathML glyph plus TeX annotation)"],
	[/\\begin\{equation\}|\\label\{/, "LaTeX equation environments"],
	[/@@CAPTION@@|@@TCAPTION@@/, "unconsumed caption markers"],
	[/\b(?:sec|fig|tab|eq|app):[a-z][\w-]*/, "unresolved label tokens"],
	[/\u00a0/, "non-breaking spaces"],
	[/\\ref\{|\\citep?\{/, "unresolved LaTeX commands"],
];

/** Each pattern is a property the output must have to be usable. */
const REQUIRED: Array<[RegExp, string]> = [
	[/^---\ntitle: "/, "YAML front matter"],
	[/^#\s+\S/m, "title heading"],
	[/^## Abstract$/m, "abstract section"],
	[/^# References$/m, "bibliography section"],
	[/^# 1 Introduction$/m, "numbered introduction"],
	[/^## 3\.1 Empirical Analysis$/m, "numbered subsection"],
	[/^# Appendix A\./m, "appendix heading"],
	[/\*\*Figure 1 \| /, "Figure 1 caption"],
	[/\*\*Figure 5 \| /, "Figure 5 caption"],
	[/\*\*Table 1 \| /, "Table 1 caption"],
	[/\*\*Table 6 \| /, "Table 6 caption"],
	[/^\|\s*\*{0,2}Method\*{0,2}\s*\|/m, "rebuilt main results table"],
	[/26\.7 ± 3\.0/, "± values survive table rebuilding"],
	[/\*\*ALFWorld\*\* Seen SR/, "merged two-level table header"],
	[/\*\*Table 6 \| Training cost/, "table caption renumbered from the LaTeX counter"],
	[/^\$\$\n\\begin\{aligned\}/m, "KaTeX-safe aligned display math"],
	[/Figure 3 illustrates/, "fig:method resolves to Figure 3"],
	[/Equation 13/, "eq:gate resolves to Equation 13"],
	[/Appendix D\.2/, "app:details resolves to Appendix D.2"],
];

describe("the checked-in mini paper", () => {
	/** Converted once: the assertions below are all about the same document. */
	let markdown = "";

	beforeAll(async () => {
		const result = await convertSourceDir(
			{ workDir: MINI, outFile: join(OUT, "mini.md"), figures: false, ...CONVERT },
			{ exec: childProcessExec },
		);
		expect(result.ok, result.warnings[0]?.message).toBe(true);
		markdown = await readFile(result.markdownPath as string, "utf8");
	});

	it("emits no LaTeX or raw HTML", () => {
		for (const [pattern, name] of FORBIDDEN) {
			expect(pattern.test(markdown), `must not contain ${name}`).toBe(false);
		}
	});

	it("restores the abstract that the custom environment hides from pandoc", () => {
		expect(markdown).toMatch(/^## Abstract$/m);
		expect(markdown).toContain("We test a converter on");
	});

	it("numbers headings from the LaTeX outline, including the appendix", () => {
		expect(markdown).toMatch(/^# 1 Introduction$/m);
		expect(markdown).toMatch(/^# 2 Method$/m);
		expect(markdown).toMatch(/^# Appendix A\. Proofs$/m);
		// "A lemma" starts with a capital letter, which a shape-based heuristic
		// would mistake for an existing appendix number.
		expect(markdown).toMatch(/^## A\.1 A lemma$/m);
	});

	it("resolves every reference kind to the LaTeX counter", () => {
		expect(markdown).toContain("See Section 2, Table 1, Figure 1 and Equation 1.");
	});

	it("merges a two-level header that uses \\multirow and \\multicolumn", () => {
		// The group label must be carried into each sub-column, and the first data
		// row must survive: an earlier version swallowed it into the header.
		expect(markdown).toContain("| **Method** | **Benchmark** Success | **Benchmark** Rounds |");
		expect(markdown).toContain("| Baseline | 20.1 ± 2.1 | 17.7 |");
		expect(markdown).toContain("| **Ours** | **24.2 ± 1.5** | 18.0 |");
	});

	it("numbers a caption forced into the table counter inside a figure float", () => {
		expect(markdown).toContain("**Table 2 | Forced table caption.**");
	});

	it("keeps display math KaTeX-safe", () => {
		expect(markdown).toMatch(/^\$\$$/m);
		expect(markdown).not.toMatch(/\\begin\{align\}/);
	});

	it("flattens the bibliography into a list", () => {
		expect(markdown).toMatch(/^# References$/m);
		expect(markdown).toMatch(/^- Example, Alice, and Bob Other\. 2026\. "An Example Reference\."/m);
	});
});

describe.skipIf(!existsSync(SOURCE))("converting a real paper", () => {
	it("produces Markdown that satisfies every invariant", async () => {
		const result = await convertSourceDir(
			{ workDir: SOURCE, outFile: join(OUT, "fixture.md"), figures: true, tableMode: "gfm", ...CONVERT },
			{ exec: childProcessExec },
		);

		expect(result.ok, summarizeStats(result.stats)).toBe(true);
		expect(result.markdownPath).toBeDefined();
		const markdown = await readFile(result.markdownPath as string, "utf8");

		for (const [pattern, name] of FORBIDDEN) {
			expect(pattern.test(markdown), `must not contain ${name}`).toBe(false);
		}
		for (const [pattern, name] of REQUIRED) {
			expect(pattern.test(markdown), `must contain ${name}`).toBe(true);
		}
	});

	it("reports what it had to repair", async () => {
		const result = await convertSourceDir(
			{ workDir: SOURCE, outFile: join(OUT, "fixture-stats.md"), figures: true, ...CONVERT },
			{ exec: childProcessExec },
		);

		expect(result.figures.length).toBeGreaterThanOrEqual(4);
		expect(result.stats.tablesRebuilt).toBeGreaterThanOrEqual(3);
		expect(result.stats.figuresRecovered).toBeGreaterThanOrEqual(2);
		expect(result.stats.refs).toBeGreaterThanOrEqual(25);
		expect(result.stats.equations).toBeGreaterThanOrEqual(40);
	});

	it("matches the golden Markdown", async () => {
		const result = await convertSourceDir(
			{ workDir: SOURCE, outFile: join(OUT, "golden.md"), figures: true, ...CONVERT },
			{ exec: childProcessExec },
		);
		const markdown = await readFile(result.markdownPath as string, "utf8");

		await expect(markdown).toMatchFileSnapshot(GOLDEN);
	});
});
