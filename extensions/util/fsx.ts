/**
 * Filesystem helpers: queued writes, hashing, directory listing.
 * Implemented locally so the converter works standalone (no `pi` import).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const chains = new Map<string, Promise<unknown>>();

/** Serialize writes per absolute path (same intent as pi's withFileMutationQueue). */
export function writeFileQueued(path: string, data: string | Uint8Array): Promise<void> {
	const key = resolve(path);
	const prev = chains.get(key) ?? Promise.resolve();
	const next = prev
		.catch(() => undefined)
		.then(async () => {
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, data);
		})
		.finally(() => {
			if (chains.get(key) === next) chains.delete(key);
		});
	chains.set(key, next);
	return next;
}

export async function ensureDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
}

export async function readText(path: string): Promise<string> {
	return await readFile(path, "utf8");
}

export async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

export async function sizeOf(path: string): Promise<number> {
	try {
		return (await stat(path)).size;
	} catch {
		return -1;
	}
}

/** Modification time in milliseconds, or `0` when the path is unreadable. */
export async function statOf(path: string): Promise<number> {
	try {
		return (await stat(path)).mtimeMs;
	} catch {
		return 0;
	}
}

export async function sha256File(path: string): Promise<string> {
	return await new Promise((ok, fail) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => ok(hash.digest("hex")));
		stream.on("error", fail);
	});
}

export function sha256Text(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface DirEntry {
	name: string;
	path: string;
	dir: boolean;
	size: number;
}

export async function listDir(path: string): Promise<DirEntry[]> {
	let names: string[];
	try {
		names = await readdir(path);
	} catch {
		return [];
	}
	const out: DirEntry[] = [];
	for (const name of names) {
		const full = join(path, name);
		try {
			const s = await stat(full);
			out.push({ name, path: full, dir: s.isDirectory(), size: s.size });
		} catch {
			/* ignore unreadable entries */
		}
	}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}
