import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getByIdForDocument = vi.fn();
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		agents: {
			conversations: {
				getByIdForDocument: (...a: unknown[]) =>
					getByIdForDocument(...a),
			},
		},
	},
}));
vi.mock("../../../hooks/useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => true,
}));
let capturedOnAppended: ((e: unknown) => void) | undefined;
// Every call records the onMessageAppended identity so test (e) can assert
// the reference is STABLE across re-renders (the SSE-stability guard).
const capturedOnAppendedHistory: Array<((e: unknown) => void) | undefined> = [];
// Records the `enabled` flag passed to the realtime hook on every render so the
// gating test can assert the SSE only opens once the conversation is confirmed.
const capturedEnabledHistory: Array<boolean | undefined> = [];
vi.mock("../../../../agents/hooks/useConversationRealtime", () => ({
	useConversationRealtime: (opts: {
		onMessageAppended?: (e: unknown) => void;
		enabled?: boolean;
	}) => {
		capturedOnAppended = opts.onMessageAppended;
		capturedOnAppendedHistory.push(opts.onMessageAppended);
		capturedEnabledHistory.push(opts.enabled);
		return { status: "connected", liveRegionMessage: "" };
	},
}));

import {
	HydratedMessagesProvider,
	useHydratedMessages,
} from "../HydratedMessagesContext";

function Probe() {
	const api = useHydratedMessages();
	return (
		<div data-testid="ids">
			{(api?.historicalMessages ?? [])
				.map((m) => (m as { id: string }).id)
				.join(",")}
		</div>
	);
}
function renderProvider(props: {
	initialMessages: Array<Record<string, unknown>>;
	ssrConversationId: string | null;
	activeConversationId: string | null;
}) {
	// Disable the QueryClient's focus-refetch + stale defaults so the focus
	// refetch in test (d) can ONLY be driven by the provider's per-observer
	// overrides (refetchOnWindowFocus:true + staleTime:0). TanStack Query v5
	// defaults BOTH ON, which would make the focus-refetch test pass even if
	// the provider dropped its overrides — a no-op guard. Forcing the client
	// defaults OFF restores the contrast: test (d) fails unless the provider
	// forwards the overrides through useDocumentAssistantConversationById.
	const qc = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				refetchOnWindowFocus: false,
				staleTime: Number.POSITIVE_INFINITY,
			},
		},
	});
	return render(
		<QueryClientProvider client={qc}>
			<HydratedMessagesProvider
				documentRefKind="USER_STORY"
				documentRefId="s1"
				projectId="p1"
				organizationId={null}
				{...props}
			>
				<Probe />
			</HydratedMessagesProvider>
		</QueryClientProvider>,
	);
}
const SSR = [{ id: "ssr1", role: "assistant", content: "hi" }];

