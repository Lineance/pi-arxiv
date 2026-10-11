/**
 * A small unified-diff engine.
 *
 * Written rather than shelled out to `git diff --no-index` for two reasons: the
 * second input is often a string already in memory (converted Markdown), not a
 * file, and the package ships no runtime dependencies.
 *
 * The shape is the usual one: an edit script, grouped into hunks with context.
 * The interesting decisions are the two bounds at the bottom — trim the common
 * prefix and suffix first, and refuse the quadratic table on inputs too large
 * for it instead of quietly allocating gigabytes.
 */

export type OpKind = "equal" | "insert" | "delete";

export interface Op {
	kind: OpKind;
	text: string;
}

export interface DiffHunk {
	/** 1-based line number in the first input, for the `@@` header. */
	aStart: number;
	aCount: number;
	bStart: number;
	bCount: number;
	lines: string[];
}

export interface LineDiff {
	hunks: DiffHunk[];
	added: number;
	removed: number;
	unchanged: number;
	/**
	 * True when the inputs were too large for the quadratic table and the middle
	 * was reported as one replacement block. Callers should say so rather than
	 * present it as a line-level diff.
	 */
	approximate: boolean;
}

/** Cells in the LCS table we are willing to allocate: 4M ints ≈ 16 MB. */
const DEFAULT_BUDGET = 4_000_000;
const DEFAULT_CONTEXT = 3;

/**
 * Split text into lines the way a version control system does: the newline is a
 * terminator, not a separator.
 *
 * `"a\nb\n".split("\n")` yields a phantom empty final element, which would show
 * up as a mysterious trailing context line in every diff and inflate the
 * unchanged count.
 */
export function toLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * The edit script between two line arrays.
 *
 * Common leading and trailing lines are removed before the quadratic step; a
 * typical revision of a paper differs in a handful of places, so this is what
 * keeps the cost near-linear in practice.
 */
export function editScript(a: string[], b: string[], budget = DEFAULT_BUDGET): { ops: Op[]; approximate: boolean } {
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;

	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);

	const ops: Op[] = [];
	for (let i = 0; i < prefix; i++) ops.push({ kind: "equal", text: a[i] ?? "" });

	let approximate = false;
	const midWidth = (aMid.length + 1) * (bMid.length + 1);
	if (aMid.length === 0) {
		for (const text of bMid) ops.push({ kind: "insert", text });
	} else if (bMid.length === 0) {
		for (const text of aMid) ops.push({ kind: "delete", text });
	} else if (midWidth > budget) {
		// Too big for the table: report the whole middle as a replacement rather
		// than spending unbounded memory, and let the caller label it approximate.
		approximate = true;
		for (const text of aMid) ops.push({ kind: "delete", text });
		for (const text of bMid) ops.push({ kind: "insert", text });
	} else {
		ops.push(...lcsOps(aMid, bMid));
	}

	for (let i = a.length - suffix; i < a.length; i++) ops.push({ kind: "equal", text: a[i] ?? "" });
	return { ops, approximate };
}

/** Standard LCS backtrace; `a` and `b` are the trimmed middles. */
function lcsOps(a: string[], b: string[]): Op[] {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const table = new Int32Array(rows * cols);

	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * cols + j] =
				a[i] === b[j] ? (table[(i + 1) * cols + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			ops.push({ kind: "equal", text: a[i] ?? "" });
			i++;
			j++;
		} else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
			ops.push({ kind: "delete", text: a[i] ?? "" });
			i++;
		} else {
			ops.push({ kind: "insert", text: b[j] ?? "" });
			j++;
		}
	}
	while (i < a.length) ops.push({ kind: "delete", text: a[i++] ?? "" });
	while (j < b.length) ops.push({ kind: "insert", text: b[j++] ?? "" });
	return ops;
}

/**
 * Group an edit script into hunks, keeping `context` lines around each cluster
 * of changes.
 *
 * Positions are precomputed for every op, so a hunk's `@@` header is a lookup
 * rather than something accumulated while walking — the earlier version tried to
 * track both line numbers while emitting and got them wrong around the leading
 * context.
 */
export function toHunks(ops: Op[], context = DEFAULT_CONTEXT): DiffHunk[] {
	const aPos: number[] = [];
	const bPos: number[] = [];
	let a = 1;
	let b = 1;
	for (const op of ops) {
		aPos.push(a);
		bPos.push(b);
		if (op.kind !== "insert") a++;
		if (op.kind !== "delete") b++;
	}

	// Indices of ops that change something.
	const changes: number[] = [];
	for (let i = 0; i < ops.length; i++) {
		if (ops[i]?.kind !== "equal") changes.push(i);
	}
	if (changes.length === 0) return [];

	// Split the changes into clusters separated by more than 2*context equal lines.
	const clusters: Array<[number, number]> = [];
	let first = changes[0] ?? 0;
	let previous = first;
	for (const index of changes.slice(1)) {
		if (index - previous - 1 > context * 2) {
			clusters.push([first, previous]);
			first = index;
		}
		previous = index;
	}
	clusters.push([first, previous]);

	return clusters.map(([start, end]) => {
		const from = Math.max(0, start - context);
		const to = Math.min(ops.length, end + context + 1);
		const slice = ops.slice(from, to);

		return {
			aStart: aPos[from] ?? 1,
			bStart: bPos[from] ?? 1,
			aCount: slice.filter((op) => op.kind !== "insert").length,
			bCount: slice.filter((op) => op.kind !== "delete").length,
			lines: slice.map((op) => `${op.kind === "equal" ? " " : op.kind === "delete" ? "-" : "+"}${op.text}`),
		};
	});
}

export function diffLines(a: string[] | string, b: string[] | string, options: { context?: number; budget?: number } = {}): LineDiff {
	const left = typeof a === "string" ? toLines(a) : a;
	const right = typeof b === "string" ? toLines(b) : b;
	const { ops, approximate } = editScript(left, right, options.budget);
	const hunks = toHunks(ops, options.context ?? DEFAULT_CONTEXT);

	let added = 0;
	let removed = 0;
	let unchanged = 0;
	for (const op of ops) {
		if (op.kind === "insert") added++;
		else if (op.kind === "delete") removed++;
		else unchanged++;
	}

	return { hunks, added, removed, unchanged, approximate };
}

/** Render a diff in unified format, as `git diff` would. */
export function formatUnified(fromLabel: string, toLabel: string, diff: LineDiff): string {
	if (diff.hunks.length === 0) return "";
	const out = [`--- ${fromLabel}`, `+++ ${toLabel}`];
	for (const hunk of diff.hunks) {
		out.push(`@@ -${hunk.aStart},${hunk.aCount} +${hunk.bStart},${hunk.bCount} @@`);
		out.push(...hunk.lines);
	}
	return out.join("\n");
}

/** One-line summary, for a tool result. */
export function summarizeDiff(diff: LineDiff): string {
	if (diff.hunks.length === 0) return "identical";
	const parts = [`+${diff.added}`, `-${diff.removed}`, `${diff.hunks.length} hunk(s)`];
	if (diff.approximate) parts.push("approximate");
	return parts.join(" ");
}
