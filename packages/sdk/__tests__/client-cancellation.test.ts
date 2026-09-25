/**
 * A caller's `AbortSignal` (Fizzy #2563 spec §12, plan Task 17 Step 2).
 *
 * `fabric instructions push` waits for a pull request against an ABSOLUTE
 * deadline, so a status request must stop when that deadline passes: during
 * the fetch, during the body read, and during the client's own retry
 * backoff. Each rejects promptly with the CALLER's abort reason, never a
 * `FabricError`, so the caller can tell its own cancellation from a failure.
 * A request that carries no signal keeps exactly the behaviour it had.
 */
import { describe, expect, it } from "vitest";
import { createFabric, FabricError } from "../src/index.js";

/** Resolves once `signal` aborts, rejecting the way `fetch` does. */
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
	return new Promise((_resolve, reject) => {
		const fail = () => {
			const error = new Error("The operation was aborted");
			error.name = "AbortError";
			reject(error);
		};
		if (signal?.aborted) {
			fail();
			return;
		}
		signal?.addEventListener("abort", fail, { once: true });
	});
}

function client(
	fetchImpl: typeof fetch,
	options: { initialDelayMs?: number; timeoutMs?: number } = {},
) {
	return createFabric({
		apiKey: "fab_test_key",
		baseUrl: "https://test.fabric",
		fetch: fetchImpl,
		// The shipped two retries, so "no retry" below is a real claim.
		retry: { initialDelayMs: options.initialDelayMs ?? 1 },
		...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
	});
}

const read = (c: ReturnType<typeof client>, signal?: AbortSignal) =>
	c.instructions.getProposalPullRequest("project-1", "snap-8", {
		...(signal ? { signal } : {}),
	});

describe("a caller's signal", () => {
	it("rejects an already-aborted request without sending it or retrying", async () => {
		let attempts = 0;
		const c = client(async () => {
			attempts++;
			throw new TypeError("fetch failed");
		});
		const controller = new AbortController();
		const reason = new Error("deadline passed");
		controller.abort(reason);

		await expect(read(c, controller.signal)).rejects.toBe(reason);
		expect(attempts).toBe(0);
	});

	it("rejects promptly with the caller's reason when it aborts during the fetch", async () => {
		let attempts = 0;
		const c = client(async (_input, init) => {
			attempts++;
			return untilAborted(init?.signal);
		});
		const controller = new AbortController();
		const reason = new Error("deadline passed");
		setTimeout(() => controller.abort(reason), 10);

		const started = Date.now();
		const outcome = await read(c, controller.signal).catch((e) => e);

		expect(outcome).toBe(reason);
		expect(outcome).not.toBeInstanceOf(FabricError);
		expect(attempts).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("rejects promptly with the caller's reason when it aborts during the body read", async () => {
		let attempts = 0;
		const c = client(async (_input, init) => {
			attempts++;
			return {
				ok: true,
				status: 200,
				json: () => untilAborted(init?.signal),
			} as unknown as Response;
		});
		const controller = new AbortController();
		const reason = new Error("deadline passed");
		setTimeout(() => controller.abort(reason), 10);

		const outcome = await read(c, controller.signal).catch((e) => e);

		expect(outcome).toBe(reason);
		expect(outcome).not.toBeInstanceOf(FabricError);
		expect(attempts).toBe(1);
	});

	it("rejects promptly with the caller's reason when it aborts during the retry backoff", async () => {
		let attempts = 0;
		// A minute of backoff: only an abortable sleep lets this finish
		// inside the suite's ten-second timeout.
		const c = client(
			async () => {
				attempts++;
				throw new TypeError("fetch failed");
			},
			{ initialDelayMs: 60_000 },
		);
		const controller = new AbortController();
		const reason = new Error("deadline passed");
		setTimeout(() => controller.abort(reason), 20);

		const started = Date.now();
		const outcome = await read(c, controller.signal).catch((e) => e);

		expect(outcome).toBe(reason);
		expect(attempts).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
	});

	it("still reports the client's own TIMEOUT when the caller's signal has not fired", async () => {
		const c = client(async (_input, init) => untilAborted(init?.signal), {
			timeoutMs: 20,
		});
		const controller = new AbortController();

		await expect(read(c, controller.signal)).rejects.toMatchObject({
			name: "FabricError",
			code: "TIMEOUT",
		});
	});
});

describe("a request without a caller signal keeps its behaviour", () => {
	it("times out as TIMEOUT and retries a read the shipped number of times", async () => {
		let attempts = 0;
		const c = client(
			async (_input, init) => {
				attempts++;
				return untilAborted(init?.signal);
			},
			{ timeoutMs: 20 },
		);

		const outcome = await read(c).catch((e) => e);

		expect(outcome).toBeInstanceOf(FabricError);
		expect(outcome).toMatchObject({
			status: 0,
			code: "TIMEOUT",
			message: "Request timed out after 20ms",
		});
		expect(attempts).toBe(3);
	});

	it("reports a network failure as NETWORK_ERROR after the same retries", async () => {
		let attempts = 0;
		const c = client(async () => {
			attempts++;
			throw new TypeError("fetch failed");
		});

		await expect(read(c)).rejects.toMatchObject({
			code: "NETWORK_ERROR",
			message: "fetch failed",
		});
		expect(attempts).toBe(3);
	});

	it("reports an unreadable body as the same FabricError, unretried", async () => {
		let attempts = 0;
		const c = client(async () => {
			attempts++;
			return {
				ok: true,
				status: 200,
				json: async () => {
					throw new SyntaxError("Unexpected token");
				},
			} as unknown as Response;
		});

		await expect(read(c)).rejects.toMatchObject({
			name: "FabricError",
			status: 200,
			message: "Unexpected response from server (status 200)",
		});
		expect(attempts).toBe(1);
	});

	it("hands fetch the client's own timeout signal, unchanged", async () => {
		const seen: Array<AbortSignal | null | undefined> = [];
		const c = client(async (_input, init) => {
			seen.push(init?.signal);
			return new Response(
				JSON.stringify({ data: { pullRequest: null } }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		});

		await read(c);

		expect(seen[0]).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.aborted).toBe(false);
	});
});
