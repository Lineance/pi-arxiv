/**
 * Shared test fixtures: builders that keep the suites free of binary blobs and
 * avoid depending on external tools.
 */

/** Minimal ustar writer, so archive tests need no `tar` binary. */
export function makeTar(entries: Array<{ name: string; content: string }>): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100, "utf8");
		header.write("000644 \0", 100, 8, "ascii");
		header.write("000000 \0", 108, 8, "ascii");
		header.write("000000 \0", 116, 8, "ascii");
		const size = Buffer.byteLength(entry.content);
		header.write(`${size.toString(8).padStart(11, "0")} `, 124, 12, "ascii");
		header.write("00000000000 ", 136, 12, "ascii");
		header.write("        ", 148, 8, "ascii");
		header.write("0", 156, 1, "ascii");
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
		blocks.push(header);

		const body = Buffer.alloc(Math.ceil(size / 512) * 512);
		body.write(entry.content, 0, "utf8");
		blocks.push(body);
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

/** A `fetch` stub that fails the first `failures` attempts, then succeeds. */
export function flakyFetch(failures: number, error: Error, payload = "ok"): { fetch: typeof fetch; attempts: () => number } {
	let attempts = 0;
	const impl: typeof fetch = async () => {
		attempts++;
		if (attempts <= failures) throw error;
		return new Response(payload, { status: 200 });
	};
	return { fetch: impl, attempts: () => attempts };
}

/** A `fetch` stub that returns the given statuses in sequence. */
export function statusFetch(statuses: number[]): { fetch: typeof fetch; attempts: () => number } {
	let attempts = 0;
	const impl: typeof fetch = async () => {
		const status = statuses[Math.min(attempts, statuses.length - 1)] ?? 500;
		attempts++;
		return new Response(status >= 400 ? "err" : "ok", { status });
	};
	return { fetch: impl, attempts: () => attempts };
}

/** A transport-level failure as Node surfaces it, with the undici error code. */
export function networkError(code = "UND_ERR_CONNECT_TIMEOUT"): Error {
	const error = new Error("fetch failed");
	(error as { cause?: unknown }).cause = { code };
	return error;
}
