import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabricksApiClient, DatabricksApiError } from "../src/api-client";

const HOST = "https://example.azuredatabricks.net";

function fixture(fetchImpl: typeof fetch, maxRetries = 3) {
	const tokenProvider = {
		getToken: vi.fn().mockResolvedValue("synthetic-token"),
		invalidate: vi.fn(),
	};
	return {
		tokenProvider,
		client: new DatabricksApiClient({
			host: HOST,
			tokenProvider,
			fetchImpl,
			maxRetries,
		}),
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Databricks API mutation retry safety", () => {
	it.each(["POST", "PUT", "PATCH", "DELETE", "post"])(
		"never repeats %s on rate limiting or unavailable responses",
		async (method) => {
			for (const status of [429, 503]) {
				const fetchImpl = vi.fn().mockResolvedValueOnce(
					new Response("possibly accepted", {
						status,
						headers: { "Retry-After": "0" },
					}),
				);
				const { client } = fixture(fetchImpl);
				await expect(
					client.request(method, "/api/2.0/jobs/run-now", {
						job_id: 1,
						idempotency_token: "example-operation",
					}),
				).rejects.toMatchObject({ status, body: "possibly accepted" });
				expect(fetchImpl).toHaveBeenCalledTimes(1);
			}
		},
	);

	it("invalidates a rejected mutation token without replaying the operation", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response("expired", { status: 401 }))
			.mockResolvedValueOnce(new Response('{"run_id":1}'));
		const { client, tokenProvider } = fixture(fetchImpl);
		await expect(
			client.request("POST", "/api/2.0/jobs/run-now", { job_id: 1 }),
		).rejects.toMatchObject({ status: 401 });
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(tokenProvider.invalidate).toHaveBeenCalledTimes(1);

		// A deliberate, separately authorized call obtains a token again.
		await expect(
			client.request("POST", "/api/2.0/jobs/run-now", { job_id: 1 }),
		).resolves.toEqual({ run_id: 1 });
		expect(tokenProvider.getToken).toHaveBeenCalledTimes(2);
	});

	it.each([401, 429, 503])(
		"requestRaw does not replay a mutation on HTTP %s",
		async (status) => {
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(new Response("failure", { status }));
			const { client } = fixture(fetchImpl);
			await expect(
				client.requestRaw(
					"POST",
					"/api/2.0/genie/spaces/example/start-conversation",
					{
						body: JSON.stringify({ content: "synthetic question" }),
					},
				),
			).rejects.toBeInstanceOf(DatabricksApiError);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		},
	);

	it("does not replay a mutation after a lost network response", async () => {
		const failure = new TypeError("connection closed after admission");
		const fetchImpl = vi.fn().mockRejectedValueOnce(failure);
		const { client } = fixture(fetchImpl);
		await expect(
			client.request("POST", "/api/2.0/jobs/run-now", { job_id: 1 }),
		).rejects.toBe(failure);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("does not replay a mutation after a failed response body", async () => {
		const failure = new TypeError("response body lost");
		const response = new Response('{"run_id":');
		vi.spyOn(response, "text").mockRejectedValueOnce(failure);
		const fetchImpl = vi.fn().mockResolvedValueOnce(response);
		const { client } = fixture(fetchImpl);
		await expect(
			client.request("POST", "/api/2.0/jobs/run-now", { job_id: 1 }),
		).rejects.toBe(failure);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("Databricks API safe read retries", () => {
	it.each(["GET", "HEAD", "get"])(
		"retains bounded 429/503 retries for %s",
		async (method) => {
			vi.useFakeTimers();
			const fetchImpl = vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 429 }))
				.mockResolvedValueOnce(new Response(null, { status: 503 }))
				.mockResolvedValueOnce(new Response(null, { status: 503 }));
			const { client } = fixture(fetchImpl, 2);
			const result = client
				.requestRaw(method, "/api/2.0/jobs/list")
				.catch((error: unknown) => error);
			await vi.runAllTimersAsync();
			expect(await result).toMatchObject({ status: 503 });
			expect(fetchImpl).toHaveBeenCalledTimes(3);
		},
	);

	it("refreshes authentication at most once across transient read retries", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(new Response("{}"));
		const { client } = fixture(fetchImpl);
		const result = client
			.request("GET", "/api/2.0/jobs/list")
			.catch((error: unknown) => error);
		await vi.runAllTimersAsync();
		expect(await result).toMatchObject({ status: 401 });
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
});

describe("Databricks API cancellation", () => {
	it("does not acquire a token or send an already aborted request", async () => {
		const fetchImpl = vi.fn();
		const { client, tokenProvider } = fixture(fetchImpl);
		const controller = new AbortController();
		const reason = new Error("cancelled");
		controller.abort(reason);
		await expect(
			client.request(
				"POST",
				"/api/2.0/jobs/run-now",
				{},
				{
					signal: controller.signal,
				},
			),
		).rejects.toBe(reason);
		expect(tokenProvider.getToken).not.toHaveBeenCalled();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("does not dispatch after cancellation during token acquisition", async () => {
		const fetchImpl = vi.fn();
		const { client, tokenProvider } = fixture(fetchImpl);
		const controller = new AbortController();
		const reason = new Error("token wait cancelled");
		tokenProvider.getToken.mockImplementationOnce(async () => {
			controller.abort(reason);
			return "synthetic-token";
		});
		await expect(
			client.requestRaw("POST", "/api/2.0/jobs/run-now", {
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("cancels a safe read during retry backoff without another request", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn().mockResolvedValueOnce(
			new Response(null, {
				status: 503,
				headers: { "Retry-After": "30" },
			}),
		);
		const { client } = fixture(fetchImpl);
		const controller = new AbortController();
		const reason = new Error("retry cancelled");
		const result = client
			.request("GET", "/api/2.0/jobs/list", undefined, {
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort(reason);
		expect(await result).toBe(reason);
		await vi.runAllTimersAsync();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});
