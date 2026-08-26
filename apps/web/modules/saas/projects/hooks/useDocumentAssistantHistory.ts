"use client";

/**
 * `useDocumentAssistantHistory` — Group F.1.
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §6.4.
 *
 * Thin TanStack Query wrappers around the seven `agents.conversations.*ForDocument`
 * procedures (Group B) plus `recordDiffOutcome`. Provides:
 *
 *   - `useDocumentAssistantHistoryList` — `useInfiniteQuery` over
 *     `listForDocument`, page size 10. Returns the flat row payload plus
 *     `fetchNextPage` etc.
 *   - `useActiveDocumentAssistantConversation` — `useQuery` over
 *     `getActiveForDocument`. Used by the drawer if it wants to mark the
 *     active row in the list.
 *   - Mutations: `useAppendDocumentAssistantTurn`,
 *     `useArchiveDocumentAssistantConversation`,
 *     `useDeleteDocumentAssistantConversation`,
 *     `useRenameDocumentAssistantConversation`,
 *     `useSetDocumentAssistantConversationVisibility`,
 *     `useRecordDocumentAssistantDiffOutcome`.
 *
 * Query-key shape (exported as `documentAssistantHistoryKeys`):
 *
 *   ["documentAssistantHistory", "list",   documentRefKind, documentRefId, projectId, organizationId ?? null]
 *   ["documentAssistantHistory", "active", documentRefKind, documentRefId, projectId, organizationId ?? null]
 *   ["documentAssistantHistory"]                                          // root, used to nuke everything
 *
 * Feature-flag gating
 * -------------------
 * Reads consult `useDocumentAssistantHistoryEnabled()` and set
 * `enabled: false` when the flag is off — the query never fires and the
 * UI sees a stable "no data" placeholder. Mutations no-op (resolve with
 * an explanatory error from the toast) when the flag is off so call sites
 * don't have to guard each invocation.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import {
	type InfiniteData,
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { useDocumentAssistantHistoryEnabled } from "./useDocumentAssistantHistoryEnabled";

// ---------------------------------------------------------------------------
// Cross-tab BroadcastChannel sync
// ---------------------------------------------------------------------------
// When the user has the same document open in two tabs, a rename / delete /
// new-turn in tab A should refresh tab B's drawer without waiting for a focus
// event. We use a single global BroadcastChannel and emit a tiny envelope on
// every successful mutation; the listener side (mounted by `DocumentEditor`
// and `StoryWorkspace` via `useDocumentAssistantHistoryRealtimeSync`) maps
// envelopes back into TanStack Query invalidations.
//
// Why not server-side push? The mutations are already idempotent on the
// server, and the cost of a fresh `listForDocument` round-trip on focus or
// broadcast is trivial. A real Server-Sent-Events / WebSocket pipeline can
// land later if cross-org real-time becomes a hard requirement (e.g.,
// multiple project members in the same shared thread).
//
// Browser support: BroadcastChannel ships in every modern browser and IE is
// unsupported across the rest of the product. We still wrap the constructor
// in `try/catch` so a privacy-mode browser that refuses the API doesn't
// crash the page — the worst case is "no cross-tab refresh", which matches
// pre-change behaviour.
const BROADCAST_CHANNEL_NAME = "document-assistant-history-v1";

/**
 * `localStorage` key for the fallback sync path. BroadcastChannel
 * doesn't cross isolated browsing contexts in some scenarios
 * (privacy-mode partitioning, certain extension sandboxes, the
 * chrome-devtools test harness's `isolatedContext` mode). The
 * `storage` event fires in all cases where two tabs share an origin's
 * storage area, so writing a marker key here on broadcast + reading
 * it via the `storage` event gives us a second propagation path with
 * essentially zero cost.
 */
const BROADCAST_LS_KEY = "document-assistant-history-v1:last-broadcast";

let _broadcastChannel: BroadcastChannel | null = null;
function getBroadcastChannel(): BroadcastChannel | null {
	if (typeof window === "undefined") {
		return null;
	}
	if (_broadcastChannel) {
		return _broadcastChannel;
	}
	if (typeof BroadcastChannel === "undefined") {
		return null;
	}
	try {
		_broadcastChannel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
	} catch {
		_broadcastChannel = null;
	}
	return _broadcastChannel;
}

