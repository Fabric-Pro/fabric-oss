"use client";

import {
	GET_STARTED_PROJECT_TAB_EVENT,
	type ProjectTabEventDetail,
} from "@saas/get-started/lib/tour-steps";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
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
	supersededBy?: string;
	manualState: "SNOOZED" | "NOT_APPLICABLE" | "HELP_REQUESTED" | null;
	snoozeUntil: string | Date | null;
	isVisible: boolean;
	isActiveGap: boolean;
	target: { kind: "tab"; tab: string } | { kind: "settings"; subTab: string };
}

interface ReadinessData {
	enabled: boolean;
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
	 * Expand by default when the project is not Ready, per the acceptance
	 * criteria. Tracked per project rather than per render so that collapsing it
	 * sticks while the user moves between tabs — re-expanding on every tab change
	 * would make the control useless.
	 */
	useEffect(() => {
		if (!data?.enabled) {
			return;
		}
		if (autoExpandedFor === projectId) {
			return;
		}
		setAutoExpandedFor(projectId);
		setExpanded(
			data.level === "NOT_READY" || data.level === "PARTIALLY_READY",
		);
	}, [data, projectId, autoExpandedFor]);

	const handleSetExpanded = useCallback((next: boolean) => {
		setExpanded(next);
	}, []);

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
