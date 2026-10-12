/**
 * Outline parsing and section extraction: pure string handling, no filesystem.
 */

import { describe, expect, it } from "vitest";
import {
	extractSection,
	formatTableOfContents,
	type Outline,
	parseOutline,
	selectSection,
	tableOfContents,
} from "../extensions/paper/outline.ts";

const PAPER = `---
title: "A Paper"
---

# A Paper

## Abstract

Short abstract.

# 1 Introduction

Intro text.

# 2 Method

## 2.1 Empirical Analysis

We analyse paired continuations.

### 2.1.1 Details

More detail.

## 2.2 Weighting

Weights.

# 3 Experiments

Results.

# Appendix A. Proofs

\`\`\`sh
# this is a shell comment, not a heading
echo hi
\`\`\`

## A.1 A lemma

Statement.

# References

- Someone. 2026.
`;

function outlineOf(markdown = PAPER): Outline {
	return parseOutline(markdown);
}

describe("parseOutline", () => {
	const outline = outlineOf();

	it("finds every heading with its level", () => {
		expect(outline.headings.map((heading) => `${heading.level}:${heading.title}`)).toEqual([
			"1:A Paper",
			"2:Abstract",
			"1:1 Introduction",
			"1:2 Method",
			"2:2.1 Empirical Analysis",
			"3:2.1.1 Details",
			"2:2.2 Weighting",
			"1:3 Experiments",
			"1:Appendix A. Proofs",
			"2:A.1 A lemma",
			"1:References",
		]);
	});

	it("extracts the document number when present", () => {
		const numbers = outline.headings.map((heading) => heading.number);
		expect(numbers).toContain("1");
		expect(numbers).toContain("2.1");
		expect(numbers).toContain("2.1.1");
		expect(numbers).toContain("Appendix A");
		expect(numbers).toContain("A.1");
	});

	it("leaves unnumbered headings without a number", () => {
		expect(outline.headings.find((heading) => heading.title === "Abstract")?.number).toBeUndefined();
		expect(outline.headings.find((heading) => heading.title === "References")?.number).toBeUndefined();
	});

	it("ignores a comment inside a fenced code block", () => {
		expect(outline.headings.some((heading) => heading.title.includes("shell comment"))).toBe(false);
	});

	it("does not treat an inline hash as a heading", () => {
		const outline = outlineOf("# Title\n\nSee issue #42 and #  not a heading either.\n");
		expect(outline.headings).toHaveLength(1);
	});

	it("gives a section everything up to the next heading of the same level", () => {
		const method = outline.headings.find((heading) => heading.title === "2 Method");
		const experiments = outline.headings.find((heading) => heading.title === "3 Experiments");
		expect(method?.endLine).toBe(experiments?.startLine);
	});

	it("gives a subsection only up to its sibling", () => {
		const first = outline.headings.find((heading) => heading.title === "2.1 Empirical Analysis");
		const second = outline.headings.find((heading) => heading.title === "2.2 Weighting");
		// Includes 2.1.1, which is nested inside it.
		expect(first?.endLine).toBe(second?.startLine);
	});

	it("handles a document with no headings", () => {
		expect(parseOutline("just prose\n").headings).toEqual([]);
		expect(formatTableOfContents(parseOutline("just prose\n"))).toContain("no Markdown headings");
	});

	it("handles an empty document", () => {
		expect(parseOutline("").headings).toEqual([]);
	});
});

describe("tableOfContents", () => {
	it("reports each section's size including children", () => {
		const entries = tableOfContents(outlineOf());
		const method = entries.find((entry) => entry.title === "2 Method");
		// 2 Method owns 2.1, 2.1.1 and 2.2, so it is larger than 2.1 alone.
		const empirical = entries.find((entry) => entry.title === "2.1 Empirical Analysis");
		expect(method?.lines ?? 0).toBeGreaterThan(empirical?.lines ?? 0);
	});

	it("renders an indented list with numbers and sizes", () => {
		const text = formatTableOfContents(outlineOf());
		expect(text).toMatch(/2\.1\s+Empirical Analysis\s+\(\d+ lines\)/);
		expect(text).toMatch(/^ {2}A\.1\s+A lemma/m);
	});
});

