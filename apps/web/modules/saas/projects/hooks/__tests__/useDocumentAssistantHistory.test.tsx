/**
 * Unit tests for `useDocumentAssistantHistory` — Group F.1.
 *
 * Covers spec 2026-05-19-ai-assistant-document-chat-history §6.4:
 *   - Infinite list pagination consumes `nextCursor` correctly across
 *     two pages.
 *   - `useRenameDocumentAssistantConversation` optimistically rewrites
 *     the matching row in cached list pages and rolls back on failure.
 *   - `useDeleteDocumentAssistantConversation` optimistically removes
 *     the row and rolls back on failure.
 *   - When the feature flag is off, mutations reject with the
 *     "history disabled" message and reads stay disabled.
 */

import {
	type InfiniteData,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — shared between the factories and the test bodies so the
// same vi.fn instances surface in both places.
// ---------------------------------------------------------------------------

const { mockFeatureEnabled, mockListHandler, mockClient } = vi.hoisted(() => {
	const listHandler = vi.fn();
	return {
		mockFeatureEnabled: { current: true as boolean },
		// `mockListHandler` is shared between the `orpc.infiniteOptions`
		// mock path (legacy — kept for any consumer that still uses it)
		// and the `orpcClient.agents.conversations.listForDocument` path
		// that `useDocumentAssistantHistoryList` calls directly after the
		// drawer-cache-key refactor. Aliasing the two ensures tests that
		// stub `mockListHandler.mockResolvedValueOnce(...)` continue to
		// drive the list query regardless of which surface invokes it.
		mockListHandler: listHandler,
		mockClient: {
			agents: {
				conversations: {
					renameForDocument: vi.fn(),
					deleteForDocument: vi.fn(),
					archiveForDocument: vi.fn(),
					setVisibilityForDocument: vi.fn(),
					appendTurnForDocument: vi.fn(),
					recordDiffOutcome: vi.fn(),
					getActiveForDocument: vi.fn(),
					getByIdForDocument: vi.fn(),
					listForDocument: listHandler,
				},
			},
		},
	};
});

vi.mock("../useDocumentAssistantHistoryEnabled", () => ({
	useDocumentAssistantHistoryEnabled: () => mockFeatureEnabled.current,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: mockClient,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		agents: {
			conversations: {
				listForDocument: {
					infiniteOptions: (opts: {
						input: (
							cursor: string | undefined,
						) => Record<string, unknown>;
						initialPageParam: unknown;
						getNextPageParam: (lastPage: unknown) => unknown;
						enabled?: boolean;
					}) => ({
						queryKey: [
							"orpc",
							"agents.conversations.listForDocument",
							opts.input(undefined),
						],
						queryFn: (ctx: { pageParam: string | undefined }) =>
							mockListHandler(opts.input(ctx.pageParam)),
						initialPageParam: opts.initialPageParam,
						getNextPageParam: opts.getNextPageParam,
						enabled: opts.enabled,
					}),
				},
			},
		},
	},
}));

import {
	documentAssistantHistoryKeys,
	useDeleteDocumentAssistantConversation,
	useDocumentAssistantConversationById,
	useDocumentAssistantHistoryList,
	useRenameDocumentAssistantConversation,
} from "../useDocumentAssistantHistory";

interface ListPage {
	items: Array<{
		id: string;
		conversationId: string;
		title: string | null;
		messageCount: number;
		firstPromptPreview: string | null;
		authorId: string;
		authorName: string | null;
		authorAvatarUrl: string | null;
		visibility: "SHARED" | "PRIVATE";
		visibilityLockedAt: string | null;
		archivedAt: string | null;
		createdAt: string;
		updatedAt: string;
		parentConversationId: string | null;
	}>;
	nextCursor: string | null;
}

