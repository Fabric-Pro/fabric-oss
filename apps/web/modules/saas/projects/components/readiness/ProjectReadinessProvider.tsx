"use client";

import {
	GET_STARTED_PROJECT_TAB_EVENT,
	type ProjectTabEventDetail,
} from "@saas/get-started/lib/tour-steps";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";

/**
 * Shared readiness state for one project (Fizzy #2165).
 *
 * The indicator and the panel are mounted in different places — the indicator
 * lives inside the project header, the panel in the route-group layout that
 * wraps every project page — so their shared expand/collapse state and the
 * single query behind them have to live above both.
 */

/**
 * The payload shape, INFERRED from the procedure's output schema in
 * `packages/api/modules/projects/procedures/readiness/get.ts`.
 *
 * Inferred rather than restated. A hand-written copy of the shape is a second
 * source of truth that `pnpm type-check` has no way to compare against the
 * first, so it drifts in silence the moment the procedure gains a field — and
 * a readiness payload gains fields often. Nothing new is pulled into the
 * browser bundle by reading it here: `orpc-client.ts` already imports the
 * router's types, so this taps a flow that is there either way.
 */
type ReadinessData = Awaited<
	ReturnType<typeof orpcClient.projects.readiness.get>
>;

/** One checklist row, exactly as the procedure returns it. */
export type ReadinessItem = ReadinessData["items"][number];

/**
 * Whether the panel has already opened itself today, in the VIEWER's day.
 *
 * Local rather than UTC deliberately: a cap that resets mid-afternoon for half
 * the team is not "once a day" in any sense a person recognises.
 */
function isFirstViewToday(autoExpandedAt: string | Date | null): boolean {
	if (!autoExpandedAt) {
		return true;
	}
	const last = new Date(autoExpandedAt);
	const midnight = new Date();
	midnight.setHours(0, 0, 0, 0);
	return last < midnight;
}

interface ReadinessContextValue {
	projectId: string;
	data: ReadinessData | undefined;
	isLoading: boolean;
	isExpanded: boolean;
	setExpanded: (next: boolean) => void;
	refetch: () => void;
	/**
	 * True once a page has mounted the panel somewhere better than the layout's
	 * fallback position. The tabbed project page places it in the banner slot
	 * beneath the title — where the code-analysis banner already renders — which
	 * is the "project header/title area" the criteria ask for. The layout can
	 * only render above everything, breadcrumb included, so it stands down when
	 * a page has claimed the slot.
	 */
	hasInlineSlot: boolean;
	claimInlineSlot: () => () => void;
	/**
	 * Whether this viewer has minted a CLI key from THIS project view
	 * (Fizzy #2457).
	 *
	 * Shared rather than held by whichever surface issued it, because two
	 * surfaces offer the key and only one of them has to stand down: the
	 * checklist's "API Key for CLI" row keeps the offer, and the prompt above
	 * the project must not go on saying nobody has connected a coding tool to
	 * someone holding a key they minted a second ago. Both mount their own
	 * issuing view, so a flag local to either one is invisible to the other —
	 * which is how the prompt survived a key issued from the row.
	 *
	 * Nothing on the server can replace it. The checklist item behind the
	 * prompt's eligibility completes when a coding tool actually REACHES
	 * Fabric, so issuing a key moves no readiness answer at all and the refetch
	 * that follows still reports the prompt eligible.
	 *
	 * NOT derived from the payload, and never written by anything that reads
	 * visibility — it is a fact about what this person just did, recorded by
	 * the one callback that knows it happened.
	 *
	 * Per project view and deliberately not persisted: issuing a key is not
	 * connecting with it, so the offer belongs back on the next visit, and the
	 * checklist row keeps it reachable in between.
	 */
	cliKeyIssued: boolean;
	/** Records the issue. One-way: nothing un-issues a key. */
	markCliKeyIssued: () => void;
}

const ReadinessContext = createContext<ReadinessContextValue | null>(null);

export function useProjectReadiness(): ReadinessContextValue | null {
	return useContext(ReadinessContext);
}

