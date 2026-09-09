"use client";

import { useSession } from "@saas/auth/hooks/use-session";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssigneesDialog } from "./AssigneesDialog";
import { ContentTypesChecklist } from "./ContentTypesChecklist";
import { ContributorsDialog } from "./ContributorsDialog";
import {
	buildGenerationTabModel,
	GenerationTabPanels,
	GenerationTabTriggers,
} from "./GenerationTabs";
import { PlanningAnalysisTab } from "./PlanningAnalysisTab";
import { PostTypesDialog } from "./PostTypesDialog";
import { PublishTopicDialog } from "./PublishTopicDialog";
import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "./planning-analysis-content";
import { TopicDecisionLog } from "./TopicDecisionLog";
import { TopicDetails } from "./TopicDetails";
import { TopicQuestionsPanel } from "./TopicQuestionsPanel";
import { TopicReadiness } from "./TopicReadiness";
import {
	ALL_POST_TYPES,
	GENERATION_ACTIVE_POST_TYPES,
	type PostType,
	TOPIC_STATUSES,
} from "./topic-shared";

/**
 * The three review tabs this page owns. Kept as a literal union rather than
 * derived from the array below so a typo in `setTab` is a compile error.
 */
type ReviewTab = "summaryQuestions" | "decisionLog" | "planningAnalysis";

/**
 * Row 1. Ordered to match the Feature Item Page — Summary & Questions,
 * Decisions, then the document — because the PO asked for exactly that
 * sequence and because the two pages reading differently is the whole
 * complaint the 2A rework exists to answer.
 *
 * FR6 requires Summary & Questions to be the DEFAULT tab, not the first one,
 * and it stays the default below.
 */
const REVIEW_TABS: ReadonlyArray<{ value: ReviewTab; label: string }> = [
	{ value: "summaryQuestions", label: "Summary & Questions" },
	{ value: "decisionLog", label: "Decision Log" },
	{ value: "planningAnalysis", label: "Planning & Analysis" },
];

/**
 * One selection across BOTH rows of the strip.
 *
 * The content types are a second ROW of the same tab set, not a tab inside a
 * tab: picking Blog Post deselects Summary & Questions, the same way picking
 * Decision Log does. That is what stops the page rendering two independent tab
 * strips at once — the shape the PO flagged as "tabs way down here, really
 * easy to get lost".
 */
type ActiveTab = ReviewTab | PostType;

