"use client";

import { composeInboxSections } from "@repo/database/src/publishing-inbox";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { buildPublishingTopicRoute } from "@saas/projects/lib/publishing/routes";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { AlertTriangleIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CreateTopicDialog } from "./CreateTopicDialog";
import { PublishingBetaBadge } from "./PublishingBetaBadge";
import { PublishingCycleHistory } from "./PublishingCycleHistory";
import type { SnoozePreset } from "./SnoozeTopicDialog";
import { TopicRow } from "./TopicRow";
import {
	type PostType,
	type PublishingTopic,
	TOPIC_STATUSES,
	type TopicStatus,
} from "./topic-shared";

// FR2 caps Recently Modified at three. A single constant so `maxRecent`, the
// overflow-button condition and the "Showing N of …" label can never drift
// apart — changing the cap in one place changes the label to match.
const MAX_RECENT = 3;

export function PublishingSuiteList({
	projectId,
	organizationId,
	canEdit,
}: {
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
}) {
	const queryClient = useQueryClient();
	const basePath = useBasePath();
	const inboxEnabled = useFeatureFlag("PUBLISHING_INBOX");
	const [createOpen, setCreateOpen] = useState(false);
	const [statusFilter, setStatusFilter] = useState<
		TopicStatus | "SNOOZED" | null
	>(null); // null = all
	// C-Med2: per-topic in-flight WRITE COUNT, not a presence flag. Expanding a
	// row is deliberately allowed while a status write is in flight (FR4), so
	// two of `changeStatus` / `changePostTypes` / `changeReadState` /
	// `changeSnooze` can be in flight for the SAME topic at once. A presence
	// `Set` loses that overlap: whichever write settles first deletes the id in
	// its `finally`, re-enabling the row's controls even though another write
	// for that same topic is still outstanding (e.g. a slow read=true overlaps
	// a fast read=false and the user's later action goes silently missing at
	// the next refetch). A count keeps the topic pending until every one of
	// its writes has settled — see `beginPending` / `endPending` below.
	const [pendingTopicIds, setPendingTopicIds] = useState<
		ReadonlyMap<string, number>
	>(() => new Map());

	const beginPending = (topicId: string) => {
		setPendingTopicIds((prev) => {
			const next = new Map(prev);
			next.set(topicId, (next.get(topicId) ?? 0) + 1);
			return next;
		});
	};

	const endPending = (topicId: string) => {
		setPendingTopicIds((prev) => {
			const count = prev.get(topicId) ?? 0;
			const next = new Map(prev);
			if (count <= 1) {
				next.delete(topicId);
			} else {
				next.set(topicId, count - 1);
			}
			return next;
		});
	};
	// FR2 caps the section at three. The cap lifts IN PLACE rather than linking
	// to a chip: the section is composed from IN_PROGRESS *and* SELECTED, so no
	// single chip is guaranteed to contain the row that overflowed.
	const [showAllRecent, setShowAllRecent] = useState(false);

	const topicsQuery = useQuery(
		orpc.projects.publishingSuite.listTopics.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const cycleQuery = useQuery(
		orpc.projects.publishingSuite.latestCycle.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const invalidate = () =>
		queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopics.queryKey({
				input: { projectId, organizationId },
			}),
		});
	const updateStatus = useMutation(
		orpc.projects.publishingSuite.updateTopicStatus.mutationOptions({
			onSuccess: invalidate,
			// C-Med2: never fail silently. Surface the failure so the user knows
			// the change didn't land and can retry, instead of the control
			// snapping back to the old value with no explanation.
			onError: () => {
				toast.error("We couldn't update that topic. Please try again.");
			},
		}),
	);

	// Runs a status change with per-topic in-flight tracking. Returns the
	// mutation promise so the decline flow can await success before closing its
	// dialog (and keep the typed reason on failure).
	const changeStatus = async (
		topicId: string,
		status: TopicStatus,
		declineReason: string | null,
		publishedUrl: string | null,
	) => {
		beginPending(topicId);
		try {
			await updateStatus.mutateAsync({
				projectId,
				organizationId,
				topicId,
				status,
				declineReason,
				publishedUrl,
			});
		} finally {
			endPending(topicId);
		}
	};

	const updatePostTypes = useMutation(
		orpc.projects.publishingSuite.updateTopicPostTypes.mutationOptions({
			onSuccess: invalidate,
			onError: () => {
				toast.error(
					"We couldn't update the post types. Please try again.",
				);
			},
		}),
	);

	// Mirrors changeStatus: per-topic in-flight tracking so the Edit button +
	// dialog for THIS topic block a second racing write. Returns the promise so
	// the dialog can close only after success.
	const changePostTypes = async (
		topicId: string,
		postTypes: PostType[] | null,
	) => {
		beginPending(topicId);
		try {
			await updatePostTypes.mutateAsync({
				projectId,
				organizationId,
				topicId,
				postTypes,
			});
		} finally {
			endPending(topicId);
		}
	};

	const setReadState = useMutation(
		orpc.projects.publishingSuite.setTopicReadState.mutationOptions({
			onSuccess: invalidate,
			onError: () => {
				toast.error(
					"We couldn't update that topic's read state. Please try again.",
				);
			},
		}),
	);

	// Shares `pendingTopicIds` with the status and post-type writes on purpose
	// (design 7.3): one in-flight set per topic means a rapid expand-then-toggle
	// cannot land out of order, at the cost of briefly disabling this row's
	// other controls. A second set just for read state would buy a slightly
	// livelier row and reintroduce exactly the race the shared set removes.
	const changeReadState = async (topicId: string, read: boolean) => {
		beginPending(topicId);
		try {
			await setReadState.mutateAsync({
				projectId,
				organizationId,
				topicId,
				read,
			});
		} finally {
			endPending(topicId);
		}
	};

	const setSnooze = useMutation(
		orpc.projects.publishingSuite.setTopicSnooze.mutationOptions({
			onSuccess: invalidate,
			onError: () => {
				toast.error("We couldn't snooze that topic. Please try again.");
			},
		}),
	);

	const changeSnooze = async (
		topicId: string,
		preset: SnoozePreset | null,
		reason: string | null,
	) => {
		beginPending(topicId);
		try {
			await setSnooze.mutateAsync({
				projectId,
				organizationId,
				topicId,
				preset,
				reason,
			});
		} finally {
			endPending(topicId);
		}
	};

	const topics: PublishingTopic[] = topicsQuery.data?.items ?? [];
	// F8: filter chips. Client-side over the already-fetched list (small per
	// project → instant, no refetch/query-key churn). `listTopics` also accepts
	// `status` for a server-side filter if the list ever grows large; 1A filters
	// in the client.
	const visibleTopics =
		statusFilter === null
			? topics
			: statusFilter === "SNOOZED"
				? topics.filter((t) => t.isSnoozed)
				: topics.filter(
						(t) => t.status === statusFilter && !t.isSnoozed,
					);
	// The Inbox composition sorts by `updatedAt.getTime()`, which throws on a
	// string. `updatedAt` crosses the wire as `Date | string` (see
	// PublishingCycleHistory's identical guard in this same directory), so
	// this normalization is required, not defensive padding.
	const inboxSections = composeInboxSections(
		topics.map((t) => ({
			...t,
			updatedAt:
				t.updatedAt instanceof Date
					? t.updatedAt
					: new Date(t.updatedAt),
		})),
		{ maxRecent: showAllRecent ? Number.POSITIVE_INFINITY : MAX_RECENT },
	);
	const cycleStatus = cycleQuery.data?.cycle?.status ?? null;
	const hasCycle = cycleQuery.data?.cycle != null;

	// The row now takes eight props and would otherwise be written out three
	// times (flat list, Recently Modified, Suggested). Hoisted once so every
	// call site shares the exact same wiring.
	const renderRow = (t: PublishingTopic) => (
		<TopicRow
			key={t.id}
			topic={t}
			canEdit={canEdit}
			inbox={inboxEnabled}
			isPending={(pendingTopicIds.get(t.id) ?? 0) > 0}
			topicHref={buildPublishingTopicRoute(basePath, projectId, t.id)}
			onChangeStatus={(status, declineReason, publishedUrl) =>
				changeStatus(t.id, status, declineReason, publishedUrl)
			}
			onChangePostTypes={(postTypes) => changePostTypes(t.id, postTypes)}
			onSetReadState={(read) => changeReadState(t.id, read)}
			onSetSnooze={(preset, reason) => changeSnooze(t.id, preset, reason)}
		/>
	);

	// The body switches on state, but the header + CreateTopicDialog wrap EVERY
	// state (P15), so manual creation is always available (gated by canEdit).
	let body: ReactNode;
	if (topicsQuery.isError) {
		// C-Med3: a transport/auth/flag-mismatch read failure is NOT a
		// business/empty state. Show an explicit, retryable error instead of
		// misleading the user with "No suggestions yet".
		body = <ReadErrorState onRetry={() => topicsQuery.refetch()} />;
	} else if (topicsQuery.isPending) {
		// C-Med3: never derive a zero-topic state until the topics read settles.
		body = <ReadLoadingState />;
	} else if (topics.length > 0) {
		// F5: render the list whenever ANY topic exists; cycle health is a banner.
		body = (
			<>
				{cycleStatus === "GENERATING" && (
					<Banner tone="info">
						<RefreshCwIcon
							className="size-3.5 motion-safe:animate-spin"
							aria-hidden="true"
						/>
						Refreshing suggestions…
					</Banner>
				)}
				{cycleStatus === "FAILED" && (
					<Banner tone="warn">
						<AlertTriangleIcon
							className="size-3.5"
							aria-hidden="true"
						/>
						Last refresh failed — existing topics are unchanged.
					</Banner>
				)}
				<StatusFilterChips
					value={statusFilter}
					onChange={setStatusFilter}
				/>
				{inboxEnabled && statusFilter === null ? (
					<div
						className="space-y-4"
						data-onboarding-target="publishing-suite-inbox"
					>
						<InboxSection
							label="Recently Modified"
							emptyText="Nothing in progress right now."
						>
							{inboxSections.recentlyModified.length > 0 ? (
								<>
									<ul className="space-y-2">
										{inboxSections.recentlyModified.map(
											renderRow,
										)}
									</ul>
									{inboxSections.recentlyModifiedTotal >
									MAX_RECENT ? (
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={() =>
												setShowAllRecent((v) => !v)
											}
										>
											{showAllRecent
												? "Show fewer"
												: `Showing ${MAX_RECENT} of ${inboxSections.recentlyModifiedTotal} — show all`}
										</Button>
									) : null}
								</>
							) : null}
						</InboxSection>
						<InboxSection
							label="Suggested"
							emptyText="No new suggestions right now."
						>
							{inboxSections.suggested.length > 0 ? (
								<ul className="space-y-2">
									{inboxSections.suggested.map(renderRow)}
								</ul>
							) : null}
						</InboxSection>
					</div>
				) : visibleTopics.length > 0 ? (
					<ul className="space-y-2">
						{visibleTopics.map(renderRow)}
					</ul>
				) : (
					<p className="text-sm text-muted-foreground">
						No topics match this filter.
					</p>
				)}
			</>
		);
	} else if (cycleQuery.isPending) {
		// C-Med3 (coordinated): topics succeeded but empty — wait for the cycle
		// read before choosing which zero-topic state to show, rather than
		// flashing the first-run empty state and then swapping it.
		body = <ReadLoadingState />;
	} else if (!hasCycle) {
		body = <EmptyState />;
	} else if (cycleStatus === "INSUFFICIENT_CONTEXT") {
		body = <InsufficientState />;
	} else if (cycleStatus === "NO_TOPICS") {
		body = <NoTopicsState />;
	} else if (cycleStatus === "GENERATING") {
		body = <GeneratingState />;
	} else if (cycleStatus === "FAILED") {
		body = <FailedState />;
	} else {
		body = <EmptyState />;
	}

	return (
		// P13: the list anchor lives on this ALWAYS-rendered wrapper so it is
		// stable across every state (drift-test requirement).
		<div
			className="space-y-4"
			data-onboarding-target="publishing-suite-list"
		>
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-2.5">
					<h2 className="font-serif text-2xl font-normal text-foreground">
						Publishing Suite
					</h2>
					<PublishingBetaBadge />
				</div>
				<div className="flex items-center gap-2">
					<PageTourButton pageId="publishing-suite" />
					{canEdit && (
						<Button
							data-onboarding-target="publishing-suite-new"
							onClick={() => setCreateOpen(true)}
						>
							<PlusIcon className="size-4" aria-hidden="true" />
							Add topic
						</Button>
					)}
				</div>
			</div>
			{body}
			{/* Outside `body`, which switches on the TOPIC read: the history is
			    its own query with its own states, and a project whose topics
			    failed to load can still have a readable refresh history —
			    including the failed run that explains the empty list above. */}
			<PublishingCycleHistory
				projectId={projectId}
				organizationId={organizationId}
			/>
			<CreateTopicDialog
				projectId={projectId}
				organizationId={organizationId}
				open={createOpen}
				onOpenChange={setCreateOpen}
				onCreated={invalidate}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// F8: status filter chips.
// ---------------------------------------------------------------------------

function StatusFilterChips({
	value,
	onChange,
}: {
	value: TopicStatus | "SNOOZED" | null;
	onChange: (status: TopicStatus | "SNOOZED" | null) => void;
}) {
	const chips: ReadonlyArray<{
		value: TopicStatus | "SNOOZED" | null;
		label: string;
	}> = [
		{ value: null, label: "All" },
		...TOPIC_STATUSES,
		{ value: "SNOOZED", label: "Snoozed" },
	];
	return (
		<div
			className="flex flex-wrap gap-2"
			role="group"
			aria-label="Filter topics by status"
		>
			{chips.map((chip) => {
				const active = value === chip.value;
				return (
					<button
						key={chip.label}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(chip.value)}
						className={cn(
							"rounded-full border px-3 py-1 text-xs font-medium transition-colors",
							active
								? "border-primary bg-primary/10 text-primary"
								: "border-border bg-muted text-muted-foreground hover:text-foreground",
						)}
					>
						{chip.label}
					</button>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Banner + the five zero-topic states (copy only — the wrapper carries the
// header, create button, and list anchor).
// ---------------------------------------------------------------------------

function Banner({
	tone,
	children,
}: {
	tone: "info" | "warn";
	children: ReactNode;
}) {
	return (
		<div
			role="status"
			className={cn(
				"flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
				tone === "info"
					? "border-border bg-muted text-muted-foreground"
					: "border-highlight/40 bg-highlight/10 text-foreground",
			)}
		>
			{children}
		</div>
	);
}

function StateShell({
	label,
	title,
	children,
}: {
	label: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<div className="relative overflow-hidden rounded-2xl border border-border bg-card p-12 text-center">
			<div
				className="pointer-events-none absolute inset-0 opacity-40"
				style={{
					backgroundImage:
						"radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px)",
					backgroundSize: "32px 32px",
				}}
				aria-hidden="true"
			/>
			<div className="relative">
				<span className="editorial-label">{label}</span>
				<h3 className="mt-4 font-serif text-2xl font-normal leading-tight text-foreground">
					{title}
				</h3>
				{children}
			</div>
		</div>
	);
}

// C-Med3: explicit read states. A pending topics read shows a coordinated
// loading indicator; a failed read shows a retryable error — neither is ever
// rendered as a zero-topic/empty business state.
function ReadLoadingState() {
	return (
		<output
			aria-live="polite"
			aria-atomic="true"
			className="flex min-h-[30vh] flex-col items-center justify-center rounded-2xl border border-border bg-card p-12 text-center"
		>
			<RefreshCwIcon
				className="size-5 text-muted-foreground motion-safe:animate-spin"
				aria-hidden="true"
			/>
			<p className="mt-4 text-sm text-muted-foreground">
				Loading topics…
			</p>
		</output>
	);
}

function ReadErrorState({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="rounded-2xl border border-destructive/40 bg-destructive/5 p-12 text-center"
		>
			<div className="mx-auto flex size-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
				<AlertTriangleIcon
					className="size-6 text-destructive"
					aria-hidden="true"
				/>
			</div>
			<h3 className="mt-5 font-serif text-2xl font-normal leading-tight text-foreground">
				We couldn't load your topics
			</h3>
			<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
				Something went wrong while loading suggestions. This is usually
				temporary — try again.
			</p>
			<div className="mt-6">
				<Button variant="editorial" onClick={onRetry}>
					<RefreshCwIcon className="size-3.5" aria-hidden="true" />
					Try again
				</Button>
			</div>
		</div>
	);
}

function EmptyState() {
	return (
		<StateShell
			label="No suggestions yet"
			title="Nothing to publish on yet"
		>
			<p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
				No suggestions yet — they'll appear after the first run. Or add
				your own topic above.
			</p>
		</StateShell>
	);
}

function InsufficientState() {
	return (
		<StateShell
			label="Not enough context"
			title="We need more to work with"
		>
			<p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
				Project context is currently insufficient for suggested content.
			</p>
			<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
				Connect a codebase, meetings, chat, or other sources to give us
				more signal to work from.
			</p>
		</StateShell>
	);
}

function NoTopicsState() {
	return (
		<StateShell label="All quiet" title="Nothing stood out this cycle">
			<p className="mx-auto mt-3 max-w-md text-sm leading-6 text-muted-foreground">
				We reviewed recent activity — nothing stood out this cycle.
				Check back after more work lands.
			</p>
		</StateShell>
	);
}

function GeneratingState() {
	return (
		<output
			aria-live="polite"
			aria-atomic="true"
			className="flex flex-col items-center justify-center rounded-2xl border border-border bg-card p-12 text-center"
		>
			<div className="flex items-center gap-1.5" aria-hidden="true">
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:0ms]" />
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:150ms]" />
				<span className="size-2 rounded-full bg-muted-foreground/40 motion-safe:animate-bounce [animation-delay:300ms]" />
			</div>
			<p className="mt-5 font-serif text-xl font-normal leading-tight text-foreground">
				Finding topics worth writing about…
			</p>
		</output>
	);
}

function FailedState() {
	return (
		<div
			role="alert"
			className="rounded-2xl border border-destructive/40 bg-destructive/5 p-12 text-center"
		>
			<div className="mx-auto flex size-12 items-center justify-center rounded-full border border-destructive/40 bg-destructive/10">
				<AlertTriangleIcon
					className="size-6 text-destructive"
					aria-hidden="true"
				/>
			</div>
			<h3 className="mt-5 font-serif text-2xl font-normal leading-tight text-foreground">
				We couldn't refresh suggestions
			</h3>
			<p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
				Something went wrong while looking for topics. Your existing
				topics are unchanged — try again in a little while.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Inbox (1D-2): Recently Modified + Suggested sections.
// ---------------------------------------------------------------------------

/**
 * One Inbox section: an editorial label and either its rows or a muted line.
 *
 * `app-editorial-label`, not `editorial-label` — the latter is the marketing
 * variant and hardcodes its red, which CLAUDE.md forbids in app components.
 * An empty section is explicitly NOT an error state (UC1/UC2), so it is a
 * muted paragraph and never a role="alert".
 */
function InboxSection({
	label,
	emptyText,
	children,
}: {
	label: string;
	emptyText: string;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="space-y-2">
			<h3 className="app-editorial-label">{label}</h3>
			{children ?? (
				<p className="text-sm text-muted-foreground">{emptyText}</p>
			)}
		</section>
	);
}