function makeRow(
	id: string,
	overrides: Partial<ListPage["items"][number]> = {},
) {
	return {
		id: `row-${id}`,
		conversationId: id,
		title: `Title ${id}`,
		messageCount: 2,
		firstPromptPreview: "preview",
		authorId: "user-1",
		authorName: "User One",
		authorAvatarUrl: null,
		visibility: "SHARED" as const,
		visibilityLockedAt: null,
		archivedAt: null,
		createdAt: "2026-05-19T00:00:00.000Z",
		updatedAt: "2026-05-19T00:00:00.000Z",
		parentConversationId: null,
		...overrides,
	};
}

const SCOPE = {
	documentRefKind: "PROJECT_DOCUMENT" as const,
	documentRefId: "doc-1",
	projectId: "proj-1",
	organizationId: "org-1",
};

function makeWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	mockFeatureEnabled.current = true;
	mockListHandler.mockReset();
	mockClient.agents.conversations.renameForDocument.mockReset();
	mockClient.agents.conversations.deleteForDocument.mockReset();
	mockClient.agents.conversations.getByIdForDocument.mockReset();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("useDocumentAssistantHistoryList — infinite pagination", () => {
	it("returns the first page and then loads a second page via fetchNextPage", async () => {
		const pageA: ListPage = {
			items: [makeRow("c-1"), makeRow("c-2")],
			nextCursor: "cur-page-2",
		};
		const pageB: ListPage = {
			items: [makeRow("c-3")],
			nextCursor: null,
		};
		mockListHandler
			.mockResolvedValueOnce(pageA)
			.mockResolvedValueOnce(pageB);

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(
			() => useDocumentAssistantHistoryList(SCOPE),
			{ wrapper: makeWrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data?.pages[0]?.items.length).toBe(2);
		expect(result.current.hasNextPage).toBe(true);

		await act(async () => {
			await result.current.fetchNextPage();
		});

		await waitFor(() => {
			expect(result.current.data?.pages.length).toBe(2);
		});
		expect(result.current.data?.pages[1]?.items.length).toBe(1);
		expect(result.current.hasNextPage).toBe(false);
		// Second call should have been invoked with the cursor from page A.
		const secondCallArgs = mockListHandler.mock.calls[1]?.[0] as {
			cursor: string | undefined;
		};
		expect(secondCallArgs?.cursor).toBe("cur-page-2");
	});

	it("does not fire the query when the feature flag is off", async () => {
		mockFeatureEnabled.current = false;
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		renderHook(() => useDocumentAssistantHistoryList(SCOPE), {
			wrapper: makeWrapper(client),
		});
		// Give react-query a tick to settle.
		await new Promise((r) => setTimeout(r, 10));
		expect(mockListHandler).not.toHaveBeenCalled();
	});
});

describe("useRenameDocumentAssistantConversation", () => {
	it("optimistically updates the title in the cached list pages", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const listKey = documentAssistantHistoryKeys.list(SCOPE);
		const initial: InfiniteData<ListPage> = {
			pages: [
				{
					items: [
						makeRow("c-1", { title: "Old title" }),
						makeRow("c-2", { title: "Other title" }),
					],
					nextCursor: null,
				},
			],
			pageParams: [undefined as string | undefined],
		};
		client.setQueryData<InfiniteData<ListPage>>(listKey, initial);

		mockClient.agents.conversations.renameForDocument.mockResolvedValue({
			conversation: { id: "c-1", title: "New title" },
		});

		const { result } = renderHook(
			() => useRenameDocumentAssistantConversation(),
			{ wrapper: makeWrapper(client) },
		);

		await act(async () => {
			await result.current.mutateAsync({
				conversationId: "c-1",
				title: "New title",
				scope: SCOPE,
			});
		});

		const cached = client.getQueryData<InfiniteData<ListPage>>(listKey);
		expect(cached?.pages[0]?.items[0]?.title).toBe("New title");
		// Unrelated row stays untouched.
		expect(cached?.pages[0]?.items[1]?.title).toBe("Other title");
	});

	it("rolls back the optimistic update on mutation failure", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const listKey = documentAssistantHistoryKeys.list(SCOPE);
		const initial: InfiniteData<ListPage> = {
			pages: [
				{
					items: [makeRow("c-1", { title: "Stable title" })],
					nextCursor: null,
				},
			],
			pageParams: [undefined as string | undefined],
		};
		client.setQueryData<InfiniteData<ListPage>>(listKey, initial);

		mockClient.agents.conversations.renameForDocument.mockRejectedValue(
			new Error("boom"),
		);

		const { result } = renderHook(
			() => useRenameDocumentAssistantConversation(),
			{ wrapper: makeWrapper(client) },
		);

		await expect(
			act(async () => {
				await result.current.mutateAsync({
					conversationId: "c-1",
					title: "Attempted title",
					scope: SCOPE,
				});
			}),
		).rejects.toThrow("boom");

		const cached = client.getQueryData<InfiniteData<ListPage>>(listKey);
		expect(cached?.pages[0]?.items[0]?.title).toBe("Stable title");
	});
});