/**
 * Envelope for cross-tab invalidation. `kind` is the granularity of the
 * invalidation; `scope` narrows it to the same document so unrelated tabs
 * (e.g., a different project) don't refetch unnecessarily. `kind: "all"`
 * sweeps every cached document-assistant query for the scope — the safe
 * default when the mutation could have touched more than one query.
 */
interface DocumentAssistantBroadcastMessage {
	kind: "all" | "list" | "active" | "byId";
	scope: DocumentAssistantHistoryScope;
}

function broadcastDocumentAssistantInvalidation(
	msg: DocumentAssistantBroadcastMessage,
): void {
	// Primary path: BroadcastChannel — instant, scoped, no storage churn.
	const bc = getBroadcastChannel();
	if (bc) {
		try {
			bc.postMessage(msg);
		} catch {
			// Channel is closed / page is mid-unload — broadcasting is
			// best-effort, the localStorage path below or the next focus
			// tick will catch the update.
		}
	}
	// Fallback path: `storage` event via localStorage. Some browsing
	// contexts (privacy mode partitioning, the chrome-devtools test
	// harness's isolated contexts, certain extension sandboxes) refuse
	// BroadcastChannel delivery between tabs. `storage` events fire in
	// every browser whenever a tab on the same origin writes localStorage,
	// so this gives us a second propagation path. We include the message
	// payload + a monotonic timestamp (Date.now() with sub-ms suffix to
	// disambiguate same-tick writes) — listeners diff the timestamp to
	// avoid double-firing when BroadcastChannel ALSO delivers.
	if (typeof window !== "undefined" && window.localStorage) {
		try {
			const envelope = {
				ts: Date.now(),
				rnd: Math.random().toString(36).slice(2, 8),
				msg,
			};
			window.localStorage.setItem(
				BROADCAST_LS_KEY,
				JSON.stringify(envelope),
			);
		} catch {
			// Quota exceeded / storage disabled — best-effort, ignore.
		}
	}
}

/**
 * Mounts a BroadcastChannel listener for the duration of the calling
 * component. When another tab broadcasts a `DocumentAssistantBroadcastMessage`
 * whose scope matches the one passed here, the matching TanStack queries
 * are invalidated so the local UI refetches.
 *
 * Mount this once per consumer surface (e.g., `DocumentEditor`,
 * `StoryWorkspace`). Mounting it deeper inside the drawer would mean
 * cross-tab events only land while the drawer is open — which defeats the
 * point.
 */
