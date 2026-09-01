"use client";

import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { PlanningAnalysisTab } from "./PlanningAnalysisTab";
import { PostTypesDialog } from "./PostTypesDialog";
import { PublishTopicDialog } from "./PublishTopicDialog";
import { TopicDecisionLog } from "./TopicDecisionLog";
import { TopicDetails } from "./TopicDetails";
import { TopicQuestionsPanel } from "./TopicQuestionsPanel";
import {
	POST_TYPE_LABELS,
	type PostType,
	TOPIC_STATUSES,
} from "./topic-shared";

/**
 * The three review tabs this page owns. Kept as a literal union rather than
 * derived from the array below so a typo in `setTab` is a compile error.
 */
type ReviewTab = "summaryQuestions" | "planningAnalysis" | "decisionLog";

const REVIEW_TABS: ReadonlyArray<{ value: ReviewTab; label: string }> = [
	{ value: "summaryQuestions", label: "Summary & Questions" },
	{ value: "planningAnalysis", label: "Planning & Analysis" },
	{ value: "decisionLog", label: "Decision Log" },
];

/**
 * Topic Item Page — review, planning and decision capture for ONE publishing
 * topic (Fizzy #1851, Phase 2A-1).
 *
 * Mirrors the Feature Item Page's UX — a default Summary & Questions tab, a
 * Decision Log, and a tab bar that later phases extend — deliberately WITHOUT
 * mirroring its file structure: `StoryWorkspace.tsx` is 8,485 lines, and
 * reproducing that shape here would trade a page nobody can hold in their head
 * for a superficial symmetry.
 *
 * Summary & Questions renders the topic's existing AI-written summary
 * (`pitch`, produced by Phase 1A) alongside its open and answered questions
 * (2A-3); the planning worksheet (2A-2) and the Decision Log — the same
 * decision-thread rows read as a filterable history (2A-3) — fill the other
 * two tabs. Content generation remains a shell: `GenerationTabsPlaceholder`
 * below is the only thing later phases (2B/2C) still need to replace.
 */
