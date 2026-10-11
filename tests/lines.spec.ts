/**
 * The diff engine: pure line-level comparison, plus the bounds that keep it
 * predictable on large inputs.
 */

import { describe, expect, it } from "vitest";
import { diffLines, editScript, formatUnified, summarizeDiff, toHunks, toLines } from "../extensions/compare/lines.ts";

const lines = (...items: string[]) => items;

describe("toLines", () => {
	it("splits on LF", () => {
		expect(toLines("a\nb")).toEqual(["a", "b"]);
	});

	it("normalises CRLF, so a Windows checkout is not a diff", () => {
		expect(toLines("a\r\nb\r\n")).toEqual(toLines("a\nb\n"));
	});

	it("treats the newline as a terminator, not a separator", () => {
		// "a\nb\n".split("\n") has a phantom empty element; a two-line file is two lines.
		expect(toLines("a\nb\n")).toEqual(["a", "b"]);
		expect(toLines("a\nb")).toEqual(["a", "b"]);
	});

	it("keeps a genuinely blank final line", () => {
		expect(toLines("a\n\n")).toEqual(["a", ""]);
	});

	it("treats empty text as no lines", () => {
		expect(toLines("")).toEqual([]);
	});
});

describe("editScript", () => {
	it("is all equal for identical input", () => {
		const { ops } = editScript(lines("a", "b"), lines("a", "b"));
		expect(ops.every((op) => op.kind === "equal")).toBe(true);
	});

	it("reports an insertion", () => {
		const { ops } = editScript(lines("a", "c"), lines("a", "b", "c"));
		expect(ops.filter((op) => op.kind === "insert").map((op) => op.text)).toEqual(["b"]);
	});

	it("reports a deletion", () => {
		const { ops } = editScript(lines("a", "b", "c"), lines("a", "c"));
		expect(ops.filter((op) => op.kind === "delete").map((op) => op.text)).toEqual(["b"]);
	});

	it("reports a replacement as a delete plus an insert", () => {
		const { ops } = editScript(lines("a", "b"), lines("a", "z"));
		expect(ops.filter((op) => op.kind !== "equal").map((op) => `${op.kind}:${op.text}`)).toEqual(["delete:b", "insert:z"]);
	});

	it("reconstructs the second input", () => {
		const a = lines("one", "two", "three", "four");
		const b = lines("one", "two-and-a-half", "three", "five", "six");
		const { ops } = editScript(a, b);
		expect(ops.filter((op) => op.kind !== "delete").map((op) => op.text)).toEqual(b);
	});

	it("reconstructs the first input", () => {
		const a = lines("one", "two", "three");
		const b = lines("one", "three", "four");
		const { ops } = editScript(a, b);
		expect(ops.filter((op) => op.kind !== "insert").map((op) => op.text)).toEqual(a);
	});

	it("handles an empty first input", () => {
		const { ops } = editScript([], lines("a", "b"));
		expect(ops.map((op) => op.kind)).toEqual(["insert", "insert"]);
	});

	it("handles an empty second input", () => {
		const { ops } = editScript(lines("a"), []);
		expect(ops.map((op) => op.kind)).toEqual(["delete"]);
	});

	it("handles both inputs empty", () => {
		expect(editScript([], []).ops).toEqual([]);
	});

	it("marks an oversized change approximate instead of allocating the table", () => {
		const a = Array.from({ length: 300 }, (_value, index) => `a${index}`);
		const b = Array.from({ length: 300 }, (_value, index) => `b${index}`);
		const { approximate, ops } = editScript(a, b, 1000);

		expect(approximate).toBe(true);
		expect(ops.filter((op) => op.kind === "delete")).toHaveLength(300);
		expect(ops.filter((op) => op.kind === "insert")).toHaveLength(300);
	});

	it("does not mark a small change approximate", () => {
		expect(editScript(lines("a"), lines("b"), 1000).approximate).toBe(false);
	});
});