export function useDocumentAssistantHistoryRealtimeSync(
	scope: DocumentAssistantHistoryScope,
): void {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const queryClient = useQueryClient();

	const scopeKey = `${scope.documentRefKind}:${scope.documentRefId}:${scope.projectId}:${scope.organizationId ?? "null"}`;

	useEffect(() => {
		if (!featureEnabled) {
			return;
		}
		if (typeof window === "undefined") {
			return;
		}

		// Dedup window to suppress double-invalidations when BOTH paths
		// (BroadcastChannel + storage event) fire for the same broadcast.
		// We key on a 200 ms window — broadcasts are user-triggered, so
		// real bursts are well-separated; a tighter window would risk
		// suppressing two genuinely-different events that happen to land
		// near each other.
		let lastHandledAt = 0;
		const handleEnvelope = (msg: DocumentAssistantBroadcastMessage) => {
			if (!msg || typeof msg !== "object" || !msg.scope) {
				return;
			}
			// Scope-match check — the channel/key is shared across all
			// documents/projects/orgs the user has open, so we filter to
			// just this surface's scope.
			if (
				msg.scope.documentRefKind !== scope.documentRefKind ||
				msg.scope.documentRefId !== scope.documentRefId ||
				msg.scope.projectId !== scope.projectId ||
				(msg.scope.organizationId ?? null) !==
					(scope.organizationId ?? null)
			) {
				return;
			}
			const now = Date.now();
			if (now - lastHandledAt < 200) {
				return;
			}
			lastHandledAt = now;
			if (msg.kind === "all" || msg.kind === "list") {
				queryClient.invalidateQueries({
					queryKey: documentAssistantHistoryKeys.list(scope),
				});
			}
			if (msg.kind === "all" || msg.kind === "active") {
				queryClient.invalidateQueries({
					queryKey: documentAssistantHistoryKeys.active(scope),
				});
			}
			if (msg.kind === "all" || msg.kind === "byId") {
				queryClient.invalidateQueries({
					queryKey: documentAssistantHistoryKeys.all,
				});
			}
		};

		// Primary path: BroadcastChannel.
		const bc = getBroadcastChannel();
		const onBcMessage = (event: MessageEvent) => {
			handleEnvelope(event.data as DocumentAssistantBroadcastMessage);
		};
		if (bc) {
			bc.addEventListener("message", onBcMessage);
		}

		// Fallback path: `storage` event. Fires across browser tabs sharing
		// the origin's localStorage when ANY tab calls `setItem` /
		// `removeItem` / `clear`. The broadcaster writes its envelope to
		// `BROADCAST_LS_KEY`; we parse it back out here. This catches the
		// privacy-mode / extension-sandbox / chrome-devtools-isolated-context
		// cases where BroadcastChannel doesn't propagate.
		const onStorage = (event: StorageEvent) => {
			if (event.key !== BROADCAST_LS_KEY) {
				return;
			}
			if (!event.newValue) {
				return;
			}
			try {
				const envelope = JSON.parse(event.newValue) as {
					msg?: DocumentAssistantBroadcastMessage;
				};
				if (envelope?.msg) {
					handleEnvelope(envelope.msg);
				}
			} catch {
				// Malformed envelope — ignore.
			}
		};
		window.addEventListener("storage", onStorage);

		return () => {
			if (bc) {
				bc.removeEventListener("message", onBcMessage);
			}
			window.removeEventListener("storage", onStorage);
		};
		// scopeKey is a stable string derived from the scope object so we
		// don't re-bind the listener on every parent render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [featureEnabled, scopeKey, queryClient]);
}

const HISTORY_DISABLED_ERROR_MESSAGE =
	"Document assistant history is disabled for this organization";

/** Mirrors `DocumentRefKindSchema` in `_shared.ts`. */
export type DocumentRefKind = "PROJECT_DOCUMENT" | "USER_STORY";

/** Mirrors `DocumentAssistantVisibilitySchema` in `_shared.ts`. */
type DocumentAssistantVisibility = "SHARED" | "PRIVATE";

/**
 * The flat scope every hook in this module accepts as its first argument.
 * Mirrors the procedure's `DocumentRefSchema` exactly so callers don't
 * have to spread/rename.
 */
export interface DocumentAssistantHistoryScope {
	documentRefKind: DocumentRefKind;
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
}

/**
 * Page size for the drawer's infinite list. Matches the spec §5.1 default
 * limit. Bumping this is fine — it's purely a UX trade-off between scroll
 * granularity and round-trips.
 */
const DOCUMENT_ASSISTANT_HISTORY_PAGE_SIZE = 10;

/**
 * Centralised query-key builders so cache invalidation in one mutation
 * stays in lockstep with the read hooks. Mirrors `workflowKeys` pattern.
 *
 * `all` is the broadest key — invalidating it sweeps both list and active
 * queries across every (doc, scope) combination. `list(scope)` /
 * `active(scope)` are the per-scope keys consumed by the read hooks.
 */
export const documentAssistantHistoryKeys = {
	all: ["documentAssistantHistory"] as const,
	list: (scope: DocumentAssistantHistoryScope) =>
		[
			"documentAssistantHistory",
			"list",
			scope.documentRefKind,
			scope.documentRefId,
			scope.projectId,
			scope.organizationId ?? null,
		] as const,
	active: (scope: DocumentAssistantHistoryScope) =>
		[
			"documentAssistantHistory",
			"active",
			scope.documentRefKind,
			scope.documentRefId,
			scope.projectId,
			scope.organizationId ?? null,
		] as const,
	/**
	 * Per-conversation viewer key. The `conversationId` is part of the key
	 * so each prior conversation has its own cache entry — clicking around
	 * in the drawer never refetches the previously-loaded one. Group F.13
	 * hotfix: backs the History drawer's read-only viewer for non-active
	 * threads.
	 */
	byId: (
		conversationId: string,
		documentRefKind: DocumentRefKind,
		documentRefId: string,
		projectId: string,
		organizationId: string | null,
	) =>
		[
			"documentAssistantHistory",
			"byId",
			conversationId,
			documentRefKind,
			documentRefId,
			projectId,
			organizationId,
		] as const,
};

/**
 * Row shape returned by `listForDocument` per page. Re-exported so the
 * drawer doesn't have to reach into the API package's Zod types.
 */
export interface DocumentAssistantHistoryListItem {
	id: string;
	conversationId: string;
	title: string | null;
	messageCount: number;
	firstPromptPreview: string | null;
	authorId: string;
	authorName: string | null;
	authorAvatarUrl: string | null;
	visibility: DocumentAssistantVisibility;
	visibilityLockedAt: string | null;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
	parentConversationId: string | null;
}

interface ListForDocumentResponse {
	items: DocumentAssistantHistoryListItem[];
	nextCursor: string | null;
}

interface UseDocumentAssistantHistoryListOptions {
	enabled?: boolean;
}

/**
 * `useInfiniteQuery` over `agents.conversations.listForDocument`. Returns
 * the standard TanStack infinite query result; consumers flatten via
 * `data?.pages.flatMap((p) => p.items)`.
 *
 * The query is gated on `useDocumentAssistantHistoryEnabled()` so it never
 * fires when the org has the flag off. `enabled` from props can opt out
 * further (e.g. while the parent drawer is closed).
 */
export function useDocumentAssistantHistoryList(
	scope: DocumentAssistantHistoryScope,
	options: UseDocumentAssistantHistoryListOptions = {},
) {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const isEnabled = featureEnabled && (options.enabled ?? true);

	// IMPORTANT: keep this on the SAME `documentAssistantHistoryKeys.list(scope)`
	// queryKey that every mutation / cross-tab broadcast invalidates and
	// optimistic-updates against. The earlier oRPC `infiniteOptions(...)`
	// helper auto-generated a different key shape, so optimistic updates
	// wrote to a phantom cache entry and `invalidateQueries({ queryKey:
	// documentAssistantHistoryKeys.list(scope) })` matched nothing — the
	// drawer didn't refresh after delete/rename/archive and the cross-tab
	// BroadcastChannel listener's invalidations were dropped on the floor.
	// See the cross-tab regression note in the docblock at the top of this
	// file.
	return useInfiniteQuery<
		ListForDocumentResponse,
		Error,
		InfiniteData<ListForDocumentResponse>,
		readonly unknown[],
		string | undefined
	>({
		queryKey: documentAssistantHistoryKeys.list(scope),
		queryFn: ({ pageParam }) =>
			orpcClient.agents.conversations.listForDocument({
				documentRefKind: scope.documentRefKind,
				documentRefId: scope.documentRefId,
				projectId: scope.projectId,
				organizationId: scope.organizationId,
				cursor: pageParam,
				limit: DOCUMENT_ASSISTANT_HISTORY_PAGE_SIZE,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage: ListForDocumentResponse) =>
			lastPage.nextCursor ?? undefined,
		enabled: isEnabled,
	});
}

interface UseActiveDocumentAssistantConversationOptions {
	enabled?: boolean;
}

/**
 * `useQuery` over `agents.conversations.getActiveForDocument`. The drawer
 * uses this to identify which row in the list (if any) is the user's
 * currently-active thread so it can render an "active" indicator. Returns
 * the conversation summary (or `null`) shaped by the procedure.
 */
export function useActiveDocumentAssistantConversation(
	scope: DocumentAssistantHistoryScope,
	options: UseActiveDocumentAssistantConversationOptions = {},
) {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const isEnabled = featureEnabled && (options.enabled ?? true);

	return useQuery({
		queryKey: documentAssistantHistoryKeys.active(scope),
		queryFn: () =>
			orpcClient.agents.conversations.getActiveForDocument({
				documentRefKind: scope.documentRefKind,
				documentRefId: scope.documentRefId,
				projectId: scope.projectId,
				organizationId: scope.organizationId,
			}),
		enabled: isEnabled,
	});
}

interface UseDocumentAssistantConversationByIdOptions {
	enabled?: boolean;
}

/**
 * `useQuery` over `agents.conversations.getByIdForDocument` — Group F.13.
 *
 * Loads any single conversation (active or not) for the read-only viewer
 * pane in `<CopilotHistoryDrawer>`. Disabled until `conversationId` is
 * non-null so the drawer can wire it directly to `selectedConversationId`
 * without manual guarding at each call site.
 *
 * Cache invalidation: the Group F mutations (`useArchive`, `useDelete`,
 * `useRename`, `useSetVisibility`) invalidate `documentAssistantHistoryKeys.all`
 * via the broader `list` / `active` invalidations they already perform —
 * the `byId` entries sit under the same root prefix, so React Query's
 * partial-match invalidation catches them too. No additional invalidation
 * wiring is required in the mutations.
 *
 * Per-observer overrides (`staleTime`, `refetchOnWindowFocus`,
 * `refetchOnReconnect`) are intentionally optional and default to
 * `undefined` so existing callers (the History drawer viewer) are
 * unaffected. They are provided by the Fizzy #1412 AC-2 message-list
 * consumer (`HydratedMessagesProvider`) which needs `staleTime: 0` so
 * a window-focus refetch actually fires after a backgrounded tab returns.
 */
export function useDocumentAssistantConversationById({
	conversationId,
	documentRefKind,
	documentRefId,
	projectId,
	organizationId,
	enabled = true,
	staleTime,
	refetchOnWindowFocus,
	refetchOnReconnect,
}: {
	conversationId: string | null;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
	projectId: string;
	organizationId: string | null;
	enabled?: boolean;
	/** Per-observer staleTime override. Pass `0` to ensure a window-focus
	 *  refetch always fires. Default-undefined preserves
	 *  the QueryClient's global staleTime for existing callers. */
	staleTime?: number;
	/** Per-observer refetchOnWindowFocus override. */
	refetchOnWindowFocus?: boolean;
	/** Per-observer refetchOnReconnect override. */
	refetchOnReconnect?: boolean;
}) {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const isEnabled = featureEnabled && enabled && conversationId !== null;

	return useQuery({
		queryKey: documentAssistantHistoryKeys.byId(
			conversationId ?? "__none__",
			documentRefKind,
			documentRefId,
			projectId,
			organizationId,
		),
		queryFn: () =>
			orpcClient.agents.conversations.getByIdForDocument({
				conversationId: conversationId as string,
				documentRefKind,
				documentRefId,
				projectId,
				organizationId,
			}),
		enabled: isEnabled,
		...(staleTime !== undefined ? { staleTime } : {}),
		...(refetchOnWindowFocus !== undefined ? { refetchOnWindowFocus } : {}),
		...(refetchOnReconnect !== undefined ? { refetchOnReconnect } : {}),
	});
}

/**
 * Tool-call entry on the persisted message body. Mirrors `MessageSchema`
 * in `packages/api/modules/agents/procedures/conversations/update-conversation.ts`.
 */
interface AppendTurnToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
	result?: string;
	status?: "pending" | "running" | "success" | "error";
}

/**
 * Persisted per-message attachment envelope. Mirrors
 * `MessageAttachmentSchema` on the server.
 */
interface AppendTurnAttachment {
	id: string;
	s3Path: string;
	name: string;
	mimeType: string;
	sizeBytes?: number;
	kind?: "image" | "file";
}

/**
 * Full message envelope to persist. Mirrors `MessageSchema` so the
 * hook is a thin pass-through and the procedure's Zod is the source of
 * truth.
 */
export interface AppendTurnMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: AppendTurnToolCall[];
	agentId?: string;
	metadata?: Record<string, unknown>;
	streamStatus?: "streaming" | "completed" | "error" | "cancelled";
	cancelledAt?: string;
	reasoningText?: string;
	reasoningDurationMs?: number;
	attachments?: AppendTurnAttachment[];
}

interface AppendTurnInput {
	/** `null` on the first turn of a brand-new thread — the procedure
	 * lazy-creates the conversation row in that case. */
	conversationId: string | null;
	scope: DocumentAssistantHistoryScope;
	message: AppendTurnMessage;
	agentId: string;
	requestedVisibility?: DocumentAssistantVisibility;
}

/**
 * Append a completed turn. Group H wires this into the agent's
 * `onStreamComplete`; the drawer never calls it directly. We expose it
 * here so the streaming layer has a single typed surface.
 *
 * On success: invalidates BOTH `list` and `active` for the scope so the
 * drawer's row order updates and the active-id chip refreshes.
 */
export function useAppendDocumentAssistantTurn() {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: AppendTurnInput) => {
			if (!featureEnabled) {
				throw new Error(HISTORY_DISABLED_ERROR_MESSAGE);
			}
			return orpcClient.agents.conversations.appendTurnForDocument({
				documentRefKind: input.scope.documentRefKind,
				documentRefId: input.scope.documentRefId,
				projectId: input.scope.projectId,
				organizationId: input.scope.organizationId,
				conversationId: input.conversationId ?? undefined,
				message: input.message,
				agentId: input.agentId,
				requestedVisibility: input.requestedVisibility,
			});
		},
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.list(vars.scope),
			});
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.active(vars.scope),
			});
			// Also sweep the per-conversation viewer cache so a rename /
			// archive / delete / visibility flip propagates to the drawer's
			// open viewer pane (Group F.13). Uses the prefix-match form so a
			// single invalidate covers every cached byId entry.
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.all,
			});
			// Tell other tabs viewing the same document to refetch their
			// drawer too.
			broadcastDocumentAssistantInvalidation({
				kind: "all",
				scope: vars.scope,
			});
		},
	});
}

