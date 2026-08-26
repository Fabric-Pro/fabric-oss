import { describe, expect, it, vi } from "vitest";
import { DatabricksApiClient, DatabricksApiError } from "../src/api-client";
import type { DatabricksTokenProvider } from "../src/auth";

const BASE_HOST = "https://ws.azuredatabricks.net";
const FAKE_TOKEN = "test-bearer-token";

function makeTokenProvider(
	token = FAKE_TOKEN,
): DatabricksTokenProvider & { invalidate: ReturnType<typeof vi.fn> } {
	const invalidate = vi.fn();
	return {
		getToken: vi.fn().mockResolvedValue(token),
		invalidate,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function emptyResponse(status = 204): Response {
	return new Response(null, { status });
}

describe("DatabricksApiClient — bearer header", () => {
	it("sets Authorization: Bearer header on requests", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		await client.request("GET", "/api/2.0/clusters/list");

		const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(`${BASE_HOST}/api/2.0/clusters/list`);
		expect((init.headers as Headers).get("Authorization")).toBe(
			`Bearer ${FAKE_TOKEN}`,
		);
	});

	it("sends Content-Type: application/json when body is present", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ ok: true }));
		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		await client.request("POST", "/api/2.0/jobs/run-now", { job_id: 42 });

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		expect((init.headers as Headers).get("Content-Type")).toBe(
			"application/json",
		);
	});
});

describe("DatabricksApiClient — 401 retry", () => {
	it("calls invalidate and retries once on 401, then succeeds", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Unauthorized", { status: 401 }),
			)
			.mockResolvedValueOnce(jsonResponse({ clusters: [] }));

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		const result = await client.request("GET", "/api/2.0/clusters/list");

		expect(provider.invalidate).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ clusters: [] });
	});

	it("throws DatabricksApiError after the one retry also returns 401", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Unauthorized", { status: 401 }),
			)
			.mockResolvedValueOnce(
				new Response("Still unauthorized", { status: 401 }),
			);

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		await expect(
			client.request("GET", "/api/2.0/clusters/list"),
		).rejects.toBeInstanceOf(DatabricksApiError);

		expect(provider.invalidate).toHaveBeenCalledTimes(1);
	});
});

describe("DatabricksApiClient — 429 retry with Retry-After", () => {
	it("honors a numeric Retry-After header and retries then succeeds", async () => {
		vi.useFakeTimers();

		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Too Many Requests", {
					status: 429,
					headers: { "Retry-After": "1" },
				}),
			)
			.mockResolvedValueOnce(jsonResponse({ result: "ok" }));

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
			maxRetries: 3,
		});

		const resultPromise = client.request("GET", "/api/2.0/jobs/list");
		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result).toEqual({ result: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);

		vi.useRealTimers();
	});
});

describe("DatabricksApiClient — 503 retries exhausted", () => {
	it("throws DatabricksApiError with status 503 after maxRetries", async () => {
		vi.useFakeTimers();

		const fetchImpl = vi
			.fn()
			.mockResolvedValue(
				new Response("Service Unavailable", { status: 503 }),
			);

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
			maxRetries: 3,
		});

		const resultPromise = client
			.request("GET", "/api/2.0/clusters/list")
			.catch((e: unknown) => e);

		await vi.runAllTimersAsync();
		const error = await resultPromise;

		expect(error).toBeInstanceOf(DatabricksApiError);
		expect((error as DatabricksApiError).status).toBe(503);
		// Initial attempt + 3 retries = 4 total fetch calls
		expect(fetchImpl).toHaveBeenCalledTimes(4);

		vi.useRealTimers();
	});
});

describe("DatabricksApiClient — non-retryable errors", () => {
	it("throws DatabricksApiError immediately on 400 without any retry", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Bad request body", { status: 400 }),
			);

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		const error = await client
			.request("POST", "/api/2.0/jobs/run-now", {})
			.catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DatabricksApiError);
		expect((error as DatabricksApiError).status).toBe(400);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("DatabricksApiClient — 204 / empty body", () => {
	it("returns undefined for 204 response", async () => {
		const fetchImpl = vi.fn().mockResolvedValueOnce(emptyResponse(204));
		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		const result = await client.request("DELETE", "/api/2.0/jobs/delete");
		expect(result).toBeUndefined();
	});
});

describe("DatabricksApiClient — requestRaw", () => {
	it("returns the raw Response without parsing the body", async () => {
		const rawBody = "raw csv data";
		const mockResponse = new Response(rawBody, {
			status: 200,
			headers: { "Content-Type": "text/csv" },
		});
		const fetchImpl = vi.fn().mockResolvedValueOnce(mockResponse);
		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		const response = await client.requestRaw("GET", "/api/2.0/dbfs/read");

		expect(response).toBe(mockResponse);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		// Body should still be readable (was not consumed by the client)
		const text = await response.text();
		expect(text).toBe(rawBody);
	});

	it("merges caller-provided headers with the Authorization header", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));
		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		await client.requestRaw("GET", "/api/2.0/dbfs/read", {
			headers: { "X-Custom-Header": "custom-value" },
		});

		const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
		const headers = init.headers as Headers;
		expect(headers.get("Authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
		expect(headers.get("X-Custom-Header")).toBe("custom-value");
	});

	it("applies 401-invalidate-retry-once semantics in requestRaw", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("Unauthorized", { status: 401 }),
			)
			.mockResolvedValueOnce(new Response("ok", { status: 200 }));

		const provider = makeTokenProvider();
		const client = new DatabricksApiClient({
			host: BASE_HOST,
			tokenProvider: provider,
			fetchImpl,
		});

		const response = await client.requestRaw("GET", "/api/2.0/dbfs/read");

		expect(response.status).toBe(200);
		expect(provider.invalidate).toHaveBeenCalledTimes(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});
});
