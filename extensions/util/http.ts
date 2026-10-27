/**
 * Shared HTTP helper: per-attempt timeout, bounded retry with backoff, and a
 * descriptive User-Agent.
 *
 * arXiv is occasionally slow to accept connections; the Node default (10 s
 * connect timeout, no retry) turns that into a spurious failure, so every
 * network call in this package goes through here.
 */

export interface HttpOptions {
	/** Per-attempt timeout in milliseconds (default 30 s). */
	timeoutMs?: number | undefined;
	/** Extra attempts after the first (default 2, so 3 attempts total). */
	retries?: number | undefined;
	signal?: AbortSignal | undefined;
	headers?: Record<string, string> | undefined;
	/** Injectable for tests; defaults to the global fetch. */
	fetchImpl?: typeof fetch | undefined;
	/** Called before each retry, for logging. */
	onRetry?: ((attempt: number, error: Error, delayMs: number) => void) | undefined;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRIES = 2;
export const USER_AGENT = "pi-arxiv/0.1.0 (https://pi.dev; research tooling)";

/** Retry only when the failure is plausibly transient. */
export function isRetryable(error: unknown, status?: number): boolean {
	if (status !== undefined) return status === 429 || status === 408 || status >= 500;
	if (!(error instanceof Error)) return false;
	const code = (error.cause as { code?: string } | undefined)?.code ?? "";
	if (
		/UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED/.test(
			code,
		)
	)
		return true;
	return (
		/fetch failed|network|socket hang up|timed out|timeout|aborted/i.test(error.message) &&
		!/abort/i.test(String((error as { name?: string }).name ?? ""))
	);
}

function backoffMs(attempt: number): number {
	const base = Math.min(500 * 2 ** attempt, 4_000);
	return base + Math.floor(Math.random() * 250);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Fetch with retry. Throws on exhausted retries, with the last error's cause
 * preserved so callers can report *why* (connect timeout vs. 404).
 */
export async function fetchWithRetry(url: string, options: HttpOptions = {}): Promise<Response> {
	const doFetch = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = options.retries ?? DEFAULT_RETRIES;
	const headers = { "user-agent": USER_AGENT, ...options.headers };

	let lastError: Error = new Error(`request failed: ${url}`);
	for (let attempt = 0; attempt <= retries; attempt++) {
		// AbortSignal.any keeps the caller's cancellation working alongside the per-attempt timeout.
		const signals = [AbortSignal.timeout(timeoutMs)];
		if (options.signal) signals.push(options.signal);
		try {
			const response = await doFetch(url, { headers, signal: AbortSignal.any(signals) });
			if (response.ok) return response;
			if (!isRetryable(undefined, response.status) || attempt === retries) {
				throw new HttpError(`${response.status} ${response.statusText}`, response.status, url);
			}
			lastError = new HttpError(`${response.status} ${response.statusText}`, response.status, url);
		} catch (error) {
			if (options.signal?.aborted) throw new Error(`request aborted: ${url}`);
			if (error instanceof HttpError && !isRetryable(undefined, error.status)) throw error;
			lastError = error instanceof Error ? error : new Error(String(error));
			if (!isRetryable(error) || attempt === retries) {
				throw describeNetworkError(lastError, url);
			}
		}
		const delay = backoffMs(attempt);
		options.onRetry?.(attempt + 1, lastError, delay);
		await sleep(delay, options.signal);
	}
	throw describeNetworkError(lastError, url);
}

export class HttpError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(message: string, status: number, url: string) {
		super(`HTTP ${message} for ${url}`);
		this.name = "HttpError";
		this.status = status;
		this.url = url;
	}
}

/** Turn low-level transport errors into something a user can act on. */
export function describeNetworkError(error: Error, url: string): Error {
	const code = (error.cause as { code?: string } | undefined)?.code;
	const detail = code ? `${error.message} (${code})` : error.message;
	const hint = /CONNECT_TIMEOUT|ETIMEDOUT/.test(code ?? error.message)
		? " — the host did not accept the connection in time"
		: /ENOTFOUND|EAI_AGAIN/.test(code ?? "")
			? " — DNS lookup failed"
			: "";
	return new Error(`request failed: ${url}: ${detail}${hint}`);
}