interface DeleteConversationInput {
	conversationId: string;
	scope: DocumentAssistantHistoryScope;
}

/**
 * Permanently delete a thread. Optimistically removes the row from the
 * cached list pages so the UI doesn't lag behind the destructive action.
 * Reverts on failure.
 */
export function useDeleteDocumentAssistantConversation() {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: DeleteConversationInput) => {
			if (!featureEnabled) {
				throw new Error(HISTORY_DISABLED_ERROR_MESSAGE);
			}
			return orpcClient.agents.conversations.deleteForDocument({
				conversationId: input.conversationId,
				organizationId: input.scope.organizationId,
			});
		},
		onMutate: async (vars) => {
			const listKey = documentAssistantHistoryKeys.list(vars.scope);
			await queryClient.cancelQueries({ queryKey: listKey });
			const previous =
				queryClient.getQueryData<InfiniteData<ListForDocumentResponse>>(
					listKey,
				);
			if (previous) {
				queryClient.setQueryData<InfiniteData<ListForDocumentResponse>>(
					listKey,
					{
						...previous,
						pages: previous.pages.map((page) => ({
							...page,
							items: page.items.filter(
								(item) =>
									item.conversationId !== vars.conversationId,
							),
						})),
					},
				);
			}
			return { previous };
		},
		onError: (_err, vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					documentAssistantHistoryKeys.list(vars.scope),
					context.previous,
				);
			}
		},
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.list(vars.scope),
			});
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.active(vars.scope),
			});
			// Also sweep the per-conversation viewer cache so a rename /
			// archive / delete / visibility flip propagates to the drawer's
			// open viewer pane (Group F.13). Uses the prefix-match form so a
			// single invalidate covers every cached byId entry.
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.all,
			});
			// Tell other tabs viewing the same document to refetch their
			// drawer too.
			broadcastDocumentAssistantInvalidation({
				kind: "all",
				scope: vars.scope,
			});
		},
	});
}