describe("HydratedMessagesProvider — AC-2 reactive history (byId)", () => {
	beforeEach(() => {
		getByIdForDocument.mockReset();
		capturedOnAppended = undefined;
		capturedOnAppendedHistory.length = 0;
		capturedEnabledHistory.length = 0;
		focusManager.setFocused(undefined);
	});

	it("first paint shows SSR initialMessages, then byId messages win", async () => {
		getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "da1",
				conversationId: "c1",
				messages: [
					{ id: "ssr1", role: "assistant", content: "hi" },
					{
						id: "sys1",
						role: "system",
						content: "SYSTEM\n\nDone.",
						metadata: {
							kind: "operation_result",
							outcome: "success",
						},
					},
				],
			},
		});
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		expect(screen.getByTestId("ids").textContent).toBe("ssr1");
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("ssr1,sys1"),
		);
	});

	it("resolved {conversation:null} drops stale SSR (does not keep showing the old transcript)", async () => {
		// SSR thread (ssr === active === c1) first-paints from initialMessages,
		// then the byId query RESOLVES with conversation:null — the thread was
		// archived / deleted / visibility-hidden (or flag off) while away. Trust
		// the server: the stale SSR transcript must be dropped, not kept.
		getByIdForDocument.mockResolvedValue({ conversation: null });
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		// First paint: SSR fallback (query still pending).
		expect(screen.getByTestId("ids").textContent).toBe("ssr1");
		// After the query resolves null, historical goes empty.
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe(""),
		);
	});

	it("keeps the realtime SSE disabled for a missing/null conversation (no 404 retry spam)", async () => {
		// A stale / not-yet-persisted / cross-tenant id resolves to
		// conversation:null. The SSE must stay disabled so we never open a
		// connection that 404s and retries 5× (EventSource can't see the status).
		getByIdForDocument.mockResolvedValue({ conversation: null });
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe(""),
		);
		expect(capturedEnabledHistory.at(-1)).toBe(false);
	});

	it("enables the realtime SSE once the conversation is confirmed to exist", async () => {
		getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "da1",
				conversationId: "c1",
				messages: [
					{
						id: "sys1",
						role: "system",
						content: "SYSTEM\n\nDone.",
						metadata: {
							kind: "operation_result",
							outcome: "success",
						},
					},
				],
			},
		});
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("sys1"),
		);
		expect(capturedEnabledHistory.at(-1)).toBe(true);
	});

	it("AC-2 for a NEW conversation: byId(activeId) shows that thread (not SSR-gated)", async () => {
		getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "da2",
				conversationId: "c2",
				messages: [
					{
						id: "sys2",
						role: "system",
						content: "SYSTEM\n\nDone.",
						metadata: {
							kind: "operation_result",
							outcome: "success",
						},
					},
				],
			},
		});
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c2",
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("sys2"),
		);
	});

	it("realtime message_appended invalidates byId → refetch surfaces new msg", async () => {
		getByIdForDocument.mockResolvedValueOnce({
			conversation: { id: "da1", conversationId: "c1", messages: SSR },
		});
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("ssr1"),
		);
		getByIdForDocument.mockResolvedValueOnce({
			conversation: {
				id: "da1",
				conversationId: "c1",
				messages: [
					...SSR,
					{
						id: "sys1",
						role: "system",
						content: "SYSTEM\n\nDone.",
						metadata: {
							kind: "operation_result",
							outcome: "success",
						},
					},
				],
			},
		});
		await act(async () => {
			capturedOnAppended?.({
				conversationId: "c1",
				messageId: "sys1",
				appendedAt: "t",
			});
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("ssr1,sys1"),
		);
	});

	it("focus refetch: window focus triggers refetch that surfaces new message (requires staleTime:0 + refetchOnWindowFocus:true)", async () => {
		// Initial fetch: SSR messages only
		getByIdForDocument.mockResolvedValueOnce({
			conversation: { id: "da1", conversationId: "c1", messages: SSR },
		});
		renderProvider({
			initialMessages: SSR,
			ssrConversationId: "c1",
			activeConversationId: "c1",
		});
		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("ssr1"),
		);

		// Change mock to return new message (arrived while tab was away)
		getByIdForDocument.mockResolvedValueOnce({
			conversation: {
				id: "da1",
				conversationId: "c1",
				messages: [
					...SSR,
					{
						id: "sys1",
						role: "system",
						content: "SYSTEM\n\nDone.",
						metadata: {
							kind: "operation_result",
							outcome: "success",
						},
					},
				],
			},
		});

		// Simulate window focus return — TanStack's focusManager triggers refetch
		// when refetchOnWindowFocus:true and staleTime:0 (query is immediately stale)
		await act(async () => {
			focusManager.setFocused(true);
		});

		await waitFor(() =>
			expect(screen.getByTestId("ids").textContent).toBe("ssr1,sys1"),
		);
	});

	it("passes a STABLE onMessageAppended reference across re-renders (keeps SSE connection from churning)", async () => {
		getByIdForDocument.mockResolvedValue({
			conversation: { id: "da1", conversationId: "c1", messages: SSR },
		});
		const qc = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		// Identical scope props on both renders — only an unrelated `children`
		// node differs, mirroring a CopilotKit streaming re-render that does NOT
		// change any useCallback dep. A non-memoized inline closure would yield a
		// fresh identity each render; useCallback must keep it ===.
		const tree = (key: string) => (
			<QueryClientProvider client={qc}>
				<HydratedMessagesProvider
					documentRefKind="USER_STORY"
					documentRefId="s1"
					projectId="p1"
					organizationId={null}
					initialMessages={SSR}
					ssrConversationId="c1"
					activeConversationId="c1"
				>
					<div data-testid="probe">{key}</div>
				</HydratedMessagesProvider>
			</QueryClientProvider>
		);
		const { rerender } = render(tree("a"));
		await waitFor(() =>
			expect(capturedOnAppendedHistory.length).toBeGreaterThan(0),
		);
		const firstRef =
			capturedOnAppendedHistory[capturedOnAppendedHistory.length - 1];

		// Force a re-render that changes only unrelated content (the child text),
		// leaving every useCallback dep untouched.
		await act(async () => {
			rerender(tree("b"));
		});

		const lastRef =
			capturedOnAppendedHistory[capturedOnAppendedHistory.length - 1];
		expect(capturedOnAppendedHistory.length).toBeGreaterThan(1);
		expect(lastRef).toBe(firstRef);
	});
});