describe("toHunks", () => {
	it("produces no hunks for an unchanged script", () => {
		expect(toHunks(editScript(lines("a", "b"), lines("a", "b")).ops)).toEqual([]);
	});

	it("includes up to `context` lines around a change", () => {
		const a = lines("1", "2", "3", "4", "5", "6", "7");
		const b = lines("1", "2", "3", "X", "5", "6", "7");
		const hunks = toHunks(editScript(a, b).ops, 2);

		expect(hunks).toHaveLength(1);
		expect(hunks[0]?.lines).toEqual([" 2", " 3", "-4", "+X", " 5", " 6"]);
	});

	it("splits distant changes into separate hunks", () => {
		const a = Array.from({ length: 60 }, (_value, index) => `${index}`);
		const b = [...a];
		b[2] = "changed-early";
		b[50] = "changed-late";
		expect(toHunks(editScript(a, b).ops, 3)).toHaveLength(2);
	});

	it("merges close changes into one hunk", () => {
		const a = Array.from({ length: 30 }, (_value, index) => `${index}`);
		const b = [...a];
		b[10] = "x";
		b[13] = "y";
		expect(toHunks(editScript(a, b).ops, 3)).toHaveLength(1);
	});

	it("numbers lines from 1 and reports counts that match the bodies", () => {
		const a = lines("a", "b", "c", "d", "e");
		const b = lines("a", "B", "c", "d", "e");
		const hunk = toHunks(editScript(a, b).ops, 1)[0];

		expect(hunk?.aStart).toBe(1);
		expect(hunk?.bStart).toBe(1);
		expect(hunk?.aCount).toBe(3);
		expect(hunk?.bCount).toBe(3);
	});

	it("starts at line 1 when the change is the first line", () => {
		const hunk = toHunks(editScript(lines("a", "b"), lines("A", "b")).ops, 3)[0];
		expect(hunk?.aStart).toBe(1);
		expect(hunk?.aCount).toBe(2);
	});

	it("counts a pure insertion without moving the first input's line count", () => {
		const hunk = toHunks(editScript(lines("a", "c"), lines("a", "b", "c")).ops, 1)[0];
		// The first input has two lines, so the hunk cannot claim three.
		expect(hunk?.aCount).toBe(2);
		expect(hunk?.bCount).toBe(3);
	});
});

describe("diffLines", () => {
	it("accepts strings as well as arrays", () => {
		expect(diffLines("a\nb\n", "a\nB\n").hunks).toHaveLength(1);
	});

	it("counts a changed line and an added line separately", () => {
		// A: a b c d   B: a X c Y d
		// b is replaced by X (one removal, one addition) and Y is inserted, so the
		// counts are not symmetric even though the edit looks symmetric.
		const diff = diffLines("a\nb\nc\nd\n", "a\nX\nc\nY\nd\n");
		expect(diff.added).toBe(2);
		expect(diff.removed).toBe(1);
		expect(diff.unchanged).toBe(3);
	});

	it("counts a replacement as one removal and one addition", () => {
		const diff = diffLines("a\nb\n", "a\nX\n");
		expect(diff.added).toBe(1);
		expect(diff.removed).toBe(1);
	});

	it("reports no hunks for identical input", () => {
		expect(diffLines("same\n", "same\n").hunks).toEqual([]);
	});

	it("degrades to a whole-block replacement past the budget", () => {
		const a = Array.from({ length: 200 }, (_value, index) => `a${index}`).join("\n");
		const b = Array.from({ length: 200 }, (_value, index) => `b${index}`).join("\n");
		expect(diffLines(a, b, { budget: 100 }).approximate).toBe(true);
	});
});

describe("formatUnified", () => {
	it("emits the headers and a hunk header", () => {
		const diff = diffLines("a\nb\n", "a\nB\n");
		const text = formatUnified("v1/main.tex", "v2/main.tex", diff);

		expect(text.split("\n")[0]).toBe("--- v1/main.tex");
		expect(text.split("\n")[1]).toBe("+++ v2/main.tex");
		expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
		expect(text).toContain("-b");
		expect(text).toContain("+B");
	});

	it("is empty for identical input", () => {
		expect(formatUnified("a", "b", diffLines("x\n", "x\n"))).toBe("");
	});
});

describe("summarizeDiff", () => {
	it("says identical when nothing changed", () => {
		expect(summarizeDiff(diffLines("x\n", "x\n"))).toBe("identical");
	});

	it("counts both directions and reports hunks", () => {
		expect(summarizeDiff(diffLines("a\nb\n", "a\nX\nY\n"))).toContain("hunk(s)");
	});

	it("flags an approximate diff so it is not read as line-accurate", () => {
		const a = Array.from({ length: 100 }, (_value, index) => `a${index}`).join("\n");
		const b = Array.from({ length: 100 }, (_value, index) => `b${index}`).join("\n");
		expect(summarizeDiff(diffLines(a, b, { budget: 10 }))).toContain("approximate");
	});
});

describe("a realistic revision", () => {
	it("localises a changed number in a paper-like document", () => {
		const v1 = [
			"# 1 Introduction",
			"",
			"On-policy distillation trains a student.",
			"",
			"# 4 Experiments",
			"",
			"| Method | SR |",
			"|:---|:---|",
			"| Vanilla OPD | 28.0 |",
			"| **OG-OPD** | **45.7** |",
			"",
			"# 5 Conclusion",
			"",
			"We conclude.",
		].join("\n");
		const v2 = v1.replace("**45.7**", "**46.1**");

		const diff = diffLines(v1, v2);

		expect(diff.added).toBe(1);
		expect(diff.removed).toBe(1);
		expect(diff.hunks).toHaveLength(1);
		expect(diff.hunks[0]?.lines.join("\n")).toContain("-| **OG-OPD** | **45.7** |");
		expect(diff.hunks[0]?.lines.join("\n")).toContain("+| **OG-OPD** | **46.1** |");
	});
});