interface RenameConversationInput {
	conversationId: string;
	title: string;
	scope: DocumentAssistantHistoryScope;
}

/**
 * Rename a thread. Optimistically updates the title on every matching row
 * in the cached list pages so the new label shows up instantly; reverts
 * on failure.
 */
export function useRenameDocumentAssistantConversation() {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: RenameConversationInput) => {
			if (!featureEnabled) {
				throw new Error(HISTORY_DISABLED_ERROR_MESSAGE);
			}
			return orpcClient.agents.conversations.renameForDocument({
				conversationId: input.conversationId,
				organizationId: input.scope.organizationId,
				title: input.title,
			});
		},
		onMutate: async (vars) => {
			const listKey = documentAssistantHistoryKeys.list(vars.scope);
			await queryClient.cancelQueries({ queryKey: listKey });
			const previous =
				queryClient.getQueryData<InfiniteData<ListForDocumentResponse>>(
					listKey,
				);
			if (previous) {
				queryClient.setQueryData<InfiniteData<ListForDocumentResponse>>(
					listKey,
					{
						...previous,
						pages: previous.pages.map((page) => ({
							...page,
							items: page.items.map((item) =>
								item.conversationId === vars.conversationId
									? { ...item, title: vars.title }
									: item,
							),
						})),
					},
				);
			}
			return { previous };
		},
		onError: (_err, vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					documentAssistantHistoryKeys.list(vars.scope),
					context.previous,
				);
			}
		},
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.list(vars.scope),
			});
			// Sweep the per-conversation viewer cache so the renamed title
			// shows up immediately in the drawer's open viewer pane.
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.all,
			});
			// Tell other tabs viewing the same document to refetch.
			broadcastDocumentAssistantInvalidation({
				kind: "all",
				scope: vars.scope,
			});
		},
	});
}

