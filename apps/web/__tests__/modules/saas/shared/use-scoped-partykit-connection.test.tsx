import { useScopedPartyKitConnection } from "@saas/shared/hooks/use-scoped-partykit-connection";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
	static instances: FakeSocket[] = [];
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	close = vi.fn();

	constructor(readonly url: string) {
		FakeSocket.instances.push(this);
	}

	open() {
		this.onopen?.(new Event("open"));
	}

	serverClose(code = 1006) {
		this.onclose?.(new CloseEvent("close", { code, wasClean: false }));
	}
}

const fetchMock = vi.fn<typeof fetch>();
const options = {
	roomId: "example-room",
	userId: "example-user",
	party: "orchestrator",
	tokenEndpoint: "/api/example/live-token",
	buildTokenBody: (roomId: string) => ({ executionId: roomId }),
	isTerminalTokenStatus: (status: number) =>
		status === 401 || status === 403 || status === 404,
	logTag: "ExamplePartyKit",
	onMessage: vi.fn(),
};

function tokenResponse(token = "test-live-token") {
	return Response.json({ token, expiresIn: 600 });
}

async function flush() {
	await act(async () => {});
}

async function advance(ms: number) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function newestSocket() {
	const socket = FakeSocket.instances.at(-1);
	if (!socket) {
		throw new Error("Expected a connection");
	}
	return socket;
}

