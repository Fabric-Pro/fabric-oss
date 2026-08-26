"use client";

/**
 * Follows the body regeneration a BUG ↔ FEATURE conversion starts (Fizzy #2048).
 *
 * The conversion procedure returns as soon as the kind flip lands; the redraft
 * of the description and acceptance criteria then runs in a Temporal workflow
 * for about a minute. Everything the user sees about that redraft — running,
 * rewritten, refused — is read from the `BackgroundJob` row the conversion
 * opened, through `projects.stories.regenerationStatus`.
 *
 * READ THE SERVER, NOT A LOCAL FLAG. A `useState` set at confirmation time is
 * gone the moment the user navigates away, and a minute is long enough that
 * they will. The status read is the only thing that survives a route change, a
 * reload, and a second browser tab.
 *
 * The one thing kept client-side is the WATCHLIST below, and it decides only
 * whether to poll — never what to display. A roadmap can hold hundreds of
 * cards, and a card that has never been converted must not cost a request per
 * render; the detail view, which renders exactly one work item, polls
 * unconditionally instead (`alwaysWatch`).
 */

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

/** Mirrors `GetStoryRegenerationStatusResult["status"]` on the server. */
type StoryRegenerationStatus = "idle" | "running" | "completed" | "failed";

/**
 * Per-tab, so a conversion started in one tab does not make every other tab
 * poll, and so the watch survives a navigation and a reload of the tab that
 * started it. Deliberately NOT `localStorage`: a stale entry there would
 * outlive the browser session and poll forever.
 */
const WATCHLIST_STORAGE_KEY = "fabric.storyKindRegeneration.watching";

/** How often a running regeneration is re-read. The redraft takes ~a minute. */
const POLL_INTERVAL_MS = 3000;

/**
 * How long a refused regeneration keeps announcing itself on a cold load.
 *
 * A failure leaves the previous body intact, which is indistinguishable from a
 * conversion that never regenerated at all — so the refusal has to still be
 * visible to a user who converted, walked away, and came back. It must not be
 * visible forever, though: the job row is retained far longer than the failure
 * is news.
 */
const FAILURE_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

let watchlist: Set<string> | null = null;
const watchlistSubscribers = new Set<() => void>();

function loadWatchlist(): Set<string> {
	if (watchlist) {
		return watchlist;
	}
	watchlist = new Set<string>();
	if (typeof window === "undefined") {
		return watchlist;
	}
	try {
		const raw = window.sessionStorage.getItem(WATCHLIST_STORAGE_KEY);
		if (raw) {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				for (const id of parsed) {
					if (typeof id === "string") {
						watchlist.add(id);
					}
				}
			}
		}
	} catch {
		// A corrupt or unavailable store must never stop a conversion from
		// being confirmable — an empty watchlist just means the cards fall
		// back to the detail view for progress.
	}
	return watchlist;
}

function persistWatchlist(next: Set<string>): void {
	if (typeof window === "undefined") {
		return;
	}
	try {
		window.sessionStorage.setItem(
			WATCHLIST_STORAGE_KEY,
			JSON.stringify([...next]),
		);
	} catch {
		// Private-mode / quota failures degrade to in-memory only.
	}
}

function notifyWatchlistSubscribers(): void {
	for (const subscriber of watchlistSubscribers) {
		subscriber();
	}
}

/**
 * Record that a regeneration was just started for this work item, so every
 * surface showing the item starts polling — including one mounted after a
 * navigation away and back.
 */
export function watchStoryKindRegeneration(storyId: string): void {
	const current = loadWatchlist();
	if (current.has(storyId)) {
		return;
	}
	current.add(storyId);
	persistWatchlist(current);
	notifyWatchlistSubscribers();
}

/** Drop the item once its regeneration has reached a terminal state. */
function unwatchStoryKindRegeneration(storyId: string): void {
	const current = loadWatchlist();
	if (!current.delete(storyId)) {
		return;
	}
	persistWatchlist(current);
	notifyWatchlistSubscribers();
}

/** Test seam — the watchlist is module state shared by every surface. */
export function resetStoryKindRegenerationWatchlist(): void {
	watchlist = new Set<string>();
	persistWatchlist(watchlist);
	notifyWatchlistSubscribers();
}

function subscribeToWatchlist(onStoreChange: () => void): () => void {
	watchlistSubscribers.add(onStoreChange);
	return () => {
		watchlistSubscribers.delete(onStoreChange);
	};
}

function useIsStoryKindRegenerationWatched(storyId: string): boolean {
	return useSyncExternalStore(
		subscribeToWatchlist,
		() => loadWatchlist().has(storyId),
		() => false,
	);
}

export interface StoryKindRegenerationState {
	/** Raw server status. `idle` means no regeneration was ever recorded. */
	status: StoryRegenerationStatus;
	/** A redraft is in flight for this work item right now. */
	isRunning: boolean;
	/**
	 * The description / acceptance-criteria editors must refuse edits.
	 *
	 * An edit made while the redraft is in flight is an edit the user is about
	 * to have replaced under them. (U5's activity writes under an optimistic
	 * version guard, so in practice the manual edit would win and the redraft
	 * would be discarded — but a field that may be replaced under you is still
	 * the wrong affordance to offer.)
	 */
	isBodyLocked: boolean;
	/** A regeneration was refused, recently enough to still be news. */
	hasRecentFailure: boolean;
	/** The redraft finished while this surface was mounted and watching. */
	justCompleted: boolean;
	/** User-facing reason for a refusal. Never a stack trace. */
	error: string | null;
}

