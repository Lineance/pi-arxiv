/**
 * HTTP layer tests with a stubbed fetch: retry policy, timeout wiring, and
 * error reporting. No network.
 */

import { describeNetworkError, fetchWithRetry, HttpError, isRetryable } from "../extensions/util/http.ts";
import { check, equal as eq } from "./harness.ts";

function networkError(code = "UND_ERR_CONNECT_TIMEOUT"): Error {
	const error = new Error("fetch failed");
	(error as { cause?: unknown }).cause = { code };
	return error;
}

/** A fetch stub that fails the first `failures` attempts, then succeeds. */
function flakyFetch(failures: number, error: Error, payload = "ok"): { fetch: typeof fetch; attempts: () => number } {
	let attempts = 0;
	const impl: typeof fetch = async () => {
		attempts++;
		if (attempts <= failures) throw error;
		return new Response(payload, { status: 200 });
	};
	return { fetch: impl, attempts: () => attempts };
}

function statusFetch(statuses: number[]): { fetch: typeof fetch; attempts: () => number } {
	let attempts = 0;
	const impl: typeof fetch = async () => {
		const status = statuses[Math.min(attempts, statuses.length - 1)] ?? 500;
		attempts++;
		return new Response(status >= 400 ? "err" : "ok", { status });
	};
	return { fetch: impl, attempts: () => attempts };
}

export async function runHttp(): Promise<void> {
	// ------------------------------------------------------------ retry policy
	check("retryable: connect timeout", isRetryable(networkError("UND_ERR_CONNECT_TIMEOUT")));
	check("retryable: connection reset", isRetryable(networkError("ECONNRESET")));
	check("retryable: dns failure", isRetryable(networkError("ENOTFOUND")));
	check("retryable: 429", isRetryable(undefined, 429));
	check("retryable: 503", isRetryable(undefined, 503));
	check("not retryable: 404", !isRetryable(undefined, 404));
	check("not retryable: 403", !isRetryable(undefined, 403));
	check("not retryable: plain error", !isRetryable(new Error("bad input")));

	// ------------------------------------------------------------ success paths
	const healthy = flakyFetch(0, networkError());
	const ok = await fetchWithRetry("https://example.test/ok", { fetchImpl: healthy.fetch });
	eq("healthy request returns the body", await ok.text(), "ok");
	eq("healthy request attempts once", healthy.attempts(), 1);

	// ------------------------------------------------------------ transient then success
	const recovered = flakyFetch(2, networkError());
	const response = await fetchWithRetry("https://example.test/flaky", { fetchImpl: recovered.fetch, retries: 2 });
	eq("retries until success", recovered.attempts(), 3);
	eq("recovers with the body", await response.text(), "ok");

	// ------------------------------------------------------------ retries exhausted
	const always = flakyFetch(99, networkError());
	let threw = false;
	let message = "";
	try {
		await fetchWithRetry("https://example.test/down", { fetchImpl: always.fetch, retries: 1 });
	} catch (error) {
		threw = true;
		message = (error as Error).message;
	}
	check("exhausted retries throw", threw);
	eq("attempts equal retries + 1", always.attempts(), 2);
	check("timeout cause is explained", /did not accept the connection in time/.test(message), message);
	check("failing url is named", /example\.test\/down/.test(message), message);

	// ------------------------------------------------------------ status handling
	const notFound = statusFetch([404]);
	let notFoundError: unknown;
	try {
		await fetchWithRetry("https://example.test/missing", { fetchImpl: notFound.fetch, retries: 2 });
	} catch (error) {
		notFoundError = error;
	}
	check("404 throws HttpError", notFoundError instanceof HttpError, String(notFoundError));
	eq("404 is not retried", notFound.attempts(), 1);
	eq("404 status is preserved", (notFoundError as HttpError).status, 404);

	const rateLimited = statusFetch([429, 429, 200]);
	const afterLimit = await fetchWithRetry("https://example.test/limited", { fetchImpl: rateLimited.fetch, retries: 2 });
	eq("429 is retried", rateLimited.attempts(), 3);
	eq("429 eventually succeeds", await afterLimit.text(), "ok");

	const serverError = statusFetch([500, 500, 500]);
	let serverAttempts = 0;
	try {
		await fetchWithRetry("https://example.test/broken", { fetchImpl: serverError.fetch, retries: 2 });
	} catch {
		serverAttempts = serverError.attempts();
	}
	eq("5xx retried to exhaustion", serverAttempts, 3);

	// ------------------------------------------------------------ retry callback
	const seen: number[] = [];
	const notified = flakyFetch(1, networkError());
	await fetchWithRetry("https://example.test/notify", {
		fetchImpl: notified.fetch,
		retries: 1,
		onRetry: (attempt) => seen.push(attempt),
	});
	eq("onRetry reports the attempt number", seen.join(","), "1");

	// ------------------------------------------------------------ cancellation
	const controller = new AbortController();
	controller.abort();
	const slow = flakyFetch(99, networkError());
	let aborted = false;
	try {
		await fetchWithRetry("https://example.test/abort", { fetchImpl: slow.fetch, signal: controller.signal, retries: 3 });
	} catch (error) {
		aborted = /abort/i.test((error as Error).message);
	}
	check("an aborted signal stops retrying", aborted);
	check("abort does not exhaust retries", slow.attempts() <= 1, slow.attempts());

	// ------------------------------------------------------------ error text
	check("dns errors are labelled", /DNS lookup failed/.test(describeNetworkError(networkError("ENOTFOUND"), "u").message));
	check("unknown errors keep their message", describeNetworkError(new Error("boom"), "u").message.includes("boom"));
}