export function ProjectReadinessProvider({
	projectId,
	children,
}: {
	projectId: string;
	children: ReactNode;
}) {
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const [isExpanded, setExpanded] = useState(false);
	const [autoExpandedFor, setAutoExpandedFor] = useState<string | null>(null);

	const { data, isLoading, refetch } = useQuery({
		queryKey: ["project-readiness", projectId, organizationId],
		queryFn: () =>
			orpcClient.projects.readiness.get({
				projectId,
				organizationId: organizationId ?? null,
			}),
		staleTime: 30_000,
		/**
		 * Poll only while something is actually running.
		 *
		 * An indexing repository or a generating document lands minutes after
		 * the click that started it, with no mutation to notice — the cache
		 * subscription below cannot help, because nothing on this client
		 * changes. Polling while any item is In Progress is what turns that into
		 * "done" without a refresh; the moment nothing is running, this returns
		 * false and the query goes quiet again.
		 */
		refetchInterval: (query) =>
			query.state.data?.items.some((i) => i.isInProgress)
				? 15_000
				: false,
		// The default — stated so the intent (don't spend this poll on a
		// backgrounded tab) is explicit rather than incidental.
		refetchIntervalInBackground: false,
	});

	/**
	 * Re-read readiness after ANY successful mutation on this page.
	 *
	 * The tab-change listener below covers "go somewhere, do the thing, come
	 * back". It does not cover doing the thing in place: filling in the tech
	 * stack from the Overview card satisfies an item without ever leaving the
	 * tab, and the row sat there until a browser refresh. Chasing every project
	 * mutation and invalidating this query by hand would work until the next one
	 * is written and forgets.
	 *
	 * Subscribing to the mutation cache is one place instead of many, and cannot
	 * be forgotten. Readiness is a single cheap read, so re-running it after an
	 * unrelated mutation costs little; missing one costs a user staring at an
	 * item they have already done.
	 *
	 * The filter has to key on the event *type*, not the mutation's current
	 * state: `useMutation` calls `observer.setOptions(options)` from its own
	 * effect on every render, and that emits an `observerOptionsUpdated` cache
	 * event whenever `options` is not shallow-equal to last render's — which,
	 * for any mutation with an inline `mutationFn`/`onSuccess`, is every
	 * render. Once such a mutation has succeeded once, `event.mutation` is set
	 * and its `state.status` stays `"success"` forever after, so a filter that
	 * only checks `state.status` treats every later re-render of that
	 * mutation's component as a fresh success and refetches on it. `type ===
	 * "updated" && action.type === "success"` only matches the one event the
	 * mutation itself fires the moment it actually completes.
	 */
	useEffect(() => {
		const cache = queryClient.getMutationCache();
		const queryKey = ["project-readiness", projectId, organizationId];
		let queued: ReturnType<typeof setTimeout> | null = null;
		const schedule = () => {
			if (queued) {
				clearTimeout(queued);
			}
			queued = setTimeout(() => {
				queued = null;
				// A success that lands while a fetch is already in flight must
				// not cancel and restart it (`refetch()` defaults to
				// `cancelRefetch: true`) — but it cannot be dropped either, because
				// that request may have read the database before the mutation
				// committed. Wait for it to finish, then read once more.
				if (queryClient.isFetching({ queryKey }) > 0) {
					schedule();
					return;
				}
				void refetch();
			}, 400);
		};
		const unsubscribe = cache.subscribe((event) => {
			if (event.type !== "updated" || event.action.type !== "success") {
				return;
			}
			// Coalesce: a save can fire several mutations in a burst, and one
			// re-read afterwards answers all of them.
			schedule();
		});
		return () => {
			if (queued) {
				clearTimeout(queued);
			}
			unsubscribe();
		};
	}, [queryClient, refetch, projectId, organizationId]);

	/**
	 * Re-read readiness when the user moves between project tabs.
	 *
	 * Almost nothing that satisfies a checklist item happens in the panel — you
	 * generate a document, add a context source, connect a repository, all on
	 * another tab, then come back. Without this the panel still shows the gap you
	 * just closed and the only cure is a browser refresh, which the 20 Aug review
	 * hit repeatedly. The tab change is the moment the answer can have changed,
	 * so it is the moment to ask again.
	 *
	 * `ProjectDetails` already broadcasts every tab change for the guided tour;
	 * listening costs nothing and needs no new plumbing.
	 */
	useEffect(() => {
		const onTabChange = (event: Event) => {
			const detail = (event as CustomEvent<ProjectTabEventDetail>).detail;
			if (detail?.projectId === projectId) {
				void refetch();
			}
		};
		window.addEventListener(GET_STARTED_PROJECT_TAB_EVENT, onTabChange);
		return () =>
			window.removeEventListener(
				GET_STARTED_PROJECT_TAB_EVENT,
				onTabChange,
			);
	}, [projectId, refetch]);

	/**
	 * When the panel is allowed to open itself.
	 *
	 * It used to expand on every project open while the project was not Ready,
	 * which is most projects most of the time — so the one gesture the panel
	 * offers, closing it, was undone by walking away and coming back. Attention
	 * that fires constantly stops being attention.
	 *
	 * Two rules replace it, and one rule silences both:
	 *
	 *  - **Once a day.** The first view of the day on a project that is not
	 *    Ready opens the panel. Capped server-side per person per project, so
	 *    it survives a reload and does not follow the user between tabs.
	 *  - **Whenever things got worse.** A level drop, or an item that was
	 *    complete and is not any more, ignores the daily cap: a repository
	 *    disconnecting or a document regenerating into failure is news whenever
	 *    it happens, and nothing else in the product announces it.
	 *  - **Never after a manual collapse.** Closing the panel answers the
	 *    question for the rest of the session, and a Ready project is never
	 *    opened at all — the card wants that state compact and quiet.
	 */
	const [manuallyCollapsed, setManuallyCollapsed] = useState<string | null>(
		null,
	);

	useEffect(() => {
		if (!data?.enabled || autoExpandedFor === projectId) {
			return;
		}
		setAutoExpandedFor(projectId);

		if (data.level === "READY" || manuallyCollapsed === projectId) {
			return;
		}

		const gotWorse =
			data.attention.levelDropped ||
			data.attention.changes.some((c) => c.kind === "REGRESSED");
		if (gotWorse || isFirstViewToday(data.attention.autoExpandedAt)) {
			setExpanded(true);
			autoExpandedRef.current = true;
		}
	}, [data, projectId, autoExpandedFor, manuallyCollapsed]);

	/**
	 * "Seen" is written when the panel is EXPANDED, never on page load.
	 *
	 * Opening a project with the panel collapsed must not clear markers nobody
	 * looked at: an unread badge that clears itself teaches the reader to
	 * distrust the next one. The auto-expanded flag rides along because only the
	 * client knows whether the panel opened itself, and the daily cap is about
	 * that.
	 */
	const autoExpandedRef = useRef(false);
	const markSeen = useMutation({
		mutationFn: (args: { level: string; autoExpanded: boolean }) =>
			orpcClient.projects.readiness.markSeen({
				projectId,
				organizationId: organizationId ?? null,
				level: args.level as never,
				autoExpanded: args.autoExpanded,
			}),
	});
	const seenForRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isExpanded || !data?.enabled) {
			return;
		}
		const stamp = `${projectId}:${data.level}`;
		if (seenForRef.current === stamp) {
			return;
		}
		seenForRef.current = stamp;
		markSeen.mutate({
			level: data.level,
			autoExpanded: autoExpandedRef.current,
		});
		autoExpandedRef.current = false;
	}, [isExpanded, data, projectId, markSeen]);

	const handleSetExpanded = useCallback(
		(next: boolean) => {
			setExpanded(next);
			// A deliberate close answers the question for this session.
			setManuallyCollapsed(next ? null : projectId);
		},
		[projectId],
	);

	const [inlineSlotCount, setInlineSlotCount] = useState(0);
	const claimInlineSlot = useCallback(() => {
		setInlineSlotCount((n) => n + 1);
		return () => setInlineSlotCount((n) => n - 1);
	}, []);

	// The one CLI fact both surfaces need — see `cliKeyIssued` on the context
	// type. A latch, not a toggle: no caller may take it back, so nothing can
	// re-offer the key to someone who has just been handed one.
	const [cliKeyIssued, setCliKeyIssued] = useState(false);
	const markCliKeyIssued = useCallback(() => setCliKeyIssued(true), []);

	return (
		<ReadinessContext.Provider
			value={{
				projectId,
				data,
				isLoading,
				isExpanded,
				setExpanded: handleSetExpanded,
				refetch: () => {
					void refetch();
				},
				hasInlineSlot: inlineSlotCount > 0,
				claimInlineSlot,
				cliKeyIssued,
				markCliKeyIssued,
			}}
		>
			{children}
		</ReadinessContext.Provider>
	);
}