export function TopicItemPage({
	projectId,
	topicId,
	organizationId,
	canEdit,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
}) {
	const basePath = useBasePath();
	const queryClient = useQueryClient();
	const [tab, setTab] = useState<ReviewTab>("summaryQuestions");
	// The two metadata editors `TopicDetails` triggers. Held here rather than
	// inside that component because it is the SAME block the Inbox row mounts:
	// giving it its own dialogs would put two of each in the tree whenever both
	// surfaces are open, and would stop the row owning its own pending state.
	const [postTypesOpen, setPostTypesOpen] = useState(false);
	const [postTypesPending, setPostTypesPending] = useState(false);
	const [urlOpen, setUrlOpen] = useState(false);
	const [urlPending, setUrlPending] = useState(false);

	const topicQuery = useQuery(
		orpc.projects.publishingSuite.getTopic.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
	);
	const topic = topicQuery.data?.topic;

	// Fetched HERE rather than inside the Planning & Analysis panel: the
	// worksheet needs the SAME `latestAttempt` row the Summary & Questions
	// tab uses to decide whether its questions panel should explain a failure
	// rather than look merely empty (`analysisFailed`), so one poll serves
	// both rather than two independently-timed ones landing on different rows
	// mid-regeneration. The questions themselves no longer come from this
	// query at all — they are read from the topic's decision-thread rows
	// (2A-3), fetched separately below.
	//
	// The interval is the FUNCTION form so polling is keyed off the response
	// itself: it runs only while an attempt is GENERATING and stops the moment
	// the row goes terminal. A fixed interval would keep polling a finished
	// analysis for as long as the tab stays open.
	const analysisQuery = useQuery({
		...orpc.projects.publishingSuite.getPlanningAnalysis.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
		refetchInterval: (query) => {
			const attempt = query.state.data?.latestAttempt;
			// A LIVE run only. An attempt past its deadline will never change on
			// its own — nothing sweeps it; the next attempt reclaims it — so
			// polling one would be an interval that never ends.
			return attempt?.status === "GENERATING" && !attempt.isExpired
				? 3000
				: false;
		},
	});
	const latestAttempt = analysisQuery.data?.latestAttempt ?? null;
	const latestReady = analysisQuery.data?.latestReady ?? null;

	// The topic's decision thread (2A-3) — the source of truth for the
	// Summary & Questions tab's open and answered questions AND, read here as
	// a filterable history rather than a worklist, the Decision Log tab. One
	// query, two tabs, so answering a question on one cannot leave the other
	// stale. Rows survive a failed regeneration (`failPlanningAnalysis`
	// writes no question at all), so this query, unlike `analysisQuery`
	// above, has no failure branch to account for.
	const decisionsQuery = useQuery(
		orpc.projects.publishingSuite.listTopicDecisions.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
	);

	// 1D's FR4 makes expanding a row "opening" it, which writes the read
	// marker. Opening the whole page is the strongest form of opening there
	// is, so it must not be the one that does not count.
	//
	// The ref guard is load-bearing: `topic` is a fresh object on every
	// refetch, and the mutation's own `invalidateQueries` triggers one, so
	// without it a successful write re-enters this effect and writes again in
	// a loop.
	const markedRead = useRef(false);

	const setReadState = useMutation(
		orpc.projects.publishingSuite.setTopicReadState.mutationOptions({
			onSuccess: () => {
				// The Inbox's unread dot is rendered from the LIST query, not
				// this one, so marking read here has to invalidate that list or
				// the user returns to a row still showing as unread.
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.publishingSuite.listTopics.queryKey(
						{ input: { projectId, organizationId } },
					),
				});
			},
			onError: () => {
				// Same message the Inbox row shows for this exact write — the
				// marker is cosmetic, but failing it silently leaves the unread
				// dot stale with nothing to explain why.
				toast.error(
					"We couldn't update that topic's read state. Please try again.",
				);
				// Release the guard. It exists to stop a write LOOP, not to
				// make one failure permanent for the life of the mount: a
				// failed write does not invalidate the list, so `topic` keeps
				// its identity and this effect will not re-fire on its own —
				// only a genuine refetch (a refocus, or navigating back) gets
				// to try again.
				markedRead.current = false;
			},
		}),
	);
	useEffect(() => {
		if (!topic || topic.isRead || markedRead.current) {
			return;
		}
		markedRead.current = true;
		setReadState.mutate({
			projectId,
			topicId,
			organizationId,
			read: true,
		});
	}, [topic, projectId, topicId, organizationId, setReadState.mutate]);

	// A metadata write changes what THIS page renders and what the Inbox row
	// renders, and the two read different queries — invalidating only `getTopic`
	// would leave the list showing the pre-edit chips until it refetched on its
	// own.
	const invalidateTopic = () => {
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.getTopic.queryKey({
				input: { projectId, topicId, organizationId },
			}),
		});
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopics.queryKey({
				input: { projectId, organizationId },
			}),
		});
	};

	const updatePostTypes = useMutation(
		orpc.projects.publishingSuite.updateTopicPostTypes.mutationOptions({
			onSuccess: invalidateTopic,
			// Same contract as the Inbox row's copy of this write: never fail
			// silently, or the chips snap back with nothing to explain why.
			onError: () => {
				toast.error(
					"We couldn't update the post types. Please try again.",
				);
			},
		}),
	);

	const updateStatus = useMutation(
		orpc.projects.publishingSuite.updateTopicStatus.mutationOptions({
			onSuccess: invalidateTopic,
			onError: () => {
				toast.error("We couldn't update that topic. Please try again.");
			},
		}),
	);

	// Both handlers close the dialog only AFTER the write lands, so a failure
	// keeps the user's checkboxes / typed URL instead of discarding them —
	// the contract `TopicRow.handlePostTypesSubmit` established in Task 6.
	const handlePostTypesSubmit = async (postTypes: PostType[] | null) => {
		setPostTypesPending(true);
		try {
			await updatePostTypes.mutateAsync({
				projectId,
				organizationId,
				topicId,
				postTypes,
			});
			setPostTypesOpen(false);
		} catch {
			// Surfaced by this mutation's onError toast above.
		} finally {
			setPostTypesPending(false);
		}
	};

	// Reached only from a PUBLISHED topic (`TopicDetails` renders the control
	// under that status alone), so this re-asserts PUBLISHED with a new URL
	// rather than transitioning the topic.
	const handleUrlConfirm = async (url: string | null) => {
		setUrlPending(true);
		try {
			await updateStatus.mutateAsync({
				projectId,
				organizationId,
				topicId,
				status: "PUBLISHED",
				declineReason: null,
				publishedUrl: url,
			});
			setUrlOpen(false);
		} catch {
			// Surfaced by this mutation's onError toast above.
		} finally {
			setUrlPending(false);
		}
	};

	const backHref = `${basePath}/projects/${projectId}/publishing`;

	if (topicQuery.isPending) {
		return (
			<output
				className="flex h-64 items-center justify-center text-muted-foreground text-sm"
				aria-live="polite"
			>
				Loading topic…
			</output>
		);
	}

	if (topicQuery.isError || !topic) {
		// UC1 alternate flow. A topic in ANOTHER project produces the same
		// NOT_FOUND the API gives a missing one, so this state deliberately
		// cannot distinguish the two — saying "you lack access" would confirm
		// the topic exists.
		return (
			<div className="space-y-4 p-6">
				<BackLink href={backHref} />
				<h1 className="font-serif text-2xl">Topic not found</h1>
				<p className="text-muted-foreground text-sm">
					This topic may have been deleted, or it belongs to another
					project.
				</p>
			</div>
		);
	}

	const statusLabel =
		TOPIC_STATUSES.find((s) => s.value === topic.status)?.label ??
		topic.status;

	return (
		<div className="space-y-6 p-6">
			<div className="space-y-3">
				<BackLink href={backHref} />
				<p className="editorial-label">Publishing topic</p>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<h1 className="font-serif font-normal text-3xl leading-tight">
						{topic.title}
					</h1>
					<span
						className="shrink-0 rounded-full border border-border bg-muted px-3 py-1 text-muted-foreground text-xs"
						data-testid="topic-status"
					>
						{statusLabel}
					</span>
				</div>
				{topic.angle ? (
					<p className="text-muted-foreground text-sm">
						{topic.angle}
					</p>
				) : null}
				{topic.declineReason ? (
					<p className="border-destructive border-l-2 pl-3 text-muted-foreground text-sm">
						{topic.declineReason}
					</p>
				) : null}
			</div>

			<Tabs
				value={tab}
				onValueChange={(v) => setTab(v as ReviewTab)}
				className="space-y-4"
			>
				<TabsList aria-label="Topic review">
					{REVIEW_TABS.map((t) => (
						<TabsTrigger key={t.value} value={t.value}>
							{t.label}
						</TabsTrigger>
					))}
				</TabsList>

				<TabsContent value="summaryQuestions" className="space-y-6">
					{topic.pitch ? (
						<p className="max-w-3xl text-foreground text-sm leading-relaxed">
							{topic.pitch}
						</p>
					) : (
						<EmptyState>This topic has no summary yet.</EmptyState>
					)}
					{/* The metadata block is `TopicDetails`, the SAME component
					    the Inbox row mounts — not a copy of it. The two views
					    show the same fields, so a second implementation would
					    drift the first time either changed. */}
					<TopicDetails
						topic={topic}
						canEdit={canEdit}
						isPending={postTypesPending || urlPending}
						onEditUrl={() => setUrlOpen(true)}
						onEditPostTypes={() => setPostTypesOpen(true)}
					/>
					<TopicQuestionsPanel
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						canEdit={canEdit}
						isLoading={decisionsQuery.isLoading}
						analysisFailed={latestAttempt?.status === "FAILED"}
						threads={decisionsQuery.data?.threads ?? []}
					/>
				</TabsContent>

				<TabsContent value="planningAnalysis">
					<PlanningAnalysisTab
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						canEdit={canEdit}
						isLoading={analysisQuery.isLoading}
						latestAttempt={latestAttempt}
						latestReady={latestReady}
					/>
				</TabsContent>

				<TabsContent value="decisionLog">
					<TopicDecisionLog
						threads={decisionsQuery.data?.threads ?? []}
						isLoading={decisionsQuery.isLoading}
					/>
				</TabsContent>
			</Tabs>

			<GenerationTabsPlaceholder />

			{/* The editors behind `TopicDetails`' two affordances. Mounted only
			    for an editor: the controls that open them are themselves
			    `canEdit`-gated (PR2), so rendering the dialogs for a reader
			    would put unreachable write UI in the tree. */}
			{canEdit ? (
				<>
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
					<PublishTopicDialog
						topicTitle={topic.title}
						open={urlOpen}
						onOpenChange={setUrlOpen}
						onConfirm={handleUrlConfirm}
						isPending={urlPending}
						initialUrl={topic.publishedUrl}
						title="Edit published URL"
						confirmLabel="Save"
					/>
				</>
			) : null}
		</div>
	);
}