describe("selectSection", () => {
	const outline = outlineOf();

	it("finds a section by its number", () => {
		const result = selectSection(outline, "2.1");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(result.heading.title).toBe("2.1 Empirical Analysis");
		expect(result.how).toBe("number");
	});

	it("finds an appendix by letter and by number", () => {
		expect(selectSection(outline, "A.1").kind).toBe("found");
		expect(selectSection(outline, "Appendix A").kind).toBe("found");
	});

	it("accepts a leading hash", () => {
		expect(selectSection(outline, "#2.2").kind).toBe("found");
	});

	it("finds a section by its full title", () => {
		const result = selectSection(outline, "Empirical Analysis");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(result.heading.number).toBe("2.1");
	});

	it("ignores case when matching a title", () => {
		expect(selectSection(outline, "empirical analysis").kind).toBe("found");
	});

	it("finds a section by a fragment of its title", () => {
		const result = selectSection(outline, "weight");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(result.heading.number).toBe("2.2");
		expect(result.how).toBe("partial");
	});

	it("prefers an exact title over a partial one", () => {
		// "Experiments" is contained in "3 Experiments" but is also exact.
		const result = selectSection(outline, "Experiments");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(result.how).toBe("title");
	});

	it("reports ambiguity instead of guessing", () => {
		// Neither title equals "alpha", so both are partial matches and the resolver
		// must not pick one arbitrarily.
		const ambiguous = parseOutline("# 1 Alpha Beta\n\n# 2 Alpha Gamma\n");
		const result = selectSection(ambiguous, "alpha");
		expect(result.kind).toBe("ambiguous");
		if (result.kind !== "ambiguous") return;
		expect(result.candidates).toHaveLength(2);
	});

	it("prefers the exact match over a partial one", () => {
		const outline = parseOutline("# 1 Alpha Beta\n\n# 2 Alpha\n");
		const result = selectSection(outline, "alpha");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(result.heading.title).toBe("2 Alpha");
	});

	it("suggests nearby sections when nothing matches", () => {
		const result = selectSection(outline, "quantum entanglement");
		expect(result.kind).toBe("missing");
		if (result.kind !== "missing") return;
		expect(result.suggestions.length).toBeGreaterThan(0);
	});

	it("suggests headings sharing a word with the query", () => {
		const result = selectSection(outline, "empirical whatever");
		expect(result.kind).toBe("missing");
		if (result.kind !== "missing") return;
		expect(result.suggestions[0]?.title).toContain("Empirical");
	});

	it("handles an empty selector", () => {
		expect(selectSection(outline, "  ").kind).toBe("missing");
	});
});

describe("extractSection", () => {
	const outline = outlineOf();
	const find = (title: string) => {
		const heading = outline.headings.find((candidate) => candidate.title === title);
		if (!heading) throw new Error(`no heading ${title}`);
		return heading;
	};

	it("includes the heading line itself", () => {
		expect(extractSection(outline, find("2.2 Weighting"))).toMatch(/^## 2\.2 Weighting/);
	});

	it("includes nested subsections by default", () => {
		const text = extractSection(outline, find("2 Method"));
		expect(text).toContain("2.1 Empirical Analysis");
		expect(text).toContain("2.1.1 Details");
		expect(text).toContain("2.2 Weighting");
	});

	it("stops at the first child when subsections are excluded", () => {
		const text = extractSection(outline, find("2 Method"), { includeSubsections: false });
		expect(text).toContain("2 Method");
		expect(text).not.toContain("2.1 Empirical Analysis");
	});

	it("stops before the next sibling section", () => {
		const text = extractSection(outline, find("2.1 Empirical Analysis"));
		expect(text).toContain("More detail.");
		expect(text).not.toContain("Weights.");
	});

	it("returns a leaf section on its own", () => {
		const text = extractSection(outline, find("A.1 A lemma"));
		expect(text).toBe("## A.1 A lemma\n\nStatement.");
	});

	it("truncates at a line boundary and says so", () => {
		const text = extractSection(outline, find("2 Method"), { maxBytes: 128 });
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(128);
		expect(text).toContain("Truncated at 128 bytes");
		expect(text).toContain("read lines");
	});

	it("keeps Unicode code points intact and counts the notice in the byte limit", () => {
		const markdown = `# Unicode\n\n${"方法🙂 café data ".repeat(100)}`;
		const parsed = parseOutline(markdown);
		const heading = parsed.headings[0];
		if (!heading) throw new Error("missing Unicode heading");

		const text = extractSection(parsed, heading, { maxBytes: 160 });

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(160);
		expect(text).toContain("Truncated at 160 bytes");
		expect(text).not.toContain("�");
	});

	it("clamps unreasonable byte limits to the supported maximum", () => {
		const markdown = `# Long\n\n${"word ".repeat(20_000)}`;
		const parsed = parseOutline(markdown);
		const heading = parsed.headings[0];
		if (!heading) throw new Error("missing long heading");

		const text = extractSection(parsed, heading, { maxBytes: Number.MAX_SAFE_INTEGER });

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64_000);
		expect(text).toContain("Truncated at 64000 bytes");
	});

	it("does not truncate when the section fits", () => {
		const text = extractSection(outline, find("A.1 A lemma"), { maxBytes: 4096 });
		expect(text).not.toContain("truncated");
	});

	it("extracts a section from a real conversion shape", () => {
		// The converter emits "## 3.1 Empirical Analysis" exactly like this.
		const converted = "# 3 Method\n\n## 3.1 Empirical Analysis\n\nBody.\n\n## 3.2 Weighting\n\nOther.\n";
		const parsed = parseOutline(converted);
		const result = selectSection(parsed, "3.1");
		expect(result.kind).toBe("found");
		if (result.kind !== "found") return;
		expect(extractSection(parsed, result.heading)).toBe("## 3.1 Empirical Analysis\n\nBody.");
	});
});
