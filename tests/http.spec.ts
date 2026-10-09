/**
 * HTTP layer: retry policy, timeout wiring, status handling and error text.
 * Every request goes through a stub, so this suite never touches the network.
 */

import { describe, expect, it, vi } from "vitest";
import { describeNetworkError, fetchWithRetry, HttpError, isRetryable } from "../extensions/util/http.ts";
import { flakyFetch, networkError, statusFetch } from "./helpers/fixtures.ts";

describe("retry policy", () => {
	it.each([
		[networkError("UND_ERR_CONNECT_TIMEOUT"), undefined, "connect timeout"],
		[networkError("ECONNRESET"), undefined, "connection reset"],
		[networkError("ENOTFOUND"), undefined, "dns failure"],
		[networkError("EAI_AGAIN"), undefined, "temporary dns failure"],
		[undefined, 429, "rate limiting"],
		[undefined, 408, "request timeout"],
		[undefined, 503, "server error"],
	] as Array<[Error | undefined, number | undefined, string]>)("retries %s", (error, status) => {
		expect(isRetryable(error, status)).toBe(true);
	});

	it.each([
		[undefined, 404, "not found"],
		[undefined, 403, "forbidden"],
		[undefined, 400, "bad request"],
	])("does not retry a %s response", (_error, status) => {
		expect(isRetryable(undefined, status)).toBe(false);
	});

	it("does not retry an ordinary application error", () => {
		expect(isRetryable(new Error("bad input"))).toBe(false);
	});
});

describe("fetchWithRetry", () => {
	it("returns the body on the first attempt when healthy", async () => {
		const stub = flakyFetch(0, networkError());
		const response = await fetchWithRetry("https://example.test/ok", { fetchImpl: stub.fetch });

		expect(await response.text()).toBe("ok");
		expect(stub.attempts()).toBe(1);
	});

	it("recovers from a transient failure", async () => {
		const stub = flakyFetch(2, networkError());
		const response = await fetchWithRetry("https://example.test/flaky", { fetchImpl: stub.fetch, retries: 2 });

		expect(stub.attempts()).toBe(3);
		expect(await response.text()).toBe("ok");
	});

	it("throws after exhausting the retry budget", async () => {
		const stub = flakyFetch(99, networkError());

		await expect(fetchWithRetry("https://example.test/down", { fetchImpl: stub.fetch, retries: 1 })).rejects.toThrow(/example\.test\/down/);
		expect(stub.attempts()).toBe(2);
	});

	it("explains a connect timeout rather than echoing 'fetch failed'", async () => {
		const stub = flakyFetch(99, networkError("UND_ERR_CONNECT_TIMEOUT"));

		await expect(fetchWithRetry("https://example.test/slow", { fetchImpl: stub.fetch, retries: 0 })).rejects.toThrow(
			/did not accept the connection in time/,
		);
	});

	it("reports a 404 immediately, without retrying", async () => {
		const stub = statusFetch([404]);

		const error = await fetchWithRetry("https://example.test/missing", { fetchImpl: stub.fetch, retries: 2 }).catch(
			(reason: unknown) => reason,
		);

		expect(error).toBeInstanceOf(HttpError);
		expect((error as HttpError).status).toBe(404);
		expect(stub.attempts()).toBe(1);
	});

	it("retries a 429 and then succeeds", async () => {
		const stub = statusFetch([429, 429, 200]);

		const response = await fetchWithRetry("https://example.test/limited", { fetchImpl: stub.fetch, retries: 2 });

		expect(stub.attempts()).toBe(3);
		expect(await response.text()).toBe("ok");
	});

	it("retries a 5xx to exhaustion", async () => {
		const stub = statusFetch([500, 500, 500]);

		await expect(fetchWithRetry("https://example.test/broken", { fetchImpl: stub.fetch, retries: 2 })).rejects.toThrow(/500/);
		expect(stub.attempts()).toBe(3);
	});

	it("tells the caller about each retry", async () => {
		const onRetry = vi.fn();
		const stub = flakyFetch(1, networkError());

		await fetchWithRetry("https://example.test/notify", { fetchImpl: stub.fetch, retries: 1, onRetry });

		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onRetry.mock.calls[0]?.[0]).toBe(1);
		expect(onRetry.mock.calls[0]?.[1]).toBeInstanceOf(Error);
	});

	it("stops retrying as soon as the caller aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		const stub = flakyFetch(99, networkError());

		await expect(
			fetchWithRetry("https://example.test/abort", { fetchImpl: stub.fetch, retries: 3, signal: controller.signal }),
		).rejects.toThrow(/abort/i);
		expect(stub.attempts()).toBeLessThanOrEqual(1);
	});

	it("forwards the caller's own headers", async () => {
		let seen: RequestInit["headers"] | undefined;
		const impl: typeof fetch = async (_input, init) => {
			seen = init?.headers;
			return new Response("ok", { status: 200 });
		};

		await fetchWithRetry("https://example.test/headers", { fetchImpl: impl, headers: { accept: "application/atom+xml" } });

		expect(seen).toMatchObject({ accept: "application/atom+xml" });
	});
});

describe("error text", () => {
	it("labels a DNS failure", () => {
		expect(describeNetworkError(networkError("ENOTFOUND"), "https://x.test").message).toMatch(/DNS lookup failed/);
	});

	it("keeps an unknown error's own message", () => {
		expect(describeNetworkError(new Error("boom"), "https://x.test").message).toContain("boom");
	});
});
