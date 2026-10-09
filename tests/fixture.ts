/**
 * End-to-end fixture: convert a real LaTeX paper directory and assert the
 * invariants that the post-processing rules exist to guarantee.
 *
 * The source is configurable so the suite is not tied to one machine:
 *   PI_ARXIV_FIXTURE_SOURCE=/path/to/paper node --experimental-strip-types tests/fixture.ts
 *
 * With `--write` the produced Markdown is stored as `fixtures/<id>/expected.md`.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { convertSourceDir, summarizeStats, summarizeWarnings } from "../extensions/convert/convert.ts";
import { check, fixtureSource, HERE, OUT_DIR, runWithExec } from "./harness.ts";

const golden = join(HERE, "fixtures", "2609.35319", "expected.md");

/** Things that must never appear: each one was an observed failure mode. */
const FORBIDDEN: Array<[RegExp, string]> = [
	[/\{#(?:tab|fig|eq|sec|app):[^}]*\}/, "leftover LaTeX label attributes"],
	[/<figure\b|<figcaption\b|<table>|<tr>/, "raw float/table HTML"],
	[/data-reference=/, "unresolved pandoc reference anchors"],
	[/<span\s+(?:class|id)=/, "HTML spans"],
	[/\\begin\{equation\}|\\label\{/, "LaTeX equation environments"],
	[/@@CAPTION@@|@@TCAPTION@@/, "unconsumed caption markers"],
	[/\b(?:sec|fig|tab|eq|app):[a-z][\w-]*/, "unresolved label tokens"],
	[/\u00a0/, "non-breaking spaces"],
	[/\\ref\{|\\citep?\{/, "unresolved LaTeX commands"],
];

/** Things that must appear for the document to be usable. */
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
	[/^\$\$\n\\begin\{aligned\}/m, "KaTeX-safe aligned display math"],
	[/Figure 3 illustrates/, "fig:method resolves to Figure 3"],
	[/Equation 13/, "eq:gate resolves to Equation 13"],
	[/Appendix D\.2/, "app:details resolves to Appendix D.2"],
];

export async function runFixture(write: boolean): Promise<void> {
	if (!existsSync(fixtureSource)) {
		console.log(`fixture: skipped (source not found: ${fixtureSource})`);
		console.log("  set PI_ARXIV_FIXTURE_SOURCE to a LaTeX source directory to enable it");
		return;
	}

	await mkdir(OUT_DIR, { recursive: true });
	const outFile = join(OUT_DIR, "fixture.md");
	const result = await convertSourceDir({ workDir: fixtureSource, outFile, figures: true, tableMode: "gfm" }, { exec: runWithExec });

	check("fixture conversion succeeds", result.ok, summarizeWarnings(result.warnings, 5).join(" | "));
	if (!result.ok || !result.markdownPath) return;

	const markdown = await readFile(result.markdownPath, "utf8");
	for (const [pattern, name] of FORBIDDEN) check(`fixture: no ${name}`, !pattern.test(markdown), pattern.exec(markdown)?.[0]?.slice(0, 60));
	for (const [pattern, name] of REQUIRED) check(`fixture: has ${name}`, pattern.test(markdown));

	check("fixture: figures rendered", result.figures.length >= 4, result.figures.length);
	check("fixture: tables rebuilt", result.stats.tablesRebuilt >= 3, result.stats.tablesRebuilt);
	check("fixture: captions recovered", result.stats.figuresRecovered >= 2, result.stats.figuresRecovered);
	check("fixture: references parsed", result.stats.refs >= 25, result.stats.refs);
	check("fixture: equations normalized", result.stats.equations >= 40, result.stats.equations);

	if (write) {
		await mkdir(dirname(golden), { recursive: true });
		await writeFile(golden, markdown, "utf8");
		console.log(`fixture: wrote golden ${golden}`);
	} else if (existsSync(golden)) {
		const expected = await readFile(golden, "utf8");
		check("fixture: matches golden byte-for-byte", expected === markdown, summariseDiff(expected, markdown));
	}

	console.log(`fixture: ${summarizeStats(result.stats)}`);
	for (const line of summarizeWarnings(result.warnings, 8)) console.log(`  ${line}`);
}

function summariseDiff(expected: string, actual: string): string {
	const a = expected.split("\n");
	const b = actual.split("\n");
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i])
			return `line ${i + 1}: expected ${JSON.stringify((a[i] ?? "").slice(0, 80))}, got ${JSON.stringify((b[i] ?? "").slice(0, 80))}`;
	}
	return "length differs";
}
