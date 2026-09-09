"use client";

import {
	composeInboxSections,
	isTopicArchived,
	STALE_AFTER_DAYS,
	topicNeglect,
} from "@repo/database/src/publishing-inbox";
import { useSession } from "@saas/auth/hooks/use-session";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { buildPublishingTopicRoute } from "@saas/projects/lib/publishing/routes";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
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
	const { user } = useSession();
	const viewerUserId = user?.id ?? null;
	const inboxEnabled = useFeatureFlag("PUBLISHING_INBOX");
	const [createOpen, setCreateOpen] = useState(false);
	const [statusFilter, setStatusFilter] = useState<
		TopicStatus | "SNOOZED" | "ARCHIVED" | null
	>(null); // null = all
	const [search, setSearch] = useState("");
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
	// For the contributors picker (Task 6). Fetched ONCE here, not inside
	// `TopicRow` — a query per rendered row would fire once per topic instead
	// of once for the whole list.
	const membersQuery = useQuery(
		orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const members = membersQuery.data?.members ?? [];
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

	const updateContributors = useMutation(
		orpc.projects.publishingSuite.updateTopicContributors.mutationOptions({
			// The mutation response deliberately omits the override columns
			// (Task 4) — never read `response.topic` here. Refresh the same
			// way `updatePostTypes` does: invalidate and let the list re-fetch
			// the effective set.
			onSuccess: invalidate,
			onError: () => {
				toast.error(
					"We couldn't update the contributors. Please try again.",
				);
			},
		}),
	);

	// Mirrors changePostTypes: per-topic in-flight tracking so the Edit button
	// + dialog for THIS topic block a second racing write. Returns the promise
	// so the dialog can close only after success.
	const changeContributors = async (
		topicId: string,
		contributorUserIds: string[] | null,
	) => {
		beginPending(topicId);
		try {
			await updateContributors.mutateAsync({
				projectId,
				organizationId,
				topicId,
				contributorUserIds,
			});
		} finally {
			endPending(topicId);
		}
	};

	const updateAssignees = useMutation(
		orpc.projects.publishingSuite.updateTopicAssignees.mutationOptions({
			// Same contract as the contributor write above: the response
			// returns the narrow topic record, which does NOT carry the
			// assignee column — never read `response.topic` here. Invalidate
			// and let the list re-fetch the resolved handles.
			onSuccess: invalidate,
			onError: () => {
				toast.error(
					"We couldn't update the assignees. Please try again.",
				);
			},
		}),
	);

	const changeAssignees = async (
		topicId: string,
		assigneeUserIds: string[],
	) => {
		beginPending(topicId);
		try {
			await updateAssignees.mutateAsync({
				projectId,
				organizationId,
				topicId,
				assigneeUserIds,
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

	// The Inbox composition and the staleness read both call
	// `updatedAt.getTime()`, which throws on a string, and `updatedAt` crosses
	// the wire as `Date | string` (see PublishingCycleHistory's identical guard
	// in this same directory) — so this normalization is required, not
	// defensive padding.
	//
	// It happens ONCE, on the raw query result, rather than on the way into
	// `composeInboxSections`. The chip and search paths filter this same array
	// and now read staleness too; a normalization that lived only on the Inbox
	// path would leave "updatedAt.getTime is not a function" waiting behind a
	// status chip.
	const topics: PublishingTopic[] = (topicsQuery.data?.items ?? []).map(
		(t) => ({
			...t,
			updatedAt:
				t.updatedAt instanceof Date
					? t.updatedAt
					: new Date(t.updatedAt),
			// BOTH date fields, in the same pass. `snoozedUntil` is now half of
			// what decides whether a topic is archived — a snooze ending counts
			// as activity — and it crosses the wire as a string exactly like
			// `updatedAt`. A string reaching `getTime()` gives `NaN`, which
			// compares false against every threshold, so leaving this one out
			// would not throw: it would report every topic as fresh and leave
			// the archive silently dead.
			snoozedUntil:
				t.snoozedUntil == null || t.snoozedUntil instanceof Date
					? (t.snoozedUntil ?? null)
					: new Date(t.snoozedUntil),
		}),
	);
	// ONE `now` for the whole render, shared by the archive, the Archived chip
	// and every row's neglect badge. Two separate `new Date()` calls can
	// straddle a day boundary and render a row that is badged stale but was
	// left in Suggested (or the reverse).
	const now = new Date();
	// F8: filter chips. Client-side over the already-fetched list (small per
	// project → instant, no refetch/query-key churn). `listTopics` also accepts
	// `status` for a server-side filter if the list ever grows large; 1A filters
	// in the client.
	//
	// Text search rides the same decision for the same reason, and composes
	// with the chips rather than replacing them. It searches EVERY topic, not
	// just the two Inbox sections: a declined or snoozed topic you half
	// remember is exactly what you reach for search to find, and the sections
	// deliberately exclude both.
	const searchTerm = search.trim().toLowerCase();
	const searching = searchTerm !== "";
	// Title, pitch and angle — the three fields the collapsed row itself shows,
	// so every hit is visible in its result rather than matching on something
	// the user cannot see.
	const matchesSearch = (t: PublishingTopic) =>
		!searching ||
		[t.title, t.pitch, t.angle].some((field) =>
			field?.toLowerCase().includes(searchTerm),
		);
	// `ARCHIVED` needs an arm of its own for the same reason `SNOOZED` does:
	// neither is a status, so both would fall through to the `t.status ===`
	// comparison, match nothing, and leave a chip that looks broken with every
	// gate still green. This arm is also how an archived topic stays REACHABLE
	// — it is removed from Suggested, never from the list.
	const visibleTopics = (
		statusFilter === null
			? topics
			: statusFilter === "SNOOZED"
				? topics.filter((t) => t.isSnoozed)
				: statusFilter === "ARCHIVED"
					? topics.filter((t) => isTopicArchived(t, now))
					: topics.filter(
							(t) => t.status === statusFilter && !t.isSnoozed,
						)
	).filter(matchesSearch);
	const inboxSections = composeInboxSections(topics, {
		maxRecent: showAllRecent ? Number.POSITIVE_INFINITY : MAX_RECENT,
		now,
	});
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
			// Computed for EVERY row from the same predicate that sinks the
			// Suggested section, not only for the rows inside it: a topic does
			// not stop being neglected because you reached it through the
			// Suggestion chip or a search.
			neglect={topicNeglect(t, now)}
			topicHref={buildPublishingTopicRoute(basePath, projectId, t.id)}
			members={members}
			membersPending={membersQuery.isPending}
			membersError={membersQuery.isError}
			viewerUserId={viewerUserId}
			onChangeStatus={(status, declineReason, publishedUrl) =>
				changeStatus(t.id, status, declineReason, publishedUrl)
			}
			onChangePostTypes={(postTypes) => changePostTypes(t.id, postTypes)}
			onChangeContributors={(contributorUserIds) =>
				changeContributors(t.id, contributorUserIds)
			}
			onChangeAssignees={(assigneeUserIds) =>
				changeAssignees(t.id, assigneeUserIds)
			}
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
				<div className="flex flex-wrap items-center justify-between gap-2">
					<StatusFilterChips
						value={statusFilter}
						onChange={setStatusFilter}
					/>
					<TopicSearchInput value={search} onChange={setSearch} />
				</div>
				{/* The inbox anchor sits on this ALWAYS-rendered wrapper, not
				    on the sectioned branch below, for the same reason the list
				    anchor sits on the outer wrapper: a spotlight has to have
				    something to point at in every state. It used to be on the
				    sections themselves, so searching or picking a status chip
				    took the anchor out of the DOM and a "Show me" fired during
				    a search highlighted nothing. */}
				<div data-onboarding-target="publishing-suite-inbox">
					{/* A search term replaces the two sections with one flat list of
				    hits, exactly as picking a status chip does: the sections
				    answer "what should I look at next", and a search is the
				    question that overrides it. */}
					{inboxEnabled && statusFilter === null && !searching ? (
						<div className="space-y-4">
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
								footer={
									/* Say it out loud. A queue that quietly
								   shrinks is the one nobody trusts, so the
								   section accounts for what it removed and
								   hands over the way to go and look. The
								   count reads the very array the rows were
								   taken out of — recomputing it here would be
								   two paths to one number, free to drift. */
									inboxSections.archived.length > 0 ? (
										<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
											<p className="text-muted-foreground text-xs">
												{`${inboxSections.archived.length} ${
													inboxSections.archived
														.length === 1
														? "topic"
														: "topics"
												} archived after ${STALE_AFTER_DAYS} days without activity`}
											</p>
											{/* The visible text IS the accessible
										    name (WCAG 2.5.3), so it has to
										    say what it opens on its own — an
										    `aria-label` naming the chip would
										    no longer contain "Show archived". */}
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() =>
													setStatusFilter("ARCHIVED")
												}
											>
												Show archived
											</Button>
										</div>
									) : null
								}
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
						/* Announced, because it updates live as you type or switch
					   chips — a result count that only changes visually leaves
					   a screen-reader user with no signal that anything did
					   (WCAG 4.1.3). The chip path had the same gap. */
						<p
							role="status"
							className="text-muted-foreground text-sm"
						>
							{searching
								? `No topics match “${search.trim()}”.`
								: "No topics match this filter."}
						</p>
					)}
				</div>
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
	value: TopicStatus | "SNOOZED" | "ARCHIVED" | null;
	onChange: (status: TopicStatus | "SNOOZED" | "ARCHIVED" | null) => void;
}) {
	const chips: ReadonlyArray<{
		value: TopicStatus | "SNOOZED" | "ARCHIVED" | null;
		label: string;
	}> = [
		{ value: null, label: "All" },
		...TOPIC_STATUSES,
		{ value: "SNOOZED", label: "Snoozed" },
		// Neither of the last two is a status — both are overlays the list
		// derives. `Archived` is the reachable half of the archive: the Inbox
		// takes those topics out of Suggested, and this is where they went.
		{ value: "ARCHIVED", label: "Archived" },
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

/**
 * Text search over the already-fetched list.
 *
 * A real `<label>`, visually hidden rather than dropped: `type="search"` gives
 * the control the `searchbox` role, and a placeholder is not an accessible
 * name — it disappears the moment anyone types.
 */
function TopicSearchInput({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="w-full sm:w-64">
			<label htmlFor="publishing-topic-search" className="sr-only">
				Search topics
			</label>
			<Input
				id="publishing-topic-search"
				type="search"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="Search topics…"
				className="h-8"
			/>
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
	footer,
	children,
}: {
	label: string;
	emptyText: string;
	/**
	 * Rendered after the rows, and OUTSIDE the `children ?? emptyText` choice
	 * on purpose. A section whose every topic was archived still has nothing
	 * to suggest, so it must say so AND account for what left — folding the
	 * footer into `children` would substitute the one message for the other.
	 */
	footer?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section aria-label={label} className="space-y-2">
			<h3 className="app-editorial-label">{label}</h3>
			{children ?? (
				<p className="text-sm text-muted-foreground">{emptyText}</p>
			)}
			{footer}
		</section>
	);
}
