/**
 * `A2AClient` runs the caller's synchronous stop check immediately before
 * every `fetch` it makes, after awaiting the caller's asynchronous
 * admission callback (`beforeAttempt`), so a stop that lands while that
 * callback resolves — after it said yes, before the request — still keeps
 * the request from being sent. The client's own network retries are checked
 * the same way. Only `fetch` is simulated.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { A2AClient } from "../src/a2a/client";

const STOP = new Error("the chat turn stopped");

function stubFetch(
	impl: (url: string) => Promise<Response>,
): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn((input: unknown) =>
		impl(typeof input === "string" ? input : String(input)),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

const message = {
	role: "user" as const,
	parts: [{ type: "text" as const, text: "Plan this" }],
};

describe("A2AClient request control", () => {
	it("sends the message when nothing stops the caller", async () => {
		const fetchMock = stubFetch(async () =>
			Response.json({ id: "task-example-1", status: "completed" }),
		);
		const client = new A2AClient({ retryAttempts: 1 });
		await expect(
			client.sendMessage("https://agent.example.com", message, {
				beforeAttempt: async () => undefined,
				throwIfStopped: () => undefined,
			}),
		).resolves.toMatchObject({ id: "task-example-1" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("sends nothing when the stop latches as the admission callback resolves", async () => {
		const fetchMock = stubFetch(async () =>
			Response.json({ id: "task-example-1", status: "completed" }),
		);
		let stopped = false;
		const client = new A2AClient({ retryAttempts: 1 });
		const outcome = await client
			.sendMessage("https://agent.example.com", message, {
				// The admission check says yes; the stop lands in the
				// continuation queued right behind it, before the client
				// resumes.
				beforeAttempt: () => {
					const admitted = Promise.resolve();
					admitted.then(() => {
						stopped = true;
					});
					return admitted;
				},
				throwIfStopped: () => {
					if (stopped) {
						throw STOP;
					}
				},
			})
			.then(
				() => "sent",
				(error: unknown) => error,
			);
		expect(outcome).toBe(STOP);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("checks again before each network retry, and sends no retry after a stop", async () => {
		let stopped = false;
		const fetchMock = stubFetch(async () => {
			// The first attempt fails at the network level; the turn stops
			// while the client backs off.
			stopped = true;
			throw new TypeError("fetch failed");
		});
		const client = new A2AClient({ retryAttempts: 3, retryDelay: 1 });
		const outcome = await client
			.sendMessage("https://agent.example.com", message, {
				throwIfStopped: () => {
					if (stopped) {
						throw STOP;
					}
				},
			})
			.then(
				() => "sent",
				(error: unknown) => error,
			);
		expect(outcome).toBe(STOP);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