describe("useScopedPartyKitConnection", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "live.example.com");
		vi.stubGlobal("WebSocket", FakeSocket);
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		FakeSocket.instances = [];
		fetchMock.mockReset();
		fetchMock.mockImplementation(async () => tokenResponse());
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("bounds token failures and never connects remotely without a token", async () => {
		fetchMock.mockRejectedValue(new Error("network unavailable"));
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		await advance(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(FakeSocket.instances).toHaveLength(0);
		await advance(600_000);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("re-arms one burst after an online event and cooldown", async () => {
		fetchMock.mockRejectedValue(new Error("network unavailable"));
		const { result } = renderHook(() =>
			useScopedPartyKitConnection(options),
		);
		await flush();
		await advance(60_000);
		fetchMock.mockImplementation(async () => tokenResponse());
		act(() => {
			window.dispatchEvent(new Event("online"));
			window.dispatchEvent(new Event("online"));
			document.dispatchEvent(new Event("visibilitychange"));
		});
		await advance(29_999);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		await advance(1);
		expect(fetchMock).toHaveBeenCalledTimes(7);
		expect(FakeSocket.instances).toHaveLength(1);
		act(() => newestSocket().open());
		expect(result.current.isConnected).toBe(true);
	});

	it("waits for a visible online viewer before foreground recovery", async () => {
		fetchMock.mockRejectedValue(new Error("network unavailable"));
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		await advance(90_000);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		act(() => window.dispatchEvent(new Event("online")));
		await advance(1);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
		fetchMock.mockImplementation(async () => tokenResponse());
		act(() => document.dispatchEvent(new Event("visibilitychange")));
		await advance(1);
		expect(FakeSocket.instances).toHaveLength(1);
	});

	it.each([401, 403, 404])(
		"keeps token refusal %i terminal across recovery events",
		async (status) => {
			fetchMock.mockImplementation(
				async () => new Response(null, { status }),
			);
			renderHook(() => useScopedPartyKitConnection(options));
			await flush();
			await advance(600_000);
			act(() => {
				window.dispatchEvent(new Event("online"));
				document.dispatchEvent(new Event("visibilitychange"));
			});
			await advance(60_000);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(FakeSocket.instances).toHaveLength(0);
		},
	);

	it("resets the retry budget only after a socket proves healthy", async () => {
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		act(() => newestSocket().serverClose());
		await advance(2000);
		act(() => newestSocket().open());
		await advance(5000);
		act(() => newestSocket().serverClose());
		await advance(1999);
		expect(FakeSocket.instances).toHaveLength(2);
		await advance(1);
		expect(FakeSocket.instances).toHaveLength(3);
	});

	it("caps post-handshake 4001 rejections and does not revive them", async () => {
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		for (const delay of [2000, 4000, 8000]) {
			act(() => {
				newestSocket().open();
				newestSocket().serverClose(4001);
			});
			await advance(delay);
		}
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(FakeSocket.instances).toHaveLength(3);
		await advance(60_000);
		act(() => window.dispatchEvent(new Event("online")));
		await advance(60_000);
		expect(FakeSocket.instances).toHaveLength(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("recovers an exhausted socket transport without losing credential requirements", async () => {
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		for (const delay of [2000, 4000, 8000, 16000, 30000]) {
			act(() => newestSocket().serverClose());
			await advance(delay);
		}
		act(() => newestSocket().serverClose());
		await advance(30_000);
		expect(FakeSocket.instances).toHaveLength(6);
		act(() => window.dispatchEvent(new Event("online")));
		await advance(1);
		expect(FakeSocket.instances).toHaveLength(7);
		for (const socket of FakeSocket.instances) {
			expect(new URL(socket.url).searchParams.get("token")).toBe(
				"test-live-token",
			);
		}
	});

	it("uses a fresh token and closes the previous socket on a user/room switch", async () => {
		fetchMock.mockImplementationOnce(async () =>
			tokenResponse("first-token"),
		);
		const view = renderHook(
			({ roomId, userId }) =>
				useScopedPartyKitConnection({ ...options, roomId, userId }),
			{ initialProps: { roomId: "room-one", userId: "user-one" } },
		);
		await flush();
		const first = newestSocket();
		view.rerender({ roomId: "room-two", userId: "user-two" });
		await flush();
		expect(first.close).toHaveBeenCalledWith(
			1000,
			"Connection scope ended",
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const secondUrl = new URL(newestSocket().url);
		expect(secondUrl.pathname).toBe("/parties/orchestrator/room-two");
		expect(secondUrl.searchParams.get("userId")).toBe("user-two");
		expect(secondUrl.searchParams.get("token")).toBe("test-live-token");
	});

	it("aborts pending token work and removes recovery listeners on unmount", async () => {
		let resolveToken: (response: Response) => void = () => {};
		fetchMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveToken = resolve;
				}),
		);
		const { unmount } = renderHook(() =>
			useScopedPartyKitConnection(options),
		);
		const signal = fetchMock.mock.calls[0]?.[1]?.signal;
		unmount();
		expect(signal?.aborted).toBe(true);
		resolveToken(tokenResponse());
		await flush();
		act(() => window.dispatchEvent(new Event("online")));
		await advance(600_000);
		expect(FakeSocket.instances).toHaveLength(0);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels a queued recovery on unmount", async () => {
		fetchMock.mockRejectedValue(new Error("network unavailable"));
		const { unmount } = renderHook(() =>
			useScopedPartyKitConnection(options),
		);
		await flush();
		await advance(60_000);
		act(() => window.dispatchEvent(new Event("online")));
		unmount();
		await advance(600_000);
		expect(fetchMock).toHaveBeenCalledTimes(6);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the explicit localhost token-less development mode", async () => {
		vi.stubEnv("NEXT_PUBLIC_PARTYKIT_HOST", "localhost:1999");
		fetchMock.mockRejectedValue(
			new Error("local token endpoint unavailable"),
		);
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		expect(new URL(newestSocket().url).protocol).toBe("ws:");
		expect(new URL(newestSocket().url).searchParams.has("token")).toBe(
			false,
		);
	});

	it("logs only flat state fields without leaking socket events or tokens", async () => {
		renderHook(() => useScopedPartyKitConnection(options));
		await flush();
		act(() => {
			newestSocket().open();
			newestSocket().onerror?.(new Event("error"));
			newestSocket().serverClose();
		});
		expect(console.info).toHaveBeenCalled();
		for (const [message, fields] of vi.mocked(console.info).mock.calls) {
			expect(message).toBe("[ExamplePartyKit] Connection state");
			expect(Object.keys(fields)).toEqual([
				"phase",
				"retry",
				"tokenStatus",
				"closeCode",
				"wasClean",
			]);
			expect(JSON.stringify(fields)).not.toContain("test-live-token");
			expect(JSON.stringify(fields)).not.toContain("live.example.com");
		}
	});
});