function BackLink({ href }: { href: string }) {
	return (
		<Link
			href={href}
			className="inline-flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground"
		>
			<ArrowLeftIcon className="size-4" aria-hidden="true" />
			Back to Publishing Suite
		</Link>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}

/**
 * FR48–FR51: the shell for the content types later phases will generate.
 *
 * Driven off `POST_TYPE_LABELS` — the same fixed-order rendering of the
 * `PublishingTopicPostType` enum the Inbox row uses — so Phase 2B/2C activate
 * a tab by shipping its feature, with no edit to a second hand-maintained list
 * that could disagree with the enum (DV15).
 *
 * Every trigger is `disabled`. FR50 forbids exposing functional generation UI
 * in 2A, and a tab a user can activate is a promise this phase cannot keep.
 * The `Tabs` value matches no trigger, so no panel is selected.
 */
function GenerationTabsPlaceholder() {
	return (
		<div className="space-y-2">
			<p className="editorial-label">Content generation</p>
			<Tabs value="__none__">
				<TabsList
					aria-label="Content generation"
					className="flex-wrap opacity-70"
				>
					{POST_TYPE_LABELS.map((t) => (
						<TabsTrigger key={t.value} value={t.value} disabled>
							{t.label}
							<span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground uppercase tracking-wide">
								Coming soon
							</span>
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
		</div>
	);
}