interface RecordDiffOutcomeInput {
	conversationId: string;
	projectId: string;
	messageId: string;
	toolCallId: string;
	outcome: "accepted" | "rejected";
	at: string;
	organizationId: string | null;
}

/**
 * Stamp `acceptedAt` / `rejectedAt` on the tool-call entry inside the
 * conversation's `messages` blob. No cache invalidation — the drawer
 * reads from the persisted messages and the editor's diff flow keeps its
 * own state; the next list/get fetch will pick up the new outcome
 * naturally. (Adding an invalidation here would trigger a list refetch
 * on every accept/reject, which is wasteful.)
 *
 * Group G consumes this from `DiffReviewBar`.
 */
export function useRecordDocumentAssistantDiffOutcome() {
	const featureEnabled = useDocumentAssistantHistoryEnabled();

	return useMutation({
		mutationFn: async (input: RecordDiffOutcomeInput) => {
			if (!featureEnabled) {
				throw new Error(HISTORY_DISABLED_ERROR_MESSAGE);
			}
			return orpcClient.agents.conversations.recordDiffOutcome({
				conversationId: input.conversationId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				messageId: input.messageId,
				toolCallId: input.toolCallId,
				outcome: input.outcome,
				at: input.at,
			});
		},
	});
}

interface ForkConversationInput {
	/** The conversation to fork from — must belong to the same document
	 * the user has open + the same author. */
	sourceConversationId: string;
	/** Cut the fork at this message id (inclusive). Omit to copy the
	 * entire source conversation. */
	atMessageId?: string;
	scope: DocumentAssistantHistoryScope;
	requestedVisibility?: DocumentAssistantVisibility;
}