const REVIEW_TAB_VALUES: ReadonlySet<string> = new Set(
	REVIEW_TABS.map((t) => t.value),
);

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
 * two tabs.
 *
 * Content generation is `GenerationTabs` (2B-1), which replaced 2A's disabled
 * placeholder. It gives each live content type its recommendation context, the
 * unresolved questions that constrain a draft OF THAT TYPE, and a panel that
 * generates and edits one: Short Post / Tweet and Blog Post from 2B-2/2B-3,
 * Case Study from 2C-1 and Stakeholder Email from 2C-2 (#1854). All four are
 * live; no tab reads "Coming soon" any more.
 *
 * FOUR queries, all fetched HERE rather than inside the tabs that read them.
 * `latestAttempt` drives both the Planning & Analysis panel and Summary &
 * Questions' failure wording; the decision threads drive Summary & Questions,
 * the Decision Log AND the generation tabs' restriction warnings. One poll,
 * many readers — two independently-timed queries could land on different rows
 * mid-regeneration and leave two tabs contradicting each other.
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
	const queryClient = useQueryClient();
	const { user } = useSession();
	const viewerUserId = user?.id ?? null;
	const [tab, setTab] = useState<ActiveTab>("summaryQuestions");
	// The three metadata editors `TopicDetails` triggers. Held here rather than
	// inside that component because it is the SAME block the Inbox row mounts:
	// giving it its own dialogs would put two of each in the tree whenever both
	// surfaces are open, and would stop the row owning its own pending state.
	const [postTypesOpen, setPostTypesOpen] = useState(false);
	const [postTypesPending, setPostTypesPending] = useState(false);
	const [urlOpen, setUrlOpen] = useState(false);
	const [urlPending, setUrlPending] = useState(false);
	const [contributorsOpen, setContributorsOpen] = useState(false);
	const [contributorsPending, setContributorsPending] = useState(false);
	const [assigneesOpen, setAssigneesOpen] = useState(false);
	const [assigneesPending, setAssigneesPending] = useState(false);

	const topicQuery = useQuery(
		orpc.projects.publishingSuite.getTopic.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
	);
	const topic = topicQuery.data?.topic;

	// STABLE across any re-render that carries no real change — see the same
	// memo in `TopicRow.tsx` for the full reasoning. Keyed on the two
	// contributor fields themselves, NOT on `topic` — TanStack Query's
	// structural sharing keeps `topic` referentially stable across a no-op
	// refetch, but ANY OTHER field changing (a read marker, a status edit,
	// `updatedAt`) mints a new `topic` object and would re-run this memo,
	// re-seeding `ContributorsDialog`'s selection and discarding whatever the
	// user had just checked. Called unconditionally (before the early returns
	// below), so it has to tolerate `topic` being undefined while the query is
	// still pending.
	const contributorIds = useMemo(
		() =>
			topic
				? (topic.userContributorUserIds ??
					topic.contributors.map((c) => c.id))
				: [],
		[topic?.userContributorUserIds, topic?.contributors],
	);

	// A8, same stability contract as `contributorIds` above and the same
	// tolerance for `topic` being undefined while the query is pending. Seeded
	// from the RAW `assigneeUserIds`, never the resolved `assignees`: the two
	// differ exactly when a handle failed to resolve, and seeding from the
	// handles would let Save silently drop whoever the lookup lost.
	const assigneeIds = useMemo(
		() => topic?.assigneeUserIds ?? [],
		[topic?.assigneeUserIds],
	);

	// For the contributors picker (Task 6). This page owns its own queries and
	// mutations rather than going through `PublishingSuiteList` — it is the
	// OTHER mount, not a child of the list.
	const membersQuery = useQuery(
		orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const members = membersQuery.data?.members ?? [];

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
	// `effective` is the resolver's one answer to "what is this topic's
	// analysis right now" (AI text, or the author's own override). BOTH the
	// Planning & Analysis tab and the media-tab gate below read it, so an
	// author who edits a risk-heavy analysis neither loses their generation
	// tabs nor sees the raw AI text they replaced (Fizzy #1851, Tasks 8/11).
	// The newest READY row itself is no longer part of the response at all —
	// shipping it would keep a supported path to the un-overridden AI text.
	const effective = analysisQuery.data?.effective ?? null;

	/**
	 * The DATA half of the analysis, parsed once for the generation panels.
	 *
	 * `effective.data` never carries the prose keys (`topicAngle`, `risks`,
	 * `preDraftGuidance`, …), so this is the structured half — exactly what the
	 * content-type buckets need. An analysis that came back empty carries no
	 * recommendation, so it resolves to `null` rather than rendering tabs whose
	 * AVAILABLE state nothing explains. Empty is judged against BOTH halves, so
	 * a risk-heavy analysis with no structured recommendations still counts.
	 */
	const analysisDocument = useMemo(() => {
		if (!effective) {
			return null;
		}
		const doc = readPlanningAnalysis(effective.data);
		return isEmptyAnalysis(effective) ? null : doc;
	}, [effective]);

	/**
	 * The content types row 2 offers: the user's override when set, the AI
	 * suggestion otherwise — the same resolution `PostTypesDialog` seeds from,
	 * so the strip and the dialog can never disagree.
	 *
	 * EMPTY FALLS BACK TO ALL OF THEM, and that is a requirement rather than a
	 * kindness. #1853 FR1/FR2 say the system SHALL activate the Short Post and
	 * Blog Post tabs; narrowing the strip to a selection is only legitimate
	 * while a selection exists to narrow it to. Topics created before 1B started
	 * writing `suggestedPostTypes` have none, and every manually-created topic
	 * starts with none — hiding generation from them would strand the feature
	 * behind a dialog nobody has a reason to open.
	 */
	const selectedPostTypes: readonly PostType[] = useMemo(() => {
		const chosen =
			topicQuery.data?.topic?.userPostTypes ??
			topicQuery.data?.topic?.suggestedPostTypes ??
			[];
		return chosen.length > 0 ? chosen : ALL_POST_TYPES;
	}, [
		topicQuery.data?.topic?.userPostTypes,
		topicQuery.data?.topic?.suggestedPostTypes,
	]);

	// The topic's decision thread (2A-3) — the source of truth for the
	// Summary & Questions tab's open and answered questions AND, read here as
	// a filterable history rather than a worklist, the Decision Log tab. One
	// query, two tabs, so answering a question on one cannot leave the other
	// stale. Rows survive a failed regeneration (`failPlanningAnalysis`
	// writes no question at all), so this query, unlike `analysisQuery`
	// above, has no failure branch to account for.
	/**
	 * The per-content-type read marker behind the "Changed" badge (#46).
	 *
	 * Invalidates the DRAFTS query on success, because that is where the
	 * markers are read from — without it the badge a reader has just cleared
	 * stays on screen until something else refetches.
	 */
	const markDraftRead = useMutation(
		orpc.projects.publishingSuite.markTopicDraftRead.mutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDrafts.queryKey({
							input: { projectId, topicId, organizationId },
						}),
				});
			},
		}),
	);

	const decisionsQuery = useQuery(
		orpc.projects.publishingSuite.listTopicDecisions.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
	);

	/**
	 * Refetch the questions when an analysis run FINISHES.
	 *
	 * Questions are minted server-side at exactly that moment —
	 * `reconcileTopicQuestions` runs inside `completePlanningAnalysis`, in the
	 * same transaction that makes the analysis READY. But the query above is a
	 * plain one with no interval, so it was fetched once on mount, came back
	 * empty because the run had not happened yet, and nothing ever asked again.
	 *
	 * The result was a page contradicting itself in a single frame: the format
	 * tabs showed "Recommended" badges — read off the analysis query, which
	 * polls and had refetched — beside a panel reading "No open questions yet.
	 * They arrive with the planning analysis." They had arrived. Only a refocus
	 * or a reload, expiring the 60-second `staleTime`, ever showed them.
	 *
	 * Keyed on the TRANSITION out of `GENERATING`, not on the terminal status
	 * itself: an effect firing on `status === "READY"` would re-fire on every
	 * later refetch of a finished analysis and invalidate in a loop. A run that
	 * FAILED is included deliberately — reconciliation may still have
	 * soft-closed questions the previous run raised, and the panel explains a
	 * failure differently from an empty list.
	 */
	const previousAttemptStatus = useRef<string | null>(null);
	useEffect(() => {
		const status = latestAttempt?.status ?? null;
		const wasGenerating = previousAttemptStatus.current === "GENERATING";
		previousAttemptStatus.current = status;
		if (!wasGenerating || status === "GENERATING") {
			return;
		}
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.publishingSuite.listTopicDecisions.queryKey(
				{
					input: { projectId, topicId, organizationId },
				},
			),
		});
	}, [
		latestAttempt?.status,
		queryClient,
		projectId,
		topicId,
		organizationId,
	]);

	// 2B-1: the topic's generated-draft state, for the generation tab strip.
	// Polled on the SAME function-form interval the analysis query uses, so a
	// run that is in flight refreshes and a finished one stops costing anything.
	// Live from 2B-2: the short post's generate button puts a row into
	// GENERATING and nothing else reports when it finishes. The poll was written
	// alongside the query in 2B-1, before anything could trigger it, rather than
	// bolted on later when remembering is the failure mode.
	//
	// `isExpired` is part of the predicate, not decoration: a STRANDED row is
	// terminal in every way that matters — no worker will report on it — so
	// polling for it forever would be a request every three seconds for the life
	// of the tab.
	const draftsQuery = useQuery({
		...orpc.projects.publishingSuite.listTopicDrafts.queryOptions({
			input: { projectId, topicId, organizationId },
		}),
		refetchInterval: (query) => {
			const live = query.state.data?.drafts?.some(
				(d) =>
					d.latestAttempt?.status === "GENERATING" &&
					!d.latestAttempt.isExpired,
			);
			return live ? 3000 : false;
		},
	});

	const generationModel = useMemo(
		() =>
			buildGenerationTabModel({
				analysis: analysisDocument,
				drafts: draftsQuery.data?.drafts ?? [],
				workingDrafts: draftsQuery.data?.workingDrafts ?? [],
				decisionThreads: decisionsQuery.data?.threads ?? [],
				readMarkers: draftsQuery.data?.readMarkers,
				hasError: draftsQuery.isError,
			}),
		[
			analysisDocument,
			draftsQuery.data?.drafts,
			draftsQuery.data?.workingDrafts,
			draftsQuery.data?.readMarkers,
			decisionsQuery.data?.threads,
			draftsQuery.isError,
		],
	);

	/**
	 * Fall back to the default tab when the selected one stops existing —
	 * dropping a content type in `PostTypesDialog` while its tab is open would
	 * otherwise leave the page with a value no trigger and no panel answers to,
	 * and a blank content region. Derived rather than corrected in an effect so
	 * there is no frame where nothing renders.
	 */
	const activeTab: ActiveTab =
		REVIEW_TAB_VALUES.has(tab) ||
		selectedPostTypes.includes(tab as PostType)
			? tab
			: "summaryQuestions";

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

	const updateAssignees = useMutation(
		orpc.projects.publishingSuite.updateTopicAssignees.mutationOptions({
			// Same contract as `updateContributors` below: the response returns
			// the narrow topic record, which does NOT carry the assignee
			// column, so refresh by invalidating rather than reading
			// `response.topic`.
			onSuccess: invalidateTopic,
			onError: () => {
				toast.error(
					"We couldn't update the assignees. Please try again.",
				);
			},
		}),
	);

	const updateContributors = useMutation(
		orpc.projects.publishingSuite.updateTopicContributors.mutationOptions({
			// Same contract as `updatePostTypes` above: the mutation response
			// deliberately omits the override columns (Task 4), so refresh by
			// invalidating rather than reading `response.topic`.
			onSuccess: invalidateTopic,
			onError: () => {
				toast.error(
					"We couldn't update the contributors. Please try again.",
				);
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

	// This page's copy of `TopicRow.handleContributorsSubmit`: close only after
	// the write lands, so a failure keeps the user's checkbox choices.
	const handleContributorsSubmit = async (
		contributorUserIds: string[] | null,
	) => {
		setContributorsPending(true);
		try {
			await updateContributors.mutateAsync({
				projectId,
				organizationId,
				topicId,
				contributorUserIds,
			});
			setContributorsOpen(false);
		} catch {
			// Surfaced by this mutation's onError toast above.
		} finally {
			setContributorsPending(false);
		}
	};

	const handleAssigneesSubmit = async (assigneeUserIds: string[]) => {
		setAssigneesPending(true);
		try {
			await updateAssignees.mutateAsync({
				projectId,
				organizationId,
				topicId,
				assigneeUserIds,
			});
			setAssigneesOpen(false);
		} catch {
			// Surfaced by this mutation's onError toast above.
		} finally {
			setAssigneesPending(false);
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
			<div className="space-y-4">
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
		// Page padding is the ROUTE's (it owns the breadcrumb trail above
		// this, and the two have to share one inset).
		<div className="space-y-6">
			<div className="space-y-3">
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
				value={activeTab}
				onValueChange={(v) => {
					setTab(v as ActiveTab);
					// Opening a format tab IS looking at it — the strongest
					// form of looking there is — so the marker moves here
					// rather than waiting for a scroll or a click inside.
					// Fire-and-forget: a failed marker costs a stale "Changed"
					// badge, which is not worth a toast interrupting the thing
					// the reader just asked for.
					if (
						GENERATION_ACTIVE_POST_TYPES.has(v as PostType) &&
						selectedPostTypes.includes(v as PostType)
					) {
						markDraftRead.mutate({
							projectId,
							topicId,
							organizationId,
							postType: v as PostType,
						});
					}
				}}
				className="space-y-4"
			>
				{/* The two rows share ONE rule. Every `TabsList` carries its own
				    `border-b` and is `inline-flex`, so stacking two of them
				    unchanged paints two underlines of DIFFERENT widths — the
				    wrapper owns the rule instead and both lists drop theirs.
				    Row 2's active trigger still tucks onto it via `-mb-px`. */}
				<div className="flex flex-col items-start border-border border-b">
					<TabsList aria-label="Topic review" className="border-b-0">
						{REVIEW_TABS.map((t) => (
							<TabsTrigger key={t.value} value={t.value}>
								{t.label}
							</TabsTrigger>
						))}
					</TabsList>

					<TabsList
						aria-label="Content generation"
						className="flex-wrap border-b-0"
					>
						<GenerationTabTriggers
							model={generationModel}
							postTypes={selectedPostTypes}
						/>
					</TabsList>
				</div>

				{draftsQuery.isError ? (
					<p
						className="text-muted-foreground text-xs"
						data-testid="generation-tabs-degraded"
					>
						We couldn't load this topic's draft state. The content
						tabs still open, but they can't say what has been
						generated yet.
					</p>
				) : null}

				<TabsContent value="summaryQuestions" className="space-y-6">
					{topic.pitch ? (
						<p className="max-w-3xl text-foreground text-sm leading-relaxed">
							{topic.pitch}
						</p>
					) : (
						<EmptyState>This topic has no summary yet.</EmptyState>
					)}
					{/* Content types sits ABOVE the questions and below the
					    summary, because it is the first decision anyone makes
					    about a topic and every question under it is downstream
					    of the answer. It used to live behind a modal on a
					    metadata row two tabs away, and its questions were being
					    asked here as if nobody had decided. */}
					<ContentTypesChecklist
						analysis={analysisDocument}
						selected={selectedPostTypes}
						canEdit={canEdit}
						isPending={postTypesPending}
						createdAt={topic.createdAt}
						onChange={handlePostTypesSubmit}
					/>
					<TopicReadiness
						threads={decisionsQuery.data?.threads ?? []}
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
					{/* The metadata block is `TopicDetails`, the SAME component
					    the Inbox row mounts — not a copy of it. The two views
					    show the same fields, so a second implementation would
					    drift the first time either changed. */}
					<TopicDetails
						topic={topic}
						canEdit={canEdit}
						isPending={
							postTypesPending ||
							urlPending ||
							contributorsPending ||
							assigneesPending
						}
						onEditUrl={() => setUrlOpen(true)}
						onEditPostTypes={() => setPostTypesOpen(true)}
						onEditContributors={() => setContributorsOpen(true)}
						onEditAssignees={() => setAssigneesOpen(true)}
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
						effective={effective}
						aiVersion={analysisQuery.data?.aiVersion ?? null}
						aiCreatedAt={analysisQuery.data?.aiCreatedAt ?? null}
						decisionThreads={decisionsQuery.data?.threads ?? []}
						aiModel={analysisQuery.data?.aiModel ?? null}
						aiPromptSource={
							analysisQuery.data?.aiPromptSource ?? null
						}
						revisionVersion={
							analysisQuery.data?.revisionVersion ?? null
						}
						sourceAnalysisVersion={
							analysisQuery.data?.sourceAnalysisVersion ?? null
						}
						author={analysisQuery.data?.author ?? null}
						revisionCreatedAt={
							analysisQuery.data?.revisionCreatedAt ?? null
						}
					/>
				</TabsContent>

				<TabsContent value="decisionLog">
					<TopicDecisionLog
						threads={decisionsQuery.data?.threads ?? []}
						isLoading={decisionsQuery.isLoading}
					/>
				</TabsContent>
				<GenerationTabPanels
					model={generationModel}
					postTypes={selectedPostTypes}
					projectId={projectId}
					organizationId={organizationId}
					topicId={topicId}
					canEdit={canEdit}
					analysis={analysisDocument}
					drafts={draftsQuery.data?.drafts ?? []}
					workingDrafts={draftsQuery.data?.workingDrafts ?? []}
					decisionThreads={decisionsQuery.data?.threads ?? []}
					isLoading={draftsQuery.isLoading}
				/>
			</Tabs>

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
						recommendations={generationModel.byPostType}
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
					<ContributorsDialog
						topicTitle={topic.title}
						open={contributorsOpen}
						onOpenChange={setContributorsOpen}
						members={members}
						contributors={topic.contributors}
						initialSelected={contributorIds}
						hasOverride={topic.userContributorUserIds !== null}
						viewerUserId={viewerUserId}
						membersPending={membersQuery.isPending}
						membersError={membersQuery.isError}
						onSubmit={handleContributorsSubmit}
						isPending={contributorsPending}
					/>
					<AssigneesDialog
						topicTitle={topic.title}
						open={assigneesOpen}
						onOpenChange={setAssigneesOpen}
						members={members}
						assignees={topic.assignees}
						initialSelected={assigneeIds}
						viewerUserId={viewerUserId}
						membersPending={membersQuery.isPending}
						membersError={membersQuery.isError}
						onSubmit={handleAssigneesSubmit}
						isPending={assigneesPending}
					/>
				</>
			) : null}
		</div>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
