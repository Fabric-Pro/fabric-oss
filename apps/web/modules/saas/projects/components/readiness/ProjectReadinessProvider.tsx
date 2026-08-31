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

export interface ReadinessItem {
	key: string;
	category: string;
	i18nKey: string;
	ctaLabelKey: string;
	needLevel: "MUST" | "SHOULD" | "COULD" | "NOT_APPLICABLE";
	isComplete: boolean;
	isInProgress: boolean;
	supersededBy?: string;
	/** Copy variant for the "still needed" line; resolved against i18n. */
	unmetReason?: string;
	/** The prerequisite hiding this item, when one is. */
	blockedBy?: string;
	manualState: "SNOOZED" | "NOT_APPLICABLE" | "HELP_REQUESTED" | null;
	snoozeUntil: string | Date | null;
	isVisible: boolean;
	isActiveGap: boolean;
	target: { kind: "tab"; tab: string } | { kind: "settings"; subTab: string };
}

/** What has changed since this viewer last opened the panel. */
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

/** What has changed since this viewer last opened the panel. */
interface ReadinessAttention {
	changes: Array<{
		key: string;
		kind: "COMPLETED" | "REGRESSED" | "APPEARED";
	}>;
	levelDropped: boolean;
	seenAt: string | Date | null;
	autoExpandedAt: string | Date | null;
}

interface ReadinessData {
	enabled: boolean;
	attention: ReadinessAttention;
	level: "NOT_READY" | "PARTIALLY_READY" | "READY";
	phase: "DISCOVERY_PLANNING" | "DEVELOPMENT_EXECUTION";
	/** "inferred" means nobody chose the phase — say so rather than implying it. */
	phaseSource: "set" | "inferred";
	completedCount: number;
	totalCount: number;
	suggestPhaseTransition: boolean;
	/** False for a viewer who cannot edit the project — every action needs it. */
	canAct: boolean;
	items: ReadinessItem[];
	activeGaps: ReadinessItem[];
	recentlyCompleted: Array<{ key: string }>;
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
			}) as Promise<ReadinessData>,
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
			(query.state.data as ReadinessData | undefined)?.items?.some(
				(i) => i.isInProgress,
			)
				? 15_000
				: false,
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
	 */
	useEffect(() => {
		const cache = queryClient.getMutationCache();
		let queued: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = cache.subscribe((event) => {
			if (event.mutation?.state.status !== "success") {
				return;
			}
			// Coalesce: a save can fire several mutations in a burst, and one
			// re-read afterwards answers all of them.
			if (queued) {
				clearTimeout(queued);
			}
			queued = setTimeout(() => {
				void refetch();
			}, 400);
		});
		return () => {
			if (queued) {
				clearTimeout(queued);
			}
			unsubscribe();
		};
	}, [queryClient, refetch]);

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
			}}
		>
			{children}
		</ReadinessContext.Provider>
	);
}
