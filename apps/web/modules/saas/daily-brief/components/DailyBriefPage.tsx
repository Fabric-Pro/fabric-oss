"use client";

/**
 * DailyBriefPage — top-level client component for the Daily Brief route.
 *
 * Owns:
 * - time-window selection (24h / 7d / 2w)
 * - "since my last review" toggle
 * - layout + empty/failed/generating states
 *
 * Data is currently sourced from `getMockBrief()` — see the TODO in the
 * server page(s) that render this component. Once the oRPC procedure is
 * live, this component should accept a `brief: DailyBriefContent | null`
 * prop fetched by the server component (or via React Query) and render
 * accordingly.
 *
 * "Since my last review" filter pattern (summary):
 *   - Each source card's items are filtered to `occurredAt >= cursor`
 *     before render when the toggle is on.
 *   - Priority actions are NEVER filtered. Urgency is not a "since" concept.
 *   - Empty sections show "Nothing new since you last looked" instead of
 *     their normal empty message.
 *   - The LLM `executiveSummary` is hidden and replaced with a deterministic
 *     one-liner built from the counts.
 */

import { ORPCError } from "@orpc/client";
import type {
	DailyBriefContent,
	DailyBriefStatus,
	DeploymentItem,
	DocumentChangeItem,
	GithubItem,
	MeetingItem,
	PartialFailure,
	StoryChangeItem,
	TeamsProposalItem,
	TimeWindowKind,
} from "@repo/database";
import { orpcClient } from "@shared/lib/orpc-client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AheadPanel } from "./AheadPanel";
import { DailyBriefHeader } from "./DailyBriefHeader";
import { DeploymentsPanel } from "./DeploymentsPanel";
import { DocumentChangesCard } from "./DocumentChangesCard";
import { EmptyBriefState } from "./EmptyBriefState";
import { FailedBriefState } from "./FailedBriefState";
import { formatCursorForSummary } from "./format";
import { GeneratingState } from "./GeneratingState";
import { GitHubActivityCard } from "./GitHubActivityCard";
import { MeetingsCard } from "./MeetingsCard";
import { PriorityActionsPanel } from "./PriorityActionsPanel";
import type { HideTarget } from "./ReleaseNotesPanel";
import { ReleaseNotesPanel } from "./ReleaseNotesPanel";
import { StoryChangesCard } from "./StoryChangesCard";
import { StorylinesPanel } from "./StorylinesPanel";
import { TeamsProposalsCard } from "./TeamsProposalsCard";

type SupportedWindow = Extract<
	TimeWindowKind,
	"LAST_24H" | "LAST_7D" | "LAST_2W"
>;

/**
 * One row from `dailyBrief.exclusions.list` — a PR or story hidden from the
 * release-notes panel (and its downstream newsletter narrative) for this
 * project. Derived from the oRPC output type so it stays in sync with the
 * server's `SELECT` projection.
 */
export type ExclusionRow = Awaited<
	ReturnType<typeof orpcClient.dailyBrief.exclusions.list>
>[number];

export interface DailyBriefPageProps {
	projectId: string;
	organizationId: string | null;

	/** Initial time window (from URL `?window=...` search param). */
	timeWindow: SupportedWindow | "CUSTOM";

	/** The brief content (null if no brief exists for this window yet). */
	brief: DailyBriefContent | null;

	/** DailyBrief.id — needed to mark as read. */
	briefId: string | null;

	/** Workflow status. null if no brief row exists yet for this window. */
	status: DailyBriefStatus | null;

	/** When the brief was generated. null if no brief yet. */
	generatedAt: Date | null;

	/**
	 * When the current user last viewed any brief on this project. `null` on
	 * first visit — the "since my last review" toggle is disabled in that case.
	 */
	cursor: Date | null;

	/** Workflow progress when status === "GENERATING". */
	progress: {
		phase?: string;
		message?: string;
		completedSources?: number;
		totalSources?: number;
	} | null;

	/** Error message surfaced when status === "FAILED". */
	errorMessage?: string | null;

	/**
	 * Whether the current user can manage release-notes exclusions (hide/unhide
	 * PRs and stories from the release-notes panel). Mirrors the
	 * `PROJECT_SETTINGS_EDIT` gate used by `dailyBrief.exclusions.*`
	 * (`canEditSettings === true || userRole === "owner" || userRole ===
	 * "project_admin"`). Plumbed through for the hide/unhide controls added in
	 * a follow-up task — not yet rendered here. Defaults to `false`.
	 */
	canEditExclusions?: boolean;

