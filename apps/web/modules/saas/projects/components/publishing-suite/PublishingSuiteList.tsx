"use client";

import type { ApiRouterClient } from "@repo/api/orpc/router";
import { FUNCTION_TAG_LABELS } from "@repo/database/src/function-tags";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { AlertTriangleIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { CreateTopicDialog } from "./CreateTopicDialog";
import { DeclineTopicDialog } from "./DeclineTopicDialog";
import { PostTypesDialog } from "./PostTypesDialog";
import { PublishingCycleHistory } from "./PublishingCycleHistory";
import { PublishTopicDialog } from "./PublishTopicDialog";

/** Only http(s) URLs are safe to render as a navigable href — a stored
 * `javascript:`/`data:` URL would otherwise be a stored-XSS vector when
 * another project member clicks the link. Saving stays lenient (DV6);
 * this only gates NAVIGATION. */
function isSafeHttpUrl(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "http:" || u.protocol === "https:";
	} catch {
		return false;
	}
}

/** The five `PublishingTopicStatus` values, in triage order, with UI labels.
 *  Snooze is deliberately absent: it is an overlay (`isSnoozed`), not a status,
 *  so it filters separately below. */
type TopicStatus =
	| "SUGGESTION"
	| "SELECTED"
	| "IN_PROGRESS"
	| "PUBLISHED"
	| "DECLINED";

const TOPIC_STATUSES: ReadonlyArray<{ value: TopicStatus; label: string }> = [
	{ value: "SUGGESTION", label: "Suggestion" },
	{ value: "SELECTED", label: "Selected" },
	{ value: "IN_PROGRESS", label: "In progress" },
	{ value: "PUBLISHED", label: "Published" },
	{ value: "DECLINED", label: "Declined" },
];

// Inferred from the oRPC list-topics output (Task 2) — never `any`. Type-only,
// so it is erased at build time and adds no runtime coupling to the API package.
type PublishingTopic = Awaited<
	ReturnType<ApiRouterClient["projects"]["publishingSuite"]["listTopics"]>
>["items"][number];

// The `PublishingTopicPostType` union, sourced from the API type so a schema
// change surfaces here at compile time (and keeps the chip filter below
// cast-free).
type PostType = PublishingTopic["suggestedPostTypes"][number];

// 1B: the four `PublishingTopicPostType` values, in fixed display order, with
// UI labels — an AI topic's suggested-post-type chip row renders in this
// order regardless of the array order the API returns.
const POST_TYPE_LABELS: ReadonlyArray<{ value: PostType; label: string }> = [
	{ value: "TWEET", label: "Tweet" },
	{ value: "BLOG_POST", label: "Blog Post" },
	{ value: "CASE_STUDY", label: "Case Study" },
	{ value: "STAKEHOLDER_EMAIL", label: "Stakeholder Email" },
];

type WhySuggested = NonNullable<PublishingTopic["whySuggested"]>;

// Compose the muted "why suggested" line (format C). Returns the full string
// including the "Based on " prefix. Segments join with " · ".
function formatWhySuggested(w: WhySuggested): string {
	const segments: string[] = [];
	for (const s of w.named) {
		segments.push(
			s.type === "meeting"
				? s.label
					? `"${s.label}" meeting`
					: "Meeting"
				: `"${s.label}"`,
		);
	}
	if (w.prCount > 0) {
		segments.push(`${w.prCount} ${w.prCount === 1 ? "PR" : "PRs"}`);
	}
	if (w.overflowCount > 0) {
		segments.push(`+${w.overflowCount} more`);
	}
	return `Based on ${segments.join(" · ")}`;
}

type MeetingSpeakers = NonNullable<PublishingTopic["meetingSpeakers"]>;