export interface UseStoryKindRegenerationOptions {
	projectId: string;
	storyId: string;
	organizationId?: string | null;
	/**
	 * Poll regardless of the watchlist. The work item detail view sets this —
	 * it renders one item, so the cost is one request, and it is the surface a
	 * user returns to mid-refresh.
	 */
	alwaysWatch?: boolean;
	/** Fired once when a watched redraft lands, for invalidation + focus. */
	onCompleted?: () => void;
	/** Fired once when a watched redraft is refused. */
	onFailed?: (error: string | null) => void;
}

export function useStoryKindRegeneration({
	projectId,
	storyId,
	organizationId = null,
	alwaysWatch = false,
	onCompleted,
	onFailed,
}: UseStoryKindRegenerationOptions): StoryKindRegenerationState {
	const isWatched = useIsStoryKindRegenerationWatched(storyId);
	const enabled = alwaysWatch || isWatched;

	const query = useQuery(
		orpc.projects.stories.regenerationStatus.queryOptions({
			input: { projectId, storyId, organizationId },
			enabled,
			// Poll only while a redraft is actually in flight; every other
			// answer is terminal and re-reading it costs a request per surface.
			refetchInterval: (q) =>
				q.state.data?.status === "running" ? POLL_INTERVAL_MS : false,
		}),
	);

	const status: StoryRegenerationStatus = query.data?.status ?? "idle";

	/**
	 * The gap between "the conversion resolved" and "the first status read came
	 * back" is a second or two in which the row exists but this surface has not
	 * seen it. Treat a watched item with no answer yet as running, so the body
	 * never flickers back to editable in that window.
	 */
	const isAwaitingFirstRead = isWatched && query.data === undefined;
	const isRunning = status === "running" || isAwaitingFirstRead;

	const settledAt = query.data?.completedAt ?? query.data?.startedAt ?? null;
	const hasRecentFailure =
		status === "failed" &&
		(settledAt === null ||
			Date.now() - new Date(settledAt).getTime() <
				FAILURE_NOTICE_WINDOW_MS);

	// Transition tracking. A "completed" row read on a cold load is history, not
	// news — only a transition observed by THIS mount is a completion event.
	const previousStatusRef = useRef<StoryRegenerationStatus | null>(null);
	// State, not a ref: the completion panel and its focus move are RENDERED
	// from this, and a ref written inside an effect renders nothing.
	const [observedCompletion, setObservedCompletion] = useState(false);
	const onCompletedRef = useRef(onCompleted);
	const onFailedRef = useRef(onFailed);
	onCompletedRef.current = onCompleted;
	onFailedRef.current = onFailed;

	if (previousStatusRef.current === null) {
		previousStatusRef.current = status;
	}

	useEffect(() => {
		const previous = previousStatusRef.current;
		if (previous === status) {
			return;
		}
		previousStatusRef.current = status;
		if (previous !== "running") {
			return;
		}
		if (status === "completed") {
			setObservedCompletion(true);
			// Stop polling. A landed redraft is history the moment the caches
			// are refreshed, and a stale "rewritten" chip on every future visit
			// would be noise.
			unwatchStoryKindRegeneration(storyId);
			onCompletedRef.current?.();
		} else if (status === "failed") {
			// DELIBERATELY STILL WATCHED. A refusal leaves the previous body in
			// place, which looks exactly like a conversion that never
			// regenerated — dropping the watch here would take the only signal
			// off the card the instant it became true. The recency window below
			// is what eventually retires it.
			onFailedRef.current?.(query.data?.error ?? null);
		}
	}, [status, storyId, query.data?.error]);

	// Retire a refusal that has stopped being news, so the surface stops
	// asking about it for the rest of the tab's life.
	useEffect(() => {
		if (status === "failed" && !hasRecentFailure) {
			unwatchStoryKindRegeneration(storyId);
		}
	}, [status, hasRecentFailure, storyId]);

	return {
		status,
		isRunning,
		isBodyLocked: isRunning,
		hasRecentFailure,
		justCompleted: observedCompletion && status === "completed",
		error: query.data?.error ?? null,
	};
}

/**
 * The invalidations every conversion surface owes once a redraft lands.
 *
 * DERIVED, NEVER HAND-BUILT. This repository registers query keys in three
 * different shapes and a hand-authored filter matches nothing without erroring
 * — see `docs/solutions/conventions/derive-query-invalidation-keys-never-hand-build-them.md`.
 * Both keys below come from the same `orpc` client that registered the reads.
 *
 * The list filter deliberately carries only `projectId`: TanStack compares the
 * input object as a recursive SUBSET, so this matches the roadmap list however
 * the calling surface scoped its own organization argument.
 */
export function useInvalidateStoryAfterRegeneration(
	projectId: string,
	storyId: string,
	organizationId?: string | null,
): () => Promise<void> {
	const queryClient = useQueryClient();
	return useCallback(async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.key({
					input: {
						projectId,
						storyId,
						organizationId: organizationId ?? null,
					},
				}),
			}),
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.key({
					input: { projectId },
				}),
			}),
		]);
	}, [queryClient, projectId, storyId, organizationId]);
}