	/**
	 * Current release-notes exclusions for this project. Always `[]` for
	 * non-editors (the list itself is editor-only, since a hidden PR/story is
	 * by definition absent from what a reader sees). Plumbed through for a
	 * follow-up task — not yet rendered here. Defaults to `[]`.
	 */
	exclusions?: ExclusionRow[];

	/**
	 * When provided, the component operates in controlled mode: the parent owns
	 * the timeWindow state and must re-render on change. Used by DailyBriefTab
	 * so the tab's TanStack query key is kept in sync with the selector.
	 * When absent (server-page variant), the component manages its own state
	 * and syncs changes to the URL.
	 */
	onTimeWindowChange?: (window: SupportedWindow) => void;

	/**
	 * Called after a successful regenerate. The server-page variant relies on
	 * router.refresh() alone, but the tab variant needs to invalidate its own
	 * TanStack query so the GENERATING row shows up and polling resumes.
	 */
	onRegenerated?: () => void;
}

function filterByCursor<T extends { occurredAt: Date }>(
	items: T[] | undefined,
	cursor: Date | null,
	enabled: boolean,
): T[] {
	if (!items) {
		return [];
	}
	if (!enabled || cursor === null) {
		return items;
	}
	const cursorTime = cursor.getTime();
	return items.filter((item) => {
		const t =
			item.occurredAt instanceof Date
				? item.occurredAt.getTime()
				: new Date(item.occurredAt).getTime();
		return t >= cursorTime;
	});
}

function findFailure(
	partialFailures: PartialFailure[] | undefined,
	source: PartialFailure["source"],
): PartialFailure | undefined {
	return partialFailures?.find((f) => f.source === source);
}