/**
 * Atomically fork a conversation. The server copies the source's
 * `messages[0..atMessageId]` (inclusive) into a brand-new conversation
 * row — including attachments + toolCalls — so the forked thread carries
 * the same agent context. The caller is expected to switch its live
 * `activeAssistantConversationId` to the returned id so subsequent turns
 * land on the fork.
 *
 * On success: invalidates list (new row) + active (which row is current)
 * + the per-conversation byId cache (so the drawer's viewer pane refreshes
 * if the user happens to be looking at the same source mid-fork). Also
 * broadcasts the invalidation to sibling tabs.
 */
export function useForkDocumentAssistantConversation() {
	const featureEnabled = useDocumentAssistantHistoryEnabled();
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (input: ForkConversationInput) => {
			if (!featureEnabled) {
				throw new Error(HISTORY_DISABLED_ERROR_MESSAGE);
			}
			return orpcClient.agents.conversations.forkForDocument({
				documentRefKind: input.scope.documentRefKind,
				documentRefId: input.scope.documentRefId,
				projectId: input.scope.projectId,
				organizationId: input.scope.organizationId,
				sourceConversationId: input.sourceConversationId,
				atMessageId: input.atMessageId,
				requestedVisibility: input.requestedVisibility,
			});
		},
		onSuccess: (_data, vars) => {
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.list(vars.scope),
			});
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.active(vars.scope),
			});
			queryClient.invalidateQueries({
				queryKey: documentAssistantHistoryKeys.all,
			});
			broadcastDocumentAssistantInvalidation({
				kind: "all",
				scope: vars.scope,
			});
		},
	});
}