// Compose the muted "Meeting participants —" line. Visible token per member:
// @username, else name. Join ", "; append "+N more" for overflow. The label is
// intentionally soft (heuristic name match, not verified identity — spec D9/§8.1).
function formatMeetingParticipants(m: MeetingSpeakers): string {
	const shown = m.members
		.map((p) => (p.username ? `@${p.username}` : (p.name ?? "")))
		.filter((token) => token !== "")
		.join(", ");
	const overflow = m.overflowCount > 0 ? ` +${m.overflowCount} more` : "";
	return `Meeting participants — ${shown}${overflow}`;
}

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
	const [createOpen, setCreateOpen] = useState(false);
	const [statusFilter, setStatusFilter] = useState<
		TopicStatus | "SNOOZED" | null
	>(null); // null = all
	// C-Med2: topics whose status mutation is currently in flight. Disabling a
	// row's control while ITS request is pending stops rapid changes on the same
	// topic from racing (an older response overwriting a newer choice).
	const [pendingTopicIds, setPendingTopicIds] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

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
		setPendingTopicIds((prev) => new Set(prev).add(topicId));
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
			setPendingTopicIds((prev) => {
				const next = new Set(prev);
				next.delete(topicId);
				return next;
			});
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
		setPendingTopicIds((prev) => new Set(prev).add(topicId));
		try {
			await updatePostTypes.mutateAsync({
				projectId,
				organizationId,
				topicId,
				postTypes,
			});
		} finally {
			setPendingTopicIds((prev) => {
				const next = new Set(prev);
				next.delete(topicId);
				return next;
			});
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
	const cycleStatus = cycleQuery.data?.cycle?.status ?? null;
	const hasCycle = cycleQuery.data?.cycle != null;

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
				{visibleTopics.length > 0 ? (
					<ul className="space-y-2">
						{visibleTopics.map((t) => (
							<TopicRow
								key={t.id}
								topic={t}
								canEdit={canEdit}
								isPending={pendingTopicIds.has(t.id)}
								onChangeStatus={(
									status,
									declineReason,
									publishedUrl,
								) =>
									changeStatus(
										t.id,
										status,
										declineReason,
										publishedUrl,
									)
								}
								onChangePostTypes={(postTypes) =>
									changePostTypes(t.id, postTypes)
								}
							/>
						))}
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
				<h2 className="font-serif text-2xl font-normal text-foreground">
					Publishing Suite
				</h2>
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
// Row: title + pitch + status control (with the styled decline dialog).
// ---------------------------------------------------------------------------

function TopicRow({
	topic,
	canEdit,
	isPending,
	onChangeStatus,
	onChangePostTypes,
}: {
	topic: PublishingTopic;
	canEdit: boolean;
	/** True while THIS topic's status mutation is in flight (C-Med2). */
	isPending: boolean;
	onChangeStatus: (
		status: TopicStatus,
		declineReason: string | null,
		publishedUrl: string | null,
	) => Promise<void>;
	onChangePostTypes: (postTypes: PostType[] | null) => Promise<void>;
}) {
	const [declineOpen, setDeclineOpen] = useState(false);
	const [declinePending, setDeclinePending] = useState(false);
	const [publishOpen, setPublishOpen] = useState(false);
	const [publishPending, setPublishPending] = useState(false);
	const [postTypesOpen, setPostTypesOpen] = useState(false);
	const [postTypesPending, setPostTypesPending] = useState(false);

	const handleValueChange = (next: string) => {
		if (next === topic.status) {
			return;
		}
		if (next === "DECLINED") {
			// Route through the styled dialog to collect an optional reason.
			setDeclineOpen(true);
			return;
		}
		if (next === "PUBLISHED") {
			// Route through the styled dialog to collect an optional URL.
			setPublishOpen(true);
			return;
		}
		// Fire-and-forget: a failure is surfaced by the shared mutation's
		// onError toast. The catch only prevents an unhandled rejection.
		void onChangeStatus(next as TopicStatus, null, null).catch(() => {});
	};

	// C-Med2: close the dialog only AFTER the decline succeeds, so a failed
	// decline keeps the typed reason (and surfaces the error via the shared
	// onError toast) instead of silently discarding it.
	const handleDeclineConfirm = async (reason: string | null) => {
		setDeclinePending(true);
		try {
			await onChangeStatus("DECLINED", reason, null);
			setDeclineOpen(false);
		} catch {
			// Error already surfaced by the shared mutation's onError toast;
			// keep the dialog open so the reason isn't lost.
		} finally {
			setDeclinePending(false);
		}
	};

	// Two DISTINCT exits (Global Constraints): "Mark as published" (this
	// handler) always mutates — with the typed URL, or `null` when dismissed
	// (FR15). Cancel/Escape/overlay-close never call this handler at all; they
	// only flip `publishOpen` back to false via the dialog's plain
	// `onOpenChange={setPublishOpen}` below, so the topic stays in its prior
	// status with no mutation (ticket line 141).
	const handlePublishConfirm = async (url: string | null) => {
		setPublishPending(true);
		try {
			await onChangeStatus("PUBLISHED", null, url);
			setPublishOpen(false);
		} catch {
			// Error surfaced by the shared mutation onError toast; keep dialog
			// open so the typed URL isn't lost (mirrors decline).
		} finally {
			setPublishPending(false);
		}
	};

	const handlePostTypesSubmit = async (postTypes: PostType[] | null) => {
		setPostTypesPending(true);
		try {
			await onChangePostTypes(postTypes);
			setPostTypesOpen(false);
		} catch {
			// Surfaced by the shared mutation's onError toast; keep the dialog
			// open so the user's checkbox choices aren't lost (mirrors decline).
		} finally {
			setPostTypesPending(false);
		}
	};

	return (
		<li className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
			<div className="min-w-0 space-y-1">
				<p className="font-medium text-foreground">{topic.title}</p>
				{topic.angle ? (
					<p className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
						<span className="uppercase tracking-[0.15em] text-muted-foreground">
							Angle
						</span>
						<span className="text-foreground">{topic.angle}</span>
					</p>
				) : null}
				{topic.pitch ? (
					<p className="text-sm leading-6 text-muted-foreground">
						{topic.pitch}
					</p>
				) : null}
				{topic.whySuggested ? (
					<p className="text-xs text-muted-foreground">
						{formatWhySuggested(topic.whySuggested)}
					</p>
				) : null}
				{topic.rankReason ? (
					<p className="border-l-2 border-primary pl-2 text-xs text-muted-foreground">
						{topic.rankReason.kind === "contributed"
							? "Based on your contribution"
							: `Matches your role: ${topic.rankReason.matchedTags
									.map((t) => FUNCTION_TAG_LABELS[t])
									.join(", ")}`}
					</p>
				) : null}
				{topic.meetingSpeakers ? (
					<p
						className="text-xs text-muted-foreground"
						aria-label={`Meeting participants: ${topic.meetingSpeakers.members
							.map((m) => m.name ?? "")
							.filter((token) => token !== "")
							.join(", ")}${
							topic.meetingSpeakers.overflowCount > 0
								? `, and ${topic.meetingSpeakers.overflowCount} more`
								: ""
						}`}
					>
						{formatMeetingParticipants(topic.meetingSpeakers)}
					</p>
				) : null}
				{topic.subject ? (
					<p
						className="text-xs text-muted-foreground"
						aria-label={`Subject: ${topic.subject}`}
					>
						Subject · {topic.subject}
					</p>
				) : null}
				{topic.status === "PUBLISHED" ? (
					<div className="flex items-center gap-2">
						{topic.publishedUrl ? (
							isSafeHttpUrl(topic.publishedUrl) ? (
								<a
									href={topic.publishedUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-block truncate text-sm text-primary underline underline-offset-2"
								>
									{topic.publishedUrl}
								</a>
							) : (
								<span
									className="inline-block truncate text-sm text-muted-foreground"
									title={topic.publishedUrl}
								>
									{topic.publishedUrl}
								</span>
							)
						) : null}
						{canEdit ? (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								aria-label={
									topic.publishedUrl ? "Edit URL" : "Add URL"
								}
								// C-Med2 (extended to this new affordance): a
								// status mutation for THIS topic is in flight —
								// block a second, racing mutation the same way
								// the Select is already blocked below.
								disabled={isPending}
								onClick={() => setPublishOpen(true)}
							>
								{topic.publishedUrl ? "Edit URL" : "Add URL"}
							</Button>
						) : null}
					</div>
				) : null}
				{topic.contributors.length > 0 ? (
					<ul
						className="flex flex-wrap items-center gap-1.5 pt-1"
						aria-label="Contributors"
					>
						{topic.contributors.map((c) => (
							<li
								key={c.id}
								className="flex items-center gap-1"
								aria-label={`Contributor: ${c.name}`}
							>
								{c.image ? (
									// eslint-disable-next-line @next/next/no-img-element
									<img
										src={c.image}
										alt=""
										className="size-4 rounded-full"
									/>
								) : (
									<span
										aria-hidden
										className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground"
									>
										{c.name.charAt(0).toUpperCase()}
									</span>
								)}
								<span className="text-xs text-muted-foreground">
									{c.username ?? c.name}
								</span>
							</li>
						))}
					</ul>
				) : null}
				{topic.authorRecommendation ? (
					<p
						className="text-xs text-muted-foreground"
						aria-label={`${
							topic.authorRecommendation.model === "single"
								? "Recommended author"
								: "Recommended co-authors"
						}: ${topic.authorRecommendation.authors
							.map(
								(a) =>
									`${a.name}, ${a.matchedTags
										.map((t) => FUNCTION_TAG_LABELS[t])
										.join(" and ")}`,
							)
							.join("; ")}`}
					>
						{topic.authorRecommendation.model === "single"
							? "Recommended author — "
							: "Recommended co-authors — "}
						{topic.authorRecommendation.authors
							.map(
								(a) =>
									`${a.username ? `@${a.username}` : a.name} · ${a.matchedTags
										.map((t) => FUNCTION_TAG_LABELS[t])
										.join(", ")}`,
							)
							.join("; ")}
					</p>
				) : null}
				{(() => {
					const effectivePostTypes =
						topic.userPostTypes ?? topic.suggestedPostTypes;
					if (effectivePostTypes.length === 0 && !canEdit) {
						return null;
					}
					const recByType = new Map(
						topic.postTypeRecommendations.map((r) => [r.type, r]),
					);
					const chipClassName =
						"appearance-none rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground";
					return (
						<TooltipProvider>
							<div
								data-testid="post-type-row"
								role="group"
								className="flex flex-wrap items-center gap-1.5 pt-1"
								aria-label="Post types"
							>
								{POST_TYPE_LABELS.filter((p) =>
									effectivePostTypes.includes(p.value),
								).map((p) => {
									const rec = recByType.get(p.value);
									const chipContent = (
										<>
											<span>{p.label}</span>
											{rec?.theme ? (
												<span className="text-muted-foreground/70">
													{" · "}
													{rec.theme}
												</span>
											) : null}
										</>
									);
									// Enriched chip: a real, focusable, nameable
									// control. A bare <span> has the implicit ARIA
									// role `generic`, which PROHIBITS naming from
									// `aria-label` (WAI-ARIA 1.2 §5.2.8.6) — the
									// rationale would be inert to screen readers —
									// and Radix's `TooltipTrigger asChild` never
									// adds `tabIndex` to a non-interactive clone, so
									// a keyboard-only user could never focus it to
									// reveal the tooltip either. `button` is
									// natively focusable AND its role permits
									// `aria-label` naming, fixing both gaps.
									return rec?.rationale ? (
										<Tooltip key={p.value}>
											<TooltipTrigger asChild>
												<button
													type="button"
													className={chipClassName}
													aria-label={`Why ${p.label}${rec.theme ? `: ${rec.theme}` : ""}. ${rec.rationale}`}
												>
													{chipContent}
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{rec.rationale}
											</TooltipContent>
										</Tooltip>
									) : (
										<span
											key={p.value}
											className={chipClassName}
										>
											{chipContent}
										</span>
									);
								})}
								{canEdit ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={isPending}
										onClick={() => setPostTypesOpen(true)}
									>
										Edit post types
									</Button>
								) : null}
							</div>
						</TooltipProvider>
					);
				})()}
			</div>
			<div className="shrink-0">
				<Select
					value={topic.status}
					onValueChange={handleValueChange}
					disabled={!canEdit || isPending}
				>
					<SelectTrigger
						className="w-[10rem]"
						aria-label={`Status for ${topic.title}`}
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TOPIC_STATUSES.map((s) => (
							<SelectItem key={s.value} value={s.value}>
								{s.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<DeclineTopicDialog
				topicTitle={topic.title}
				open={declineOpen}
				onOpenChange={setDeclineOpen}
				onConfirm={handleDeclineConfirm}
				isPending={declinePending}
			/>
			<PublishTopicDialog
				topicTitle={topic.title}
				open={publishOpen}
				onOpenChange={setPublishOpen}
				onConfirm={handlePublishConfirm}
				isPending={publishPending}
				initialUrl={topic.publishedUrl}
				title={
					topic.status === "PUBLISHED"
						? "Edit published URL"
						: undefined
				}
				confirmLabel={topic.status === "PUBLISHED" ? "Save" : undefined}
			/>
			<PostTypesDialog
				topicTitle={topic.title}
				open={postTypesOpen}
				onOpenChange={setPostTypesOpen}
				initialSelected={
					topic.userPostTypes ?? topic.suggestedPostTypes
				}
				hasOverride={topic.userPostTypes !== null}
				hasAiSuggestion={topic.suggestedPostTypes.length > 0}
				onSubmit={handlePostTypesSubmit}
				isPending={postTypesPending}
			/>
		</li>
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