export function DailyBriefPage({
	projectId,
	organizationId,
	timeWindow: incomingTimeWindow,
	brief,
	briefId,
	status,
	generatedAt,
	cursor,
	progress,
	errorMessage,
	canEditExclusions = false,
	exclusions = [],
	onTimeWindowChange,
	onRegenerated,
}: DailyBriefPageProps) {
	const router = useRouter();
	const isControlled = onTimeWindowChange !== undefined;
	const incomingSupported: SupportedWindow =
		incomingTimeWindow === "CUSTOM" ? "LAST_24H" : incomingTimeWindow;
	const [localTimeWindow, setLocalTimeWindow] =
		useState<SupportedWindow>(incomingSupported);
	const timeWindow = isControlled ? incomingSupported : localTimeWindow;
	const setTimeWindow = onTimeWindowChange ?? setLocalTimeWindow;
	const [sinceLastReviewMode, setSinceLastReviewMode] = useState(false);

	// URL sync is only meaningful for the server-page variant; in controlled
	// (tab) mode the parent drives state and no URL update is desired.
	useEffect(() => {
		if (isControlled) {
			return;
		}
		if (timeWindow === incomingSupported) {
			return;
		}
		const params = new URLSearchParams(window.location.search);
		params.set("window", timeWindow);
		router.replace(`${window.location.pathname}?${params.toString()}`);
	}, [isControlled, timeWindow, incomingSupported, router]);

	const [isRegenerating, setIsRegenerating] = useState(
		status === "GENERATING",
	);
	const handleRegenerate = async () => {
		setIsRegenerating(true);
		try {
			await orpcClient.dailyBrief.regenerate({
				projectId,
				organizationId,
				timeWindow,
			});
			router.refresh();
			onRegenerated?.();
		} catch (error) {
			const description =
				error instanceof Error ? error.message : String(error);
			if (error instanceof ORPCError && error.status === 429) {
				toast.info("Daily Brief rate limit", { description });
			} else {
				toast.error("Could not regenerate Daily Brief", {
					description,
				});
			}
		} finally {
			setIsRegenerating(false);
		}
	};

	// Hide/unhide a release-notes exclusion. Mirrors handleRegenerate: persist
	// via oRPC, then router.refresh() + onRegenerated?.() so both the
	// server-page variant and the tab variant (which invalidates its own
	// TanStack query cache in onRegenerated — see DailyBriefTab) pick up the
	// change. timeWindow is threaded through so the VIEWED brief regenerates,
	// not just the default window.
	const handleHide = async (target: HideTarget) => {
		setIsRegenerating(true);
		try {
			await orpcClient.dailyBrief.exclusions.hide({
				projectId,
				organizationId,
				timeWindow,
				...target,
			});
			router.refresh();
			onRegenerated?.();
		} catch (error) {
			const description =
				error instanceof Error ? error.message : String(error);
			toast.error("Failed to hide from release notes", { description });
		} finally {
			setIsRegenerating(false);
		}
	};

	const handleUnhide = async (id: string) => {
		setIsRegenerating(true);
		try {
			await orpcClient.dailyBrief.exclusions.unhide({
				projectId,
				organizationId,
				timeWindow,
				id,
			});
			router.refresh();
			onRegenerated?.();
		} catch (error) {
			const description =
				error instanceof Error ? error.message : String(error);
			toast.error("Failed to unhide from release notes", { description });
		} finally {
			setIsRegenerating(false);
		}
	};

	// Mark read with a 2-second debounce so skimming doesn't advance the cursor.
	const markedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!briefId || (status !== "READY" && status !== "EMPTY")) {
			return;
		}
		if (markedRef.current === briefId) {
			return;
		}
		const handle = setTimeout(async () => {
			try {
				await orpcClient.dailyBrief.markRead({
					projectId,
					organizationId,
					briefId,
				});
				markedRef.current = briefId;
			} catch {
				// Non-critical — cursor will catch up on a future view.
			}
		}, 2000);
		return () => clearTimeout(handle);
	}, [briefId, status, projectId, organizationId]);

	// Poll workflow progress while generating.
	const [livePhase, setLivePhase] = useState<string | undefined>(
		progress?.message ?? progress?.phase,
	);
	useEffect(() => {
		if (status !== "GENERATING") {
			return;
		}
		const poll = async () => {
			try {
				const res = await orpcClient.dailyBrief.get({
					projectId,
					organizationId,
					timeWindow,
				});
				if (res.progress) {
					setLivePhase(res.progress.message ?? res.progress.phase);
				}
				if (res.brief && res.brief.status !== "GENERATING") {
					router.refresh();
				}
			} catch {
				// swallow
			}
		};
		const id = setInterval(poll, 3000);
		return () => clearInterval(id);
	}, [status, projectId, organizationId, timeWindow, router]);

	const filteredGithub = useMemo<GithubItem[]>(
		() =>
			filterByCursor(brief?.sections.github, cursor, sinceLastReviewMode),
		[brief, cursor, sinceLastReviewMode],
	);
	const filteredStories = useMemo<StoryChangeItem[]>(
		() =>
			filterByCursor(
				brief?.sections.storyChanges,
				cursor,
				sinceLastReviewMode,
			),
		[brief, cursor, sinceLastReviewMode],
	);
	const filteredDocs = useMemo<DocumentChangeItem[]>(
		() =>
			filterByCursor(
				brief?.sections.documents,
				cursor,
				sinceLastReviewMode,
			),
		[brief, cursor, sinceLastReviewMode],
	);
	const filteredMeetings = useMemo<MeetingItem[]>(
		() =>
			filterByCursor(
				brief?.sections.meetings,
				cursor,
				sinceLastReviewMode,
			),
		[brief, cursor, sinceLastReviewMode],
	);
	const filteredProposals = useMemo<TeamsProposalItem[]>(
		() =>
			filterByCursor(
				brief?.sections.teamsProposals,
				cursor,
				sinceLastReviewMode,
			),
		[brief, cursor, sinceLastReviewMode],
	);
	const filteredDeployments = useMemo<DeploymentItem[]>(
		() =>
			filterByCursor(
				brief?.sections.deployments,
				cursor,
				sinceLastReviewMode,
			),
		[brief, cursor, sinceLastReviewMode],
	);

	// Summary line: when filter is on, replace the LLM-produced summary with
	// a deterministic count-based line. Otherwise show the LLM summary.
	const summaryLine = useMemo(() => {
		if (!brief) {
			return null;
		}
		if (!sinceLastReviewMode || cursor === null) {
			return brief.executiveSummary || null;
		}
		const sourceCounts = [
			filteredGithub.length,
			filteredStories.length,
			filteredDocs.length,
			filteredMeetings.length,
			filteredProposals.length,
			filteredDeployments.length,
		];
		const totalChanges = sourceCounts.reduce((acc, n) => acc + n, 0);
		const sourcesWithChanges = sourceCounts.filter((n) => n > 0).length;
		return `${totalChanges} ${totalChanges === 1 ? "change" : "changes"} across ${sourcesWithChanges} ${sourcesWithChanges === 1 ? "source" : "sources"} since your last review on ${formatCursorForSummary(cursor)}`;
	}, [
		brief,
		sinceLastReviewMode,
		cursor,
		filteredGithub,
		filteredStories,
		filteredDocs,
		filteredMeetings,
		filteredProposals,
		filteredDeployments,
	]);

	const sinceEmpty = "Nothing new since you last looked.";

	const header = (
		<DailyBriefHeader
			timeWindow={timeWindow}
			onTimeWindowChange={setTimeWindow}
			sinceLastReviewMode={sinceLastReviewMode}
			onSinceLastReviewModeChange={setSinceLastReviewMode}
			cursor={cursor}
			generatedAt={generatedAt ?? undefined}
			isRegenerating={isRegenerating}
			onRegenerate={handleRegenerate}
		/>
	);

	if (status === "GENERATING") {
		return (
			<div className="container mx-auto space-y-6 px-4 py-8">
				{header}
				<GeneratingState phase={livePhase} />
			</div>
		);
	}

	if (status === "FAILED") {
		return (
			<div className="container mx-auto space-y-6 px-4 py-8">
				{header}
				<FailedBriefState
					errorMessage={errorMessage ?? undefined}
					onRegenerate={handleRegenerate}
				/>
			</div>
		);
	}

	if (status === "EMPTY" || !brief || status === null) {
		return (
			<div className="container mx-auto space-y-6 px-4 py-8">
				{header}
				<EmptyBriefState onRegenerate={handleRegenerate} />
			</div>
		);
	}

	return (
		<div className="container mx-auto space-y-6 px-4 py-8">
			{header}

			{summaryLine ? (
				<section
					aria-label="Brief summary"
					className="rounded-2xl border border-border bg-muted/40 p-6"
				>
					<span className="editorial-label">
						{sinceLastReviewMode && cursor !== null
							? "Since your last review"
							: "Executive summary"}
					</span>
					<p className="mt-3 text-base leading-7 text-foreground/90">
						{summaryLine}
					</p>
				</section>
			) : null}

			<ReleaseNotesPanel
				github={filteredGithub}
				storyChanges={filteredStories}
				summary={
					sinceLastReviewMode && cursor !== null
						? undefined
						: brief.releaseNotesSummary
				}
				latestProdRelease={brief.latestProdRelease}
				latestProdReleasesByRepo={brief.latestProdReleasesByRepo}
				canEdit={canEditExclusions}
				exclusions={exclusions}
				onHide={handleHide}
				onUnhide={handleUnhide}
			/>

			<DeploymentsPanel
				deployments={filteredDeployments}
				error={brief.deploymentsError}
			/>

			{brief.storylines ? (
				<StorylinesPanel storylines={brief.storylines} />
			) : null}

			{brief.ahead ? <AheadPanel items={brief.ahead} /> : null}

			{/* Priority actions always render the full list — never filtered. */}
			<PriorityActionsPanel actions={brief.priorityActions} />

			<div className="grid grid-cols-1 gap-6 md:grid-cols-2 xl:grid-cols-3">
				<MeetingsCard
					items={filteredMeetings}
					partialFailure={findFailure(
						brief.partialFailures,
						"meetings",
					)}
					emptyMessage={
						sinceLastReviewMode && cursor !== null
							? sinceEmpty
							: undefined
					}
				/>
				<GitHubActivityCard
					items={filteredGithub}
					partialFailure={findFailure(
						brief.partialFailures,
						"github",
					)}
					emptyMessage={
						sinceLastReviewMode && cursor !== null
							? sinceEmpty
							: undefined
					}
				/>
				<StoryChangesCard
					items={filteredStories}
					partialFailure={findFailure(
						brief.partialFailures,
						"stories",
					)}
					emptyMessage={
						sinceLastReviewMode && cursor !== null
							? sinceEmpty
							: undefined
					}
				/>
				<DocumentChangesCard
					items={filteredDocs}
					partialFailure={findFailure(
						brief.partialFailures,
						"documents",
					)}
					emptyMessage={
						sinceLastReviewMode && cursor !== null
							? sinceEmpty
							: undefined
					}
				/>
				<TeamsProposalsCard
					items={filteredProposals}
					partialFailure={findFailure(
						brief.partialFailures,
						"teamsProposals",
					)}
					emptyMessage={
						sinceLastReviewMode && cursor !== null
							? sinceEmpty
							: undefined
					}
				/>
			</div>
		</div>
	);
}