describe("useDeleteDocumentAssistantConversation", () => {
	it("optimistically removes the row from the cached list pages", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const listKey = documentAssistantHistoryKeys.list(SCOPE);
		const initial: InfiniteData<ListPage> = {
			pages: [
				{
					items: [makeRow("c-1"), makeRow("c-2")],
					nextCursor: null,
				},
			],
			pageParams: [undefined as string | undefined],
		};
		client.setQueryData<InfiniteData<ListPage>>(listKey, initial);

		mockClient.agents.conversations.deleteForDocument.mockResolvedValue({
			deletedConversationId: "c-1",
		});

		const { result } = renderHook(
			() => useDeleteDocumentAssistantConversation(),
			{ wrapper: makeWrapper(client) },
		);

		await act(async () => {
			await result.current.mutateAsync({
				conversationId: "c-1",
				scope: SCOPE,
			});
		});

		const cached = client.getQueryData<InfiniteData<ListPage>>(listKey);
		expect(cached?.pages[0]?.items.length).toBe(1);
		expect(cached?.pages[0]?.items[0]?.conversationId).toBe("c-2");
	});

	it("rolls back the optimistic removal on mutation failure", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const listKey = documentAssistantHistoryKeys.list(SCOPE);
		const initial: InfiniteData<ListPage> = {
			pages: [
				{
					items: [makeRow("c-1"), makeRow("c-2")],
					nextCursor: null,
				},
			],
			pageParams: [undefined as string | undefined],
		};
		client.setQueryData<InfiniteData<ListPage>>(listKey, initial);

		mockClient.agents.conversations.deleteForDocument.mockRejectedValue(
			new Error("forbidden"),
		);

		const { result } = renderHook(
			() => useDeleteDocumentAssistantConversation(),
			{ wrapper: makeWrapper(client) },
		);

		await expect(
			act(async () => {
				await result.current.mutateAsync({
					conversationId: "c-1",
					scope: SCOPE,
				});
			}),
		).rejects.toThrow("forbidden");

		const cached = client.getQueryData<InfiniteData<ListPage>>(listKey);
		expect(cached?.pages[0]?.items.length).toBe(2);
	});

	it("rejects with the disabled message when the feature flag is off", async () => {
		mockFeatureEnabled.current = false;
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(
			() => useDeleteDocumentAssistantConversation(),
			{ wrapper: makeWrapper(client) },
		);
		await expect(
			act(async () => {
				await result.current.mutateAsync({
					conversationId: "c-1",
					scope: SCOPE,
				});
			}),
		).rejects.toThrow(/disabled/i);
		expect(
			mockClient.agents.conversations.deleteForDocument,
		).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Group F.13 — `useDocumentAssistantConversationById`
// ---------------------------------------------------------------------------

describe("useDocumentAssistantConversationById", () => {
	const BY_ID_SCOPE = {
		conversationId: "conv-1" as string | null,
		documentRefKind: "PROJECT_DOCUMENT" as const,
		documentRefId: "doc-1",
		projectId: "proj-1",
		organizationId: "org-1" as string | null,
	};

	it("skips the fetch when conversationId is null", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		renderHook(
			() =>
				useDocumentAssistantConversationById({
					...BY_ID_SCOPE,
					conversationId: null,
				}),
			{ wrapper: makeWrapper(client) },
		);
		// Settle a tick to allow react-query to act on `enabled: false`.
		await new Promise((r) => setTimeout(r, 10));
		expect(
			mockClient.agents.conversations.getByIdForDocument,
		).not.toHaveBeenCalled();
	});

	it("does not fetch when the feature flag is off", async () => {
		mockFeatureEnabled.current = false;
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		renderHook(() => useDocumentAssistantConversationById(BY_ID_SCOPE), {
			wrapper: makeWrapper(client),
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(
			mockClient.agents.conversations.getByIdForDocument,
		).not.toHaveBeenCalled();
	});

	it("returns the conversation payload when the mocked client resolves one", async () => {
		mockClient.agents.conversations.getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "row-1",
				conversationId: "conv-1",
				title: "Prior thread",
				visibility: "SHARED",
				visibilityLockedAt: null,
				archivedAt: null,
				messages: [{ id: "u1", role: "user", content: "hello" }],
				parentConversationId: null,
				agentId: "agent-1",
				createdAt: "2026-05-19T00:00:00.000Z",
				updatedAt: "2026-05-19T00:00:00.000Z",
			},
		});

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const { result } = renderHook(
			() => useDocumentAssistantConversationById(BY_ID_SCOPE),
			{ wrapper: makeWrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		const conv = (
			result.current.data as { conversation: { conversationId: string } }
		).conversation;
		expect(conv.conversationId).toBe("conv-1");
		expect(
			mockClient.agents.conversations.getByIdForDocument,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				documentRefKind: "PROJECT_DOCUMENT",
				documentRefId: "doc-1",
				projectId: "proj-1",
				organizationId: "org-1",
			}),
		);
	});

	// Real guard for the per-observer option forwarding.
	// The QueryClient default below pins `staleTime: Infinity`, so a freshly
	// resolved query is NOT stale by default. The only way an observer can be
	// stale immediately after success is if the hook actually forwards the
	// per-observer `staleTime: 0`. Deleting the option-spread lines in the
	// source makes the first assertion fail — so this can't pass as a no-op.
	it("forwards staleTime:0 so the observer is stale right after success", async () => {
		mockClient.agents.conversations.getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "da1",
				conversationId: "c1",
				messages: [],
				title: null,
			},
		});

		const client = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: Number.POSITIVE_INFINITY,
				},
			},
		});
		const { result } = renderHook(
			() =>
				useDocumentAssistantConversationById({
					conversationId: "c1",
					documentRefKind: "USER_STORY",
					documentRefId: "s1",
					projectId: "p1",
					organizationId: null,
					staleTime: 0,
					refetchOnWindowFocus: true,
					refetchOnReconnect: true,
				}),
			{ wrapper: makeWrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		// Only true if the forwarded `staleTime: 0` overrode the Infinity default.
		expect(result.current.isStale).toBe(true);
	});

	it("without a staleTime override the observer inherits the non-stale default", async () => {
		mockClient.agents.conversations.getByIdForDocument.mockResolvedValue({
			conversation: {
				id: "da2",
				conversationId: "c2",
				messages: [],
				title: null,
			},
		});

		const client = new QueryClient({
			defaultOptions: {
				queries: {
					retry: false,
					staleTime: Number.POSITIVE_INFINITY,
				},
			},
		});
		const { result } = renderHook(
			() =>
				useDocumentAssistantConversationById({
					conversationId: "c2",
					documentRefKind: "USER_STORY",
					documentRefId: "s1",
					projectId: "p1",
					organizationId: null,
				}),
			{ wrapper: makeWrapper(client) },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		// No override → the QueryClient's `staleTime: Infinity` default holds.
		expect(result.current.isStale).toBe(false);
	});
});
