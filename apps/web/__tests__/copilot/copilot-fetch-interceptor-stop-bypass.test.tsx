/**
 * GH issue #2526: CopilotKit's single-endpoint transport POSTs a
 * fire-and-forget `agent/stop` request to release the server-side
 * `InMemoryAgentRunner`'s per-thread `isRunning` lock. If our client-side
 * 429 backoff silently swallows that stop request, the lock is never
 * released and the next run on the same thread throws "Thread already
 * running". This pins two behaviors of `CopilotFetchErrorInterceptor`:
 *   1. A run POST issued while backed off gets the synthetic client-side
 *      429 without reaching the real network.
 *   2. An `agent/stop` POST issued during that same backoff window always
 *      reaches the real network.
 */

import { CopilotFetchErrorInterceptor } from "@saas/shared/components/copilot/CopilotFetchErrorInterceptor";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@saas/shared/components/copilot/copilot-error-toast", () => ({
	showPersistentAiErrorToast: vi.fn(),
	showTransientAiErrorToast: vi.fn(),
}));

vi.mock("@saas/payments/lib/ai-usage-limit-toast", () => ({
	useShowAiUsageLimitToast: () => vi.fn(),
	isAiUsageLimitExceededPayload: () => false,
}));

function runRequestInit(): RequestInit {
	return {
		method: "POST",
		body: JSON.stringify({
			method: "agent/run",
			params: { agentId: "a", threadId: "t" },
		}),
	};
}

function stopRequestInit(): RequestInit {
	return {
		method: "POST",
		body: JSON.stringify({
			method: "agent/stop",
			params: { agentId: "a", threadId: "t" },
		}),
	};
}

describe("CopilotFetchErrorInterceptor — agent/stop backoff bypass", () => {
	let originalFetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		originalFetchMock = vi.fn();
		window.fetch = originalFetchMock as unknown as typeof window.fetch;
	});

	it("blocks a second run POST with a synthetic client-backoff 429, but lets agent/stop through", async () => {
		render(<CopilotFetchErrorInterceptor />);

		// First run POST: real fetch returns a 429 with a Retry-After — this
		// arms the client-side backoff window.
		originalFetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ error: "rate limited" }), {
				status: 429,
				headers: { "Retry-After": "5" },
			}),
		);
		const firstResponse = await window.fetch(
			"/api/copilotkit",
			runRequestInit(),
		);
		expect(firstResponse.status).toBe(429);
		expect(originalFetchMock).toHaveBeenCalledTimes(1);

		// Second run POST within the backoff window must NOT reach the real
		// fetch — it gets the synthetic client-side 429 instead.
		const secondResponse = await window.fetch(
			"/api/copilotkit",
			runRequestInit(),
		);
		expect(secondResponse.status).toBe(429);
		expect(secondResponse.headers.get("X-Rate-Limit-Source")).toBe(
			"client-backoff",
		);
		expect(originalFetchMock).toHaveBeenCalledTimes(1);

		// An agent/stop POST during that same backoff window MUST reach the
		// real fetch — swallowing it would leave the server-side thread lock
		// held.
		originalFetchMock.mockResolvedValueOnce(
			new Response(null, { status: 200 }),
		);
		const stopResponse = await window.fetch(
			"/api/copilotkit",
			stopRequestInit(),
		);
		expect(stopResponse.status).toBe(200);
		expect(originalFetchMock).toHaveBeenCalledTimes(2);
	});
});
