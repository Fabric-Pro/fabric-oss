/**
 * Authentication recovery behavior for useCollaborativeEditor (issue #335).
 *
 * y-partykit retries its existing WebSocket URL after a close. A 4001 means
 * that URL carries an expired credential, so the hook must replace the
 * provider with one created from a newly minted token instead of letting that
 * retry loop continue indefinitely.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCollaborativeEditor } from "../useCollaborativeEditor";

const { MockYPartyKitProvider, mockUseSession } = vi.hoisted(() => {
	type Listener = (...args: unknown[]) => void;

	class MockYPartyKitProvider {
		static instances: MockYPartyKitProvider[] = [];

		readonly awareness = {
			clientID: 1,
			getStates: () => new Map(),
			on: vi.fn(),
			off: vi.fn(),
			setLocalStateField: vi.fn(),
		};
		readonly destroy = vi.fn();
		readonly connect = vi.fn();
		readonly listeners = new Map<string, Listener>();

		constructor(
			readonly host: string,
			readonly room: string,
			readonly _doc: unknown,
			readonly options: { params?: { token?: string } },
		) {
			MockYPartyKitProvider.instances.push(this);
		}

		on(event: string, listener: Listener): void {
			this.listeners.set(event, listener);
		}

		off(event: string, listener: Listener): void {
			if (this.listeners.get(event) === listener) {
				this.listeners.delete(event);
			}
		}

		emit(event: string, ...args: unknown[]): void {
			this.listeners.get(event)?.(...args);
		}
	}

	return { MockYPartyKitProvider, mockUseSession: vi.fn() };
});

vi.mock("@saas/auth/hooks/use-session", () => ({
	useSession: mockUseSession,
}));

vi.mock("y-partykit/provider", () => ({
	default: MockYPartyKitProvider,
}));

function tokenResponse(token: string): Response {
	return new Response(JSON.stringify({ token }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function deferredResponse(): {
	promise: Promise<Response>;
	resolve: (response: Response) => void;
} {
	let resolve: ((response: Response) => void) | undefined;
	const promise = new Promise<Response>((resolvePromise) => {
		resolve = resolvePromise;
	});

	return {
		promise,
		resolve: (response) => resolve?.(response),
	};
}

describe("useCollaborativeEditor", () => {
	beforeEach(() => {
		MockYPartyKitProvider.instances = [];
		mockUseSession.mockReturnValue({
			user: { id: "user-1", name: "Editor", image: null },
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("replaces the provider with a fresh token after the worker rejects an expired credential", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("expired-token"))
			.mockResolvedValueOnce(tokenResponse("fresh-token"));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() =>
			useCollaborativeEditor({
				documentId: "document-1",
				projectId: "project-1",
			}),
		);

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(1);
		});
		const staleProvider = MockYPartyKitProvider.instances[0];
		expect(staleProvider?.options.params?.token).toBe("expired-token");

		await act(async () => {
			staleProvider?.emit("connection-close", { code: 4001 });
		});

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(2);
		});
		expect(staleProvider?.destroy).toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(MockYPartyKitProvider.instances[1]?.options.params?.token).toBe(
			"fresh-token",
		);
	});

	it("retries a transient token refresh after the worker rejects an expired credential", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("expired-token"))
			.mockResolvedValueOnce(
				new Response("temporary outage", { status: 503 }),
			)
			.mockResolvedValueOnce(tokenResponse("fresh-token"));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() =>
			useCollaborativeEditor({
				documentId: "document-1",
				projectId: "project-1",
			}),
		);

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(1);
		});
		vi.useFakeTimers();

		await act(async () => {
			MockYPartyKitProvider.instances[0]?.emit("connection-close", {
				code: 4001,
			});
			await vi.advanceTimersByTimeAsync(0);
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(MockYPartyKitProvider.instances).toHaveLength(1);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(MockYPartyKitProvider.instances).toHaveLength(2);
		expect(MockYPartyKitProvider.instances[1]?.options.params?.token).toBe(
			"fresh-token",
		);
	});

	it("does not retry a terminal token denial after the worker rejects an expired credential", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("expired-token"))
			.mockResolvedValueOnce(
				new Response("unauthorized", { status: 401 }),
			);
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() =>
			useCollaborativeEditor({
				documentId: "document-1",
				projectId: "project-1",
			}),
		);

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(1);
		});
		vi.useFakeTimers();

		await act(async () => {
			MockYPartyKitProvider.instances[0]?.emit("connection-close", {
				code: 4001,
			});
			await vi.advanceTimersByTimeAsync(60_000);
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(MockYPartyKitProvider.instances).toHaveLength(1);
	});

	it("ignores a cancelled document's token denial while the next document recovers", async () => {
		const staleRefresh = deferredResponse();
		const currentRefresh = deferredResponse();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("document-1-token"))
			.mockImplementationOnce(() => staleRefresh.promise)
			.mockResolvedValueOnce(tokenResponse("document-2-token"))
			.mockImplementationOnce(() => currentRefresh.promise)
			.mockResolvedValueOnce(tokenResponse("document-2-fresh-token"));
		vi.stubGlobal("fetch", fetchMock);

		const { rerender } = renderHook(
			({ documentId }) =>
				useCollaborativeEditor({ documentId, projectId: "project-1" }),
			{ initialProps: { documentId: "document-1" } },
		);

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(1);
		});
		await act(async () => {
			MockYPartyKitProvider.instances[0]?.emit("connection-close", {
				code: 4001,
			});
		});
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		rerender({ documentId: "document-2" });
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(MockYPartyKitProvider.instances).toHaveLength(3);
		});
		await act(async () => {
			MockYPartyKitProvider.instances.at(-1)?.emit("connection-close", {
				code: 4001,
			});
		});
		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(4);
		});

		vi.useFakeTimers();
		await act(async () => {
			staleRefresh.resolve(new Response("unauthorized", { status: 401 }));
			await vi.advanceTimersByTimeAsync(0);
			currentRefresh.resolve(
				new Response("temporary outage", { status: 503 }),
			);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(2_000);
		});

		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(MockYPartyKitProvider.instances).toHaveLength(4);
		expect(
			MockYPartyKitProvider.instances.at(-1)?.options.params?.token,
		).toBe("document-2-fresh-token");
	});

	it("stops refreshing after three consecutive credential rejections", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(tokenResponse("token-1"))
			.mockResolvedValueOnce(tokenResponse("token-2"))
			.mockResolvedValueOnce(tokenResponse("token-3"));
		vi.stubGlobal("fetch", fetchMock);

		renderHook(() =>
			useCollaborativeEditor({
				documentId: "document-1",
				projectId: "project-1",
			}),
		);

		for (const expectedProviders of [2, 3]) {
			await waitFor(() => {
				expect(MockYPartyKitProvider.instances).toHaveLength(
					expectedProviders - 1,
				);
			});
			await act(async () => {
				MockYPartyKitProvider.instances
					.at(-1)
					?.emit("connection-close", { code: 4001 });
			});
		}

		await waitFor(() => {
			expect(MockYPartyKitProvider.instances).toHaveLength(3);
		});
		vi.useFakeTimers();
		await act(async () => {
			MockYPartyKitProvider.instances
				.at(-1)
				?.emit("connection-close", { code: 4001 });
			await vi.advanceTimersByTimeAsync(60_000);
		});

		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(MockYPartyKitProvider.instances).toHaveLength(3);
	});
});
