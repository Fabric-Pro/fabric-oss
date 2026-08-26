/**
 * Connection-safety behavior of useTaskAgentPartyKit (issue #624).
 *
 * Two properties are load-bearing enough to pin:
 *  - a remote worker is never connected to without a token once the token route
 *    has actually answered (404/4xx), no matter how many retries were spent;
 *  - a cached token never survives a change of user.
 *
 * Everything else about the hook (message handling) is exercised through its
 * consumers; this file only drives the socket lifecycle.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskAgentPartyKit } from "../useTaskAgentPartyKit";

const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: mockUseSession,
}));

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: MockWebSocket[] = [];

	readyState: number = MockWebSocket.CONNECTING;
	onopen: (() => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;

	constructor(readonly url: string) {
		MockWebSocket.instances.push(this);
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}
}

const REMOTE_HOST = "party.example.com";
const PLAN_ID = "plan_abc123";

// Advanced one step at a time: a timer scheduled by a promise callback during a
// single large advance is not picked up by that same advance.
const BACKOFF_STEPS_MS = [2100, 4100, 8100, 16100, 30100];

let originalHost: string | undefined;

beforeEach(() => {
	vi.useFakeTimers();
	MockWebSocket.instances = [];
	originalHost = process.env.NEXT_PUBLIC_PARTYKIT_HOST;
	process.env.NEXT_PUBLIC_PARTYKIT_HOST = REMOTE_HOST;
	mockUseSession.mockReturnValue({ user: { id: "user-1" } });
	vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	if (originalHost === undefined) {
		process.env.NEXT_PUBLIC_PARTYKIT_HOST = undefined;
		delete process.env.NEXT_PUBLIC_PARTYKIT_HOST;
	} else {
		process.env.NEXT_PUBLIC_PARTYKIT_HOST = originalHost;
	}
});

function tokenResponse(token: string): Response {
	return new Response(JSON.stringify({ token, expiresIn: 600 }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("useTaskAgentPartyKit", () => {
	it("never connects to a remote worker without a token once the token route has answered", async () => {
		// 404 is retryable (the plan row is written asynchronously) but it is
		// the server answering, so exhausting the budget must NOT downgrade to
		// an unauthenticated connect.
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response("{}", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() => useTaskAgentPartyKit({ planId: PLAN_ID }));

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		for (const step of BACKOFF_STEPS_MS) {
			await act(async () => {
				await vi.advanceTimersByTimeAsync(step);
			});
		}
		// Well past the last backoff: nothing more should be scheduled.
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});

		// One initial attempt plus the five scheduled retries, then it stops —
		// and at no point does it fall back to an unauthenticated socket.
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(MockWebSocket.instances).toHaveLength(0);
	});

	it("re-fetches the token when the user changes instead of reusing the cached one", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("token-user-1"))
			.mockResolvedValueOnce(tokenResponse("token-user-2"));
		vi.stubGlobal("fetch", fetchMock);

		const { rerender } = renderHook(() =>
			useTaskAgentPartyKit({ planId: PLAN_ID }),
		);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(MockWebSocket.instances).toHaveLength(1);
		expect(MockWebSocket.instances[0]?.url).toContain("token=token-user-1");

		mockUseSession.mockReturnValue({ user: { id: "user-2" } });
		rerender();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(MockWebSocket.instances).toHaveLength(2);
		const secondUrl = MockWebSocket.instances[1]?.url ?? "";
		expect(secondUrl).toContain("token=token-user-2");
		expect(secondUrl).toContain("userId=user-2");
		expect(secondUrl).not.toContain("token-user-1");
	});
});
