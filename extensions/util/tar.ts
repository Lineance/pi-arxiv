/**
 * Minimal tar reader (ustar/GNU long name/PAX) + safe gzip extraction.
 *
 * Kept in-tree on purpose: it removes the only runtime dependency the package
 * would otherwise need, which is what makes `pi install ./pi-arxiv` (a local
 * package Pi never runs `npm install` for) work out of the box.
 */

import { join, normalize, posix, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { ensureDir, writeFileQueued } from "./fsx.ts";

export interface TarEntry {
	name: string;
	type: string;
	size: number;
	data: Buffer;
}

const BLOCK = 512;

function readString(buf: Buffer, start: number, length: number): string {
	const slice = buf.subarray(start, start + length);
	const end = slice.indexOf(0);
	return slice
		.subarray(0, end === -1 ? slice.length : end)
		.toString("utf8")
		.trim();
}

function readOctal(buf: Buffer, start: number, length: number): number {
	const text = buf
		.subarray(start, start + length)
		.toString("ascii")
		.trim();
	if (!text) return 0;
	const value = Number.parseInt(text.replace(/[^0-7]/g, ""), 8);
	return Number.isFinite(value) ? value : 0;
}

/** Parse a tar archive into entries, resolving GNU 'L' and PAX 'x' headers. */
export function parseTar(input: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let pendingLongName: string | undefined;
	let pendingPaxPath: string | undefined;

	while (offset + BLOCK <= input.length) {
		const header = input.subarray(offset, offset + BLOCK);
		offset += BLOCK;

		if (header.every((byte) => byte === 0)) break;

		const nameField = readString(header, 0, 100);
		const size = readOctal(header, 124, 12);
		const type = String.fromCharCode(header[156] ?? 48) || "0";
		const prefix = readString(header, 345, 155);
		const dataStart = offset;
		const dataEnd = dataStart + size;
		const data = input.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		if (type === "L") {
			pendingLongName = data.subarray(0, data.indexOf(0) === -1 ? data.length : data.indexOf(0)).toString("utf8");
			continue;
		}
		if (type === "x" || type === "g") {
			const pax = data.toString("utf8");
			const match = /(\d+) path=([^\n]+)\n/.exec(pax);
			if (match?.[2]) pendingPaxPath = match[2];
			continue;
		}

		const fullName = pendingPaxPath ?? pendingLongName ?? (prefix ? `${prefix}/${nameField}` : nameField);
		pendingLongName = undefined;
		pendingPaxPath = undefined;

		if (type !== "0" && type !== "\0" && type !== "7") continue; // skip dirs/links/devices
		entries.push({ name: fullName, type, size, data: Buffer.from(data) });
	}

	return entries;
}

/** Filesystem-safe target: reject absolute paths, drive letters and `..` segments. */
export function isUnsafeEntry(name: string): boolean {
	if (!name) return true;
	if (name.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(name)) return true;
	const normalized = normalize(name).split(sep).join(posix.sep);
	if (normalized.startsWith("../") || normalized === "..") return true;
	return normalized.split("/").includes("..");
}

export interface ExtractResult {
	files: string[];
	skipped: string[];
}

/**
 * Strip a single common top-level directory, e.g. an archive that wraps
 * everything in `my-paper-2026/`. Only applied when every entry shares that
 * prefix and no entry sits above it.
 */
function stripCommonPrefix(names: string[]): string {
	const segments = names.map((name) => name.split("/"));
	const head = segments[0]?.[0];
	if (!head || segments[0]?.length === 1) return "";
	const allShareHead = segments.every((parts) => parts.length > 1 && parts[0] === head);
	return allShareHead ? `${head}/` : "";
}

/** Write parsed tar entries into `destDir`, refusing unsafe paths. */
async function writeEntries(entries: TarEntry[], destDir: string): Promise<ExtractResult> {
	const prefix = stripCommonPrefix(entries.map((entry) => entry.name));
	const result: ExtractResult = { files: [], skipped: [] };

	await ensureDir(destDir);
	for (const entry of entries) {
		const relativeName = prefix && entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : entry.name;
		if (isUnsafeEntry(relativeName)) {
			result.skipped.push(entry.name);
			continue;
		}
		const target = join(destDir, relativeName.split("/").join(sep));
		await writeFileQueued(target, entry.data);
		result.files.push(relativeName);
	}
	return result;
}

/** Extract an uncompressed tar buffer into `destDir`. */
export async function extractTarToDir(tar: Buffer, destDir: string): Promise<ExtractResult> {
	return await writeEntries(parseTar(tar), destDir);
}

/** Extract a .tar.gz buffer into `destDir`, refusing path traversal and links. */
export async function extractTarGzToDir(gz: Buffer, destDir: string): Promise<ExtractResult> {
	return await writeEntries(parseTar(gunzipSync(gz)), destDir);
}
