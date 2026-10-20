import { afterEach, describe, expect, it, vi } from "vitest";
import { createFabric } from "../src/index.js";

const input = {
	generation: 3,
	commitSha: "a".repeat(40),
	paths: ["AGENTS.md"],
	startIndex: 0,
};
const page = {
	generation: 3,
	commitSha: input.commitSha,
	files: [],
	nextIndex: null,
};
const read = (
	fetchImpl: typeof fetch,
	options: {
		signal?: AbortSignal;
		retries?: number;
		timeoutMs?: number;
	} = {},
) =>
	createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://example.com",
		fetch: fetchImpl,
		retry: { maxRetries: options.retries ?? 2 },
		timeoutMs: options.timeoutMs,
	}).instructions.readRepositoryFiles("project 1", input, {
		org: "example-org",
		signal: options.signal,
	});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("read-only repository JSON batches", () => {
	it("sends a typed POST with the immutable pin and continuation", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
			expect(String(url)).toBe(
				"https://example.com/api/v1/projects/project%201/instructions/repository/files/read?org=example-org",
			);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual(input);
			return Response.json({ data: page });
		});
		await expect(read(fetchImpl)).resolves.toEqual(page);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it.each(["60", "Tue, 20 Oct 2026 00:01:00 GMT", null, "invalid"])(
		"waits for Retry-After without a burst: %s",
		async (header) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					new Response("Rate limited", {
						status: 429,
						headers:
							header === null ? {} : { "Retry-After": header },
					}),
				)
				.mockResolvedValueOnce(Response.json({ data: page }));
			const pending = read(fetchImpl);
			await vi.advanceTimersByTimeAsync(59_999);
			expect(fetchImpl).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(1);
			await expect(pending).resolves.toEqual(page);
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		},
	);

	it("fails without shortening a server wait over the retry budget", async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("Rate limited", {
				status: 429,
				headers: { "Retry-After": "3600" },
			}),
		);
		await expect(read(fetchImpl)).rejects.toMatchObject({ status: 429 });
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("cancels a rate-limit wait with the caller's exact reason", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const reason = new Error("Cancelled");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("Rate limited", {
				status: 429,
				headers: { "Retry-After": "60" },
			}),
		);
		const pending = read(fetchImpl, { signal: controller.signal });
		const outcome = expect(pending).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(1);
		controller.abort(reason);
		await outcome;
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("rejects an oversized JSON response without retrying", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				Response.json({ data: "x".repeat(4 * 1024 * 1024) }),
			);
		await expect(read(fetchImpl)).rejects.toMatchObject({
			code: "RESPONSE_TOO_LARGE",
		});
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("keeps the client timeout active while reading the body", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof fetch>(
			async (_url, init) =>
				new Response(
					new ReadableStream({
						start(controller) {
							init?.signal?.addEventListener(
								"abort",
								() => controller.error(init.signal?.reason),
								{ once: true },
							);
						},
					}),
				),
		);
		const pending = read(fetchImpl, { retries: 0, timeoutMs: 10 });
		const outcome = expect(pending).rejects.toMatchObject({
			code: "TIMEOUT",
		});
		await vi.advanceTimersByTimeAsync(10);
		await outcome;
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("never sends a cancelled batch", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled");
		controller.abort(reason);
		const fetchImpl = vi.fn<typeof fetch>();
		await expect(
			read(fetchImpl, { signal: controller.signal }),
		).rejects.toBe(reason);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("bounds the entire retry operation to two minutes", async () => {
		vi.useFakeTimers();
		const deadline = new AbortController();
		const timeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(deadline.signal);
		const reason = new Error("Total retry deadline");
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("Rate limited", {
				status: 429,
				headers: { "Retry-After": "60" },
			}),
		);
		const pending = read(fetchImpl);
		const outcome = expect(pending).rejects.toBe(reason);
		await vi.advanceTimersByTimeAsync(1);
		deadline.abort(reason);
		await outcome;
		expect(timeout).toHaveBeenCalledWith(120_000);
		expect(fetchImpl).toHaveBeenCalledOnce();
	});

	it("caps retries at two even when the client allows more", async () => {
		vi.useFakeTimers();
		const fetchImpl = vi.fn<typeof fetch>(
			async () =>
				new Response("Rate limited", {
					status: 429,
					headers: { "Retry-After": "0" },
				}),
		);
		const pending = read(fetchImpl, { retries: 10 });
		const outcome = expect(pending).rejects.toMatchObject({ status: 429 });
		await vi.advanceTimersByTimeAsync(2000);
		await outcome;
		expect(fetchImpl).toHaveBeenCalledTimes(3);
	});
});
