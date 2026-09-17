"use client";

import {
	isUnresolvedDecisionStatus,
	toSingleLineSubject,
} from "@repo/utils/publishing-restrictions";
import { useSession } from "@saas/auth/hooks/use-session";
import { useAiSidebarExpanded } from "@saas/shared/components/copilot/ai-sidebar-layout";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { Loader2Icon, PencilIcon, PlusIcon, SparklesIcon } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssigneesPicker } from "./AssigneesPicker";
import { ContentTypesChecklist } from "./ContentTypesChecklist";
import { ContributorsPicker } from "./ContributorsPicker";
import {
	buildGenerationTabModel,
	GenerationTabPanels,
	GenerationTabTriggers,
} from "./GenerationTabs";
import { PlanningAnalysisTab } from "./PlanningAnalysisTab";
import { PublishTopicDialog } from "./PublishTopicDialog";
import {
	isEmptyAnalysis,
	readPlanningAnalysis,
} from "./planning-analysis-content";
import type { TopicAssistantContext } from "./TopicAssistant";
import { TopicBlockers } from "./TopicBlockers";
import { TopicDecisionLog } from "./TopicDecisionLog";
import {
	MeetingParticipants,
	TopicDetails,
	TopicRankReason,
} from "./TopicDetails";
import {
	countAnswersRecordedAfter,
	TopicQuestionsPanel,
} from "./TopicQuestionsPanel";
import { TopicReadiness } from "./TopicReadiness";
import {
	ALL_POST_TYPES,
	GENERATION_ACTIVE_POST_TYPES,
	type PostType,
	TOPIC_STATUSES,
} from "./topic-shared";

/**
 * The assistant rail, loaded on demand.
 *
 * `dynamic` and not a plain import for two reasons, one of them load-bearing.
 * The bundle reason is the one `StoriesRoadmap` gives for `BacklogChatPanel`:
 * `TopicAssistant` pulls in the whole CopilotKit runtime (react-core +
 * react-ui + its stylesheet), which has no business in this page's initial
 * payload.
 *
 * The other is that a static import puts that stylesheet in the import graph
 * of `publishing-suite/index.ts` — the barrel three Inbox suites import
 * `PublishingSuiteList` from — and CopilotKit's stylesheet drags a transitive
 * katex `.css` that jsdom cannot load. Every one of those suites then fails at
 * import, before a case runs, over a component they never render.
 */
const TopicAssistant = dynamic(
	() => import("./TopicAssistant").then((m) => m.TopicAssistant),
	{ ssr: false },
);

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

/**
 * The reading measure Summary & Questions and the Decision Log share.
 *
 * `4xl` rather than Feature Maturation's `3xl`: this page's questions carry an
 * assignee picker on the same row and the decision log runs two columns, both
 * of which lose their shape at 768px. Wide enough to stay a page, narrow enough
 * that a line of prose does not run the whole of a 1440 window.
 *
 * NOT the Planning & Analysis tab. That tab is an EDITOR over the same kind of
 * document as the Full Specification, and `PlanningAnalysisEditor` dropped its
 * own `PROSE_MEASURE_CLASS` cap for exactly that parity — one of the two
 * reading half as wide as the other is the most visible difference between
 * them. Applying this measure there silently put the cap back one level up,
 * which is the bug: the editor had already given it up.
 *
 * Width there is bounded by the page container instead, which reserves the
 * assistant rail's 28rem when it is docked, so a full-width tab stops at the
 * rail rather than sliding under it.
 */
const REVIEW_MEASURE_CLASS = "mx-auto w-full max-w-4xl";

/** The editor tab's own measure: the page's full content width, uncapped. */
const EDITOR_MEASURE_CLASS = "w-full";

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
	// The metadata editors `TopicDetails` triggers. Held here rather than inside
	// that component because it is the SAME block the Inbox row mounts: giving
	// it its own dialogs would put two of each in the tree whenever both
	// surfaces are open, and would stop the row owning its own pending state.
	//
	// Post types are NOT among them on this page. `+ Add type` in the tab strip
	// opens the checklist in a popover, so the dialog had no trigger left here
	// and the second entry point it created — one popover, one modal, writing
	// through the same handler — is the duplication that removal resolves. The
	// Inbox row still mounts the dialog: it has no tab strip to host the `+`.
	const [postTypesPending, setPostTypesPending] = useState(false);
	const [addTypeOpen, setAddTypeOpen] = useState(false);
	const [urlOpen, setUrlOpen] = useState(false);
	const [urlPending, setUrlPending] = useState(false);
	const [contributorsOpen, setContributorsOpen] = useState(false);
	const [contributorsPending, setContributorsPending] = useState(false);
	const [assigneesOpen, setAssigneesOpen] = useState(false);
	const [assigneesPending, setAssigneesPending] = useState(false);

	/**
	 * A rewrite the assistant produced and the reader accepted, waiting to be
	 * loaded into the Planning & Analysis editor.
	 *
	 * It lives HERE rather than in the assistant because the two are siblings:
	 * the chat rail and the tab that consumes the text have no other common
	 * ancestor. It is cleared the moment that tab takes it, so an accepted
	 * rewrite is applied once and never re-applied by a later re-render.
	 */
	const [assistantProposal, setAssistantProposal] = useState<string | null>(
		null,
	);
	const handleApplyRewrite = useCallback((markdown: string) => {
		setAssistantProposal(markdown);
		// The switch used to be REQUIRED: Radix unmounted the inactive tab, so
		// a proposal accepted from the chat landed on a component that was not
		// in the tree. That tab is force-mounted now, so the proposal would be
		// picked up wherever the reader happens to be — and the switch stays
		// anyway, for the reason that outlived the constraint. They just asked
		// for a rewrite; show them the rewrite rather than leaving it applied
		// on a tab they cannot see.
		setTab("planningAnalysis");
	}, []);
	const handleProposalConsumed = useCallback(
		() => setAssistantProposal(null),
		[],
	);

	/**
	 * Whether the assistant is mid-run, so the Planning & Analysis editor can
	 * lock exactly as it does for a server-side regeneration.
	 *
	 * HERE for the same reason `assistantProposal` is: the chat rail and the
	 * tab that has to react to it are siblings with no other common ancestor.
	 * Threading one more value along the journey that already exists beats a
	 * second channel — and an event bus or a shared module would be worse
	 * still, because importing anything from `TopicAssistant` into the tab
	 * would pull the CopilotKit runtime back into the bundle the dynamic
	 * import below exists to keep it out of.
	 *
	 * `setAssistantRunActive` is passed raw: a `useState` setter is stable, so
	 * the assistant's effect never re-runs on our account. The assistant
	 * guarantees a final `false` on unmount, so this cannot latch true.
	 */
	const [assistantRunActive, setAssistantRunActive] = useState(false);

	// Reserves the width the docked assistant occupies. Read here rather than
	// inside `TopicAssistant` because it is THIS element that has to move.
	// `true`, matching the assistant's own `defaultOpen`: the observer in
	// `useAiSidebarExpanded` self-corrects after mount, but seeding it false
	// while the panel docks open means the page renders one frame at full
	// width and then jumps by 28rem.
	const isAssistantOpen = useAiSidebarExpanded(true);

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
	// re-seeding `ContributorsPicker`'s selection and discarding whatever the
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
	 * Start the first analysis when the page opens, for a topic that never
	 * passed through Selected.
	 *
	 * Selecting a topic starts one server-side now, which is where Andrew
	 * wanted it: "as soon as the user clicks selected ... they don't even have
	 * to open this page". But a topic can be opened without ever being
	 * selected — one created by hand, or one of the sixteen that predate the
	 * feature — and the trigger that used to cover them was on the Planning &
	 * Analysis tab's own mount, which at the time only ran if the reader opened
	 * that tab. The default tab is Summary & Questions, so a reader who never
	 * clicked through to the third tab got an empty questions panel and no
	 * explanation. (That tab is force-mounted now, so its own trigger fires on
	 * page load too — this one is no longer the only cover, but it is still the
	 * one that does not depend on the tab existing.)
	 *
	 * A second caller of the same procedure is safe HERE, unlike the two
	 * Regenerate controls: the server claims the attempt under a partial unique
	 * index and answers `in-progress` to whoever loses, so the two cannot both
	 * run. What they must not do is disagree about whether one is running, and
	 * neither of these renders a disabled state.
	 */
	const autoStarted = useRef(false);
	const startAnalysis = useMutation(
		orpc.projects.publishingSuite.generatePlanningAnalysis.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.getPlanningAnalysis.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			// Silent. Nobody asked for this run, so nobody should be told it
			// failed — the Generate button is still there and says so itself.
			onError: () => {},
		}),
	);
	useEffect(() => {
		if (
			autoStarted.current ||
			!canEdit ||
			analysisQuery.isLoading ||
			latestAttempt !== null ||
			startAnalysis.isPending
		) {
			return;
		}
		autoStarted.current = true;
		startAnalysis.mutate({ projectId, topicId, organizationId });
	}, [
		canEdit,
		analysisQuery.isLoading,
		latestAttempt,
		startAnalysis,
		projectId,
		topicId,
		organizationId,
	]);

	/**
	 * What the Summary & Questions tab is carrying, for its badges.
	 *
	 * Counted from the SAME threads the tab renders, so a badge cannot claim
	 * work the page does not show. `CONTENT_TYPE` rows are excluded for the
	 * reason the questions panel excludes them — they are settings now, and a
	 * legacy one is not something anybody can answer.
	 *
	 * `OPEN` only, for both counts. `POSSIBLY_RESOLVED` is deliberately NOT
	 * counted here, and this is a REVERSAL: the badge used to include it on the
	 * reasoning that "a question a regeneration stopped raising still needs a
	 * person".
	 *
	 * Two things retired that reasoning. Feature Maturation — the feature this
	 * one mirrors, on the same `DecisionStatus` enum — has always grouped
	 * `POSSIBLY_RESOLVED` with `RESOLVED` (`evaluate-ai-readiness.ts`,
	 * `StoryWorkspace.tsx`), and the enum's own comment calls it "dropped from
	 * the active open list". And a soft-closed root does not appear in the
	 * panel's open list at all — it sits collapsed under "Possibly resolved" —
	 * so counting it made the badge promise work the tab does not offer.
	 *
	 * The observed case: a topic whose every live decision was answered still
	 * badged `7`, all seven being rows a since-fixed subject-drift bug had
	 * stranded. Nothing could clear them, so the tab could never reach zero.
	 *
	 * This is the COUNTING half only. `isUnresolvedDecisionStatus` is unchanged
	 * and still admits `POSSIBLY_RESOLVED` for the drafting restrictions
	 * (`generation-tab-state.ts`) and the assistant context below, which stay
	 * conservative on purpose: an unapproved customer name is unapproved
	 * whether or not the newest analysis still asks about it.
	 */
	const openBlockerCount = (decisionsQuery.data?.threads ?? []).filter(
		(thread) =>
			thread.root.kind === "BLOCKER" && thread.root.status === "OPEN",
	).length;
	const openQuestionCount = (decisionsQuery.data?.threads ?? []).filter(
		(thread) =>
			thread.root.kind === "QUESTION" &&
			thread.root.status === "OPEN" &&
			thread.root.decisionKind !== "CONTENT_TYPE",
	).length;

	/**
	 * Answers recorded since the analysis was written, for the notice on
	 * Summary & Questions. Same predicate the Planning & Analysis banner uses —
	 * one function, so the two surfaces cannot disagree about whether the
	 * analysis is stale.
	 */
	const answersBehindAnalysis = countAnswersRecordedAfter(
		analysisQuery.data?.aiCreatedAt ?? null,
		decisionsQuery.data?.threads,
	);

	/**
	 * The OTHER way an analysis goes stale: its source text changed.
	 *
	 * The summary is now editable, and the analysis is derived from it — so an
	 * edit leaves the analysis describing a topic that no longer says what it
	 * said. That is the same staleness an unfolded answer causes and it earns
	 * the same notice; without one the only signal is the author remembering
	 * what they changed.
	 *
	 * A separate boolean rather than something folded into the answer count:
	 * the count is a count, and "1 answer was recorded" is a sentence that must
	 * not start meaning "1 answer, or possibly a summary edit".
	 */
	const analysisWrittenAt = analysisQuery.data?.aiCreatedAt ?? null;
	const summaryEditedAfterAnalysis = (() => {
		const pitchAt = topicQuery.data?.topic?.pitchUpdatedAt;
		if (!pitchAt || analysisWrittenAt === null) {
			return false;
		}
		const edited = new Date(pitchAt).getTime();
		const written = new Date(analysisWrittenAt).getTime();
		return (
			!Number.isNaN(edited) && !Number.isNaN(written) && edited > written
		);
	})();
	const analysisIsBehind =
		answersBehindAnalysis > 0 || summaryEditedAfterAnalysis;

	/**
	 * A run is already in flight, read from the SERVER's row rather than from
	 * any one button's pending state.
	 *
	 * This is what lets a second Regenerate control exist at all: two controls
	 * holding their own `isPending` can disagree about whether a run has
	 * started, but two controls reading one `GENERATING` row cannot.
	 */
	const isGeneratingAnalysis =
		latestAttempt?.status === "GENERATING" && !latestAttempt.isExpired;

	/**
	 * Regenerate, owned at topic level so the banner below can carry the
	 * action rather than point at it.
	 *
	 * The notice used to be a sentence with a link into the Planning &
	 * Analysis tab, because the full banner lived inside that tab and Radix
	 * unmounted an inactive `TabsContent` — so the one person who had just made
	 * the analysis stale, by answering a question, was the one person who could
	 * not see the banner saying so. (That tab is force-mounted now, but the
	 * banner belongs out here regardless: it is about the topic, and the person
	 * it is for is on another tab when it becomes true.) Lifting it out of the tab is what Feature
	 * Maturation does with the same notice, and it is the only way the control
	 * can sit where the work happens.
	 */
	const generateAnalysis = useMutation(
		orpc.projects.publishingSuite.generatePlanningAnalysis.mutationOptions({
			onSuccess: (result: { started: boolean; reason?: string }) => {
				if (!result.started && result.reason === "unavailable") {
					toast.error(
						"Generation is temporarily unavailable. Please try again shortly.",
					);
				}
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.getPlanningAnalysis.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			onError: () => {
				toast.error("Could not start the planning analysis.");
			},
		}),
	);

	/**
	 * What the assistant is told about the topic beside it.
	 *
	 * The open questions are in here on purpose: they are the gaps the analysis
	 * has NOT resolved, and an assistant that rewrites the document without
	 * them writes over the uncertainty instead of around it. CONTENT_TYPE rows
	 * are excluded for the same reason `TopicQuestionsPanel` excludes them —
	 * they are settings now, not questions. Unresolved means `OPEN` or
	 * `POSSIBLY_RESOLVED` (`isUnresolvedDecisionStatus`) — a question a
	 * regeneration stopped raising still needs a person.
	 */
	const assistantContext = useMemo<TopicAssistantContext>(
		() => ({
			title: topicQuery.data?.topic?.title ?? "",
			angle: topicQuery.data?.topic?.angle ?? null,
			pitch: topicQuery.data?.topic?.pitch ?? null,
			status: topicQuery.data?.topic?.status ?? "",
			postTypes: selectedPostTypes,
			openQuestions: (decisionsQuery.data?.threads ?? [])
				.filter(
					(t) =>
						t.root.kind === "QUESTION" &&
						t.root.decisionKind !== "CONTENT_TYPE" &&
						isUnresolvedDecisionStatus(t.root.status),
				)
				// `??` selects on null, not on emptiness, so a whitespace-only
				// subject used to win and reach the assistant as a blank entry.
				// Each candidate is folded before falling back: `subject` first,
				// then `summary` — where `reconcileTopicQuestions` stores the
				// question's text, and the field the page's other readers
				// (`TopicBlockers`, `TopicDecisionLog`) fall back through before
				// `content` — then `content`. An entry is dropped only when all
				// three are blank.
				.map(
					(t) =>
						toSingleLineSubject(t.root.subject ?? "") ||
						toSingleLineSubject(t.root.summary ?? "") ||
						toSingleLineSubject(t.root.content ?? ""),
				)
				.filter((q) => q !== ""),
		}),
		[
			topicQuery.data?.topic?.title,
			topicQuery.data?.topic?.angle,
			topicQuery.data?.topic?.pitch,
			topicQuery.data?.topic?.status,
			selectedPostTypes,
			decisionsQuery.data?.threads,
		],
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
	/**
	 * The topic object a FAILED attempt was made against.
	 *
	 * Releasing `markedRead` alone was not enough to mean what the comment
	 * below claims. This effect also depends on `setReadState.mutate`, and any
	 * extra render that hands it a new function identity re-fires it — against
	 * the same topic, immediately, with no refetch in between. Holding the
	 * attempted topic makes "only a genuine refetch gets to try again" true by
	 * construction rather than by the absence of re-renders.
	 */
	const readFailedFor = useRef<unknown>(null);
	/** What the in-flight attempt was made against, for the handler above. */
	const attemptedFor = useRef<unknown>(null);

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
				readFailedFor.current = attemptedFor.current;
			},
		}),
	);
	useEffect(() => {
		if (
			!topic ||
			topic.isRead ||
			markedRead.current ||
			readFailedFor.current === topic
		) {
			return;
		}
		markedRead.current = true;
		attemptedFor.current = topic;
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

	/**
	 * Edit the SUMMARY — `pitch`, the paragraph under the title and the text
	 * every generation prompt is handed.
	 *
	 * `invalidateTopic` like its neighbours rather than reading a response:
	 * the procedure returns `{ saved: true }`, not the topic.
	 */
	const updateSummary = useMutation(
		orpc.projects.publishingSuite.updateTopicSummary.mutationOptions({
			onSuccess: invalidateTopic,
			onError: () => {
				toast.error("We couldn't save the summary. Please try again.");
			},
		}),
	);

	/**
	 * Save the private notebook. Fired on blur, so a failure must say so — the
	 * person has already looked away from the field by the time it lands.
	 */
	const saveNotes = useMutation(
		orpc.projects.publishingSuite.setTopicNotes.mutationOptions({
			onSuccess: invalidateTopic,
			onError: () => {
				toast.error("We couldn't save your notes. Please try again.");
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
			setAddTypeOpen(false);
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
		<div
			className={cn(
				"space-y-6",
				// The assistant docks as a `position: fixed` 28rem rail from
				// `sm` up, and globals.css cancels CopilotKit's own content
				// margin so each host page reserves that width itself. NOT
				// `AI_SIDEBAR_CONTENT_SHIFT_CLASS`: that is a `right-` utility
				// and means nothing outside the fixed page chrome the document
				// editor shifts with it. This page is normal flow, so it pads.
				isAssistantOpen && "sm:pr-[28rem]",
			)}
		>
			<div className="space-y-3">
				<p className="publishing-label">Publishing topic</p>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
						<h1 className="font-serif font-normal text-3xl leading-tight">
							{topic.title}
						</h1>
						{/* The angle is a LABEL — "Feature release note", "How-to",
						    "Customer story" — and it was rendering as a lone grey
						    sentence under the title, where it read as a one-line
						    description that had been cut off. Same row, pill
						    shape, so it reads as a classification of the title
						    rather than prose about it. */}
						{topic.angle ? (
							<span className="inline-flex w-fit shrink-0 items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-muted-foreground text-xs">
								{topic.angle}
							</span>
						) : null}
					</div>
					{/* The rank reason rides the title row instead of taking a
					    full-width line of its own in the metadata block below.
					    As a left-barred `rule` paragraph in the flow it read as
					    a section opener and cost a whole band of vertical space
					    for four words; beside the status chip it reads as what
					    it is — a note about why this topic surfaced. The block
					    below is told not to render it again
					    (`showRankReason={false}`), the same lift the Inbox row
					    already does. */}
					<div className="flex shrink-0 items-center gap-2">
						<TopicRankReason topic={topic} variant="pill" />
						<span
							className="shrink-0 rounded-full border border-border bg-muted px-3 py-1 text-muted-foreground text-xs"
							data-testid="topic-status"
						>
							{statusLabel}
						</span>
					</div>
				</div>
				{topic.declineReason ? (
					<p className="border-destructive border-l-2 pl-3 text-muted-foreground text-sm">
						{topic.declineReason}
					</p>
				) : null}
				{/* Who was in the room, in the header rather than down in the
				    metadata block — "that kind of stuff feels like it goes in
				    the header somewhere". It is context for the whole topic,
				    not a field you go looking for, and the same component the
				    metadata block uses so the overflow rules cannot diverge.

				    Placement only. Ordering them by who ran the meeting is a
				    different ask, and a dropped one: the transcript row carries
				    `speakerNames` and no organizer. */}
				{topic.meetingSpeakers ? (
					<MeetingParticipants speakers={topic.meetingSpeakers} />
				) : null}
			</div>

			{/* The metadata block is `TopicDetails`, the SAME component
				    the Inbox row mounts — not a copy of it. The two views
				    show the same fields, so a second implementation would
				    drift the first time either changed.

				    WRAPPED, and the wrapper is the fix rather than decoration.
				    `TopicDetails` returns a bare fragment, so its eight-odd
				    conditional children inherit whatever rhythm the mount
				    supplies: the Inbox gives them `space-y-1`, this page's
				    outer column gives them `space-y-6`. At 24px apiece the
				    people rows and the picker row each claimed a band of their
				    own and the header sprawled. Tightening it here changes
				    nothing for the row, and nothing inside the shared
				    component. */}
			<div className="space-y-1.5">
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
					contributorsControl={
						<ContributorsPicker
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
					}
					assigneesControl={
						<AssigneesPicker
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
					}
					showMeetingParticipants={false}
					showEditPostTypes={false}
					showRankReason={false}
					showContributorLabel
				/>
			</div>
			{/* ABOVE the tabs, so it is on screen wherever the person is —
			    including Summary & Questions, which is where answering a
			    question makes it true. The action lives IN it, as Feature
			    Maturation's does: a notice that can only point at a control on
			    another tab is a notice you have to take on trust. */}
			{analysisIsBehind ? (
				<div
					className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/40 bg-highlight/10 px-4 py-2.5 text-foreground text-sm"
					data-testid="analysis-behind-decisions"
				>
					<p>
						{answersBehindAnalysis === 0
							? "The summary changed after the analysis was written"
							: answersBehindAnalysis === 1
								? `1 answer was recorded${summaryEditedAfterAnalysis ? ", and the summary changed," : ""} after the analysis was written`
								: `${answersBehindAnalysis} answers were recorded${summaryEditedAfterAnalysis ? ", and the summary changed," : ""} after the analysis was written`}
						{canEdit
							? " — regenerate to fold it in."
							: " and are not reflected in it yet."}
					</p>
					{canEdit ? (
						<Button
							size="sm"
							className="shrink-0"
							onClick={() =>
								generateAnalysis.mutate({
									projectId,
									topicId,
									organizationId,
								})
							}
							disabled={
								isGeneratingAnalysis ||
								generateAnalysis.isPending
							}
						>
							{isGeneratingAnalysis ||
							generateAnalysis.isPending ? (
								<Loader2Icon
									className="mr-2 size-4 motion-safe:animate-spin"
									aria-hidden="true"
								/>
							) : (
								<SparklesIcon
									className="mr-2 size-4"
									aria-hidden="true"
								/>
							)}
							Regenerate analysis
						</Button>
					) : null}
				</div>
			) : null}
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
								{/* Two counts, and they are different colours
								    because they are different asks. RED is a
								    blocker: something the topic is missing, and
								    somebody has to go and get it. AMBER is an
								    open question: you can answer it here, now.
								    Collapsing them into one number would put
								    the errand and the decision behind the same
								    digit.

								    Only on the tab that holds them, and only
								    when there are any — a zero badge is a
								    permanent mark, and a permanent mark stops
								    being read. */}
								{t.value === "summaryQuestions" &&
								openBlockerCount > 0 ? (
									<span
										aria-label={`${openBlockerCount} blocking ${openBlockerCount === 1 ? "item" : "items"}`}
										className="ml-1.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full bg-destructive px-1.5 py-0 font-bold text-[10px] text-destructive-foreground tabular-nums"
									>
										{openBlockerCount}
									</span>
								) : null}
								{t.value === "summaryQuestions" &&
								openQuestionCount > 0 ? (
									<span
										aria-label={`${openQuestionCount} open ${openQuestionCount === 1 ? "question" : "questions"}`}
										className="ml-1.5 inline-flex min-w-[1.125rem] items-center justify-center rounded-full border border-highlight/60 bg-highlight/20 px-1.5 py-0 font-bold text-[10px] text-foreground tabular-nums"
									>
										{openQuestionCount}
									</span>
								) : null}
							</TabsTrigger>
						))}
					</TabsList>

					<div className="flex flex-wrap items-center">
						<TabsList
							aria-label="Content generation"
							className="flex-wrap border-b-0"
						>
							<GenerationTabTriggers
								model={generationModel}
								postTypes={selectedPostTypes}
							/>
						</TabsList>
						{/* Immediately after the last tab, not pushed to the
						    right edge: the row IS the set of things this topic
						    is producing, and "+" says you can add to it without
						    needing a label. "Edit post types" lived on a
						    metadata row far below and got lost there.

						    A POPOVER carrying the checklist we already built,
						    not a new modal — the modal is what the checklist
						    replaced, and reintroducing one here would walk that
						    back. Same component, same grouping by the
						    analysis's own verdict, and the inline checklist
						    stays on Summary & Questions for anyone who prefers
						    it there. */}
						{canEdit ? (
							<Popover
								open={addTypeOpen}
								onOpenChange={setAddTypeOpen}
							>
								<PopoverTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="ml-1 border border-border border-dashed"
									>
										<PlusIcon
											className="mr-1 size-3.5"
											aria-hidden="true"
										/>
										Add type
									</Button>
								</PopoverTrigger>
								<PopoverContent
									align="start"
									className="w-[min(28rem,calc(100vw-2rem))] p-3"
								>
									<ContentTypesChecklist
										analysis={analysisDocument}
										selected={selectedPostTypes}
										canEdit={canEdit}
										isPending={postTypesPending}
										createdAt={topic.createdAt}
										alwaysOpen
										onChange={handlePostTypesSubmit}
									/>
								</PopoverContent>
							</Popover>
						) : null}
					</div>
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

				{/* A READING MEASURE on the review tabs, and only there.
				    
				    The page had no max-width anywhere -- one paragraph was
				    capped and everything else ran the full width of a 1440
				    window, which is what made the questions hard to scan
				    beside Feature Maturation, whose whole Summary & Questions
				    panel is `mx-auto max-w-3xl`. The generation tabs stay
				    full-bleed deliberately: three candidate columns need the
				    room, and a cap there would squeeze them back into one. */}
				<TabsContent
					value="summaryQuestions"
					className={cn(REVIEW_MEASURE_CLASS, "space-y-6")}
				>
					<TopicSummary
						pitch={topic.pitch}
						canEdit={canEdit}
						isSaving={updateSummary.isPending}
						onSave={(pitch) =>
							updateSummary.mutateAsync({
								projectId,
								topicId,
								organizationId,
								pitch,
							})
						}
					/>
					{/* No content-types list here. It used to render in full
					    above the questions, which put the same checklist on
					    screen twice: `+ Add type` in the tab strip opens the
					    very same component, one row up and already in view.
					    The tab strip is the right home — the types ARE the
					    tabs, so the control that changes them belongs beside
					    them rather than in a second copy further down. */}
					{/* ABOVE the readiness bar and the questions: it is the
					    shorter list and the one that decides whether the other
					    is worth working through. Answering five questions for a
					    case study nobody can approve is wasted effort. */}
					<TopicBlockers
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						threads={decisionsQuery.data?.threads ?? []}
						canEdit={canEdit}
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
						isFetching={decisionsQuery.isFetching}
						analysisFailed={latestAttempt?.status === "FAILED"}
						isGeneratingAnalysis={isGeneratingAnalysis}
						threads={decisionsQuery.data?.threads ?? []}
						members={members}
					/>
					<TopicNotes
						notes={topic.notes}
						canEdit={canEdit}
						onSave={(notes) =>
							saveNotes.mutate({
								projectId,
								topicId,
								organizationId,
								notes,
							})
						}
					/>
				</TabsContent>

				{/* FORCE-MOUNTED, and only this tab. Radix unmounts inactive
				    tab content, which meant a person who typed into the
				    analysis and then looked at Decision Log came back to an
				    empty editor — their words were gone with the component.
				    Staying in the DOM (hidden, not unmounted) is what makes
				    the editor state survive; nothing is saved and nothing is
				    asked, because nothing was lost.

				    Feature Maturation gets this for free by autosaving on a
				    debounce and flushing on unmount. That route is closed
				    here: #1929 bought the rule that the author's Save is the
				    only writer, after an autosave raced an in-flight agent
				    and overwrote the server with pre-answer text.

				    Only this tab, because only this tab holds unsaved work.
				    The other two render server state and cost a mount they do
				    not need. Safe to keep mounted: `PlanningAnalysisTab` runs
				    no queries of its own — every value it renders arrives as a
				    prop from this component — and neither it, the editor, nor
				    `DocumentTocRail` measures the DOM, so being display:none
				    costs it nothing. `EDITOR_MEASURE_CLASS` is `w-full`, with
				    no `display` of its own to fight the rule below.

				    `forceMount` ALONE IS NOT ENOUGH, and the failure is
				    visible rather than subtle: Radix hands a force-mounted
				    panel `data-state="inactive"` and NO `hidden` attribute,
				    leaving the hiding to the caller — so without the prop
				    below both panels render stacked on the page.

				    The `hidden` ATTRIBUTE rather than a `data-[state=...]`
				    class, because the attribute needs no stylesheet to mean
				    something: it hides the panel under Tailwind's preflight
				    in the browser AND takes it out of the accessibility tree
				    in jsdom, where a utility class is an inert string and the
				    panel would otherwise still answer `getByRole("tabpanel")`.
				    `display: none` is what is wanted either way — it keeps the
				    component mounted with its React state intact, which is the
				    whole point, while costing it no layout. */}
				<TabsContent
					value="planningAnalysis"
					className={EDITOR_MEASURE_CLASS}
					forceMount
					hidden={activeTab !== "planningAnalysis"}
				>
					<PlanningAnalysisTab
						generateActionIsElsewhere={analysisIsBehind}
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						canEdit={canEdit}
						isLoading={analysisQuery.isLoading}
						latestAttempt={latestAttempt}
						effective={effective}
						aiVersion={analysisQuery.data?.aiVersion ?? null}
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
						assistantProposal={assistantProposal}
						onAssistantProposalConsumed={handleProposalConsumed}
						assistantRunActive={assistantRunActive}
					/>
				</TabsContent>

				<TabsContent
					value="decisionLog"
					className={REVIEW_MEASURE_CLASS}
				>
					<TopicDecisionLog
						threads={decisionsQuery.data?.threads ?? []}
						isLoading={decisionsQuery.isLoading}
						projectId={projectId}
						topicId={topicId}
						organizationId={organizationId}
						canEdit={canEdit}
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
					onReviewQuestions={() => setTab("summaryQuestions")}
					isLoading={draftsQuery.isLoading}
				/>
			</Tabs>

			{/* The editors behind `TopicDetails`' two affordances. Mounted only
			    for an editor: the controls that open them are themselves
			    `canEdit`-gated (PR2), so rendering the dialogs for a reader
			    would put unreachable write UI in the tree. */}
			{canEdit ? (
				<>
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

			{/* Mounted LAST and for everyone, reader included: the chat is a
			    read affordance in its own right, and the one thing it can
			    write — the accepted rewrite — is gated on `canEdit` inside.
			    Last in the tree because it introduces the CopilotKit provider,
			    and the rest of this page must render whether or not that
			    starts. */}
			<TopicAssistant
				projectId={projectId}
				organizationId={organizationId}
				context={assistantContext}
				analysisMarkdown={effective?.prose ?? null}
				canEdit={canEdit}
				onApplyRewrite={handleApplyRewrite}
				onRunStateChange={setAssistantRunActive}
			/>
		</div>
	);
}

/**
 * The topic's summary, editable in place.
 *
 * Inline rather than a dialog: it is one paragraph, it is the first thing on
 * the tab, and it is the text every generation prompt is handed — so the cost
 * of correcting it has to be a click, not a modal.
 *
 * The editor closes only AFTER the write lands, the contract the post-types
 * and URL dialogs on this page already keep: a failed save that closed over
 * the field would discard the only copy of what the person typed.
 */
function TopicSummary({
	pitch,
	canEdit,
	isSaving,
	onSave,
}: {
	pitch: string | null;
	canEdit: boolean;
	isSaving: boolean;
	onSave: (pitch: string | null) => Promise<unknown>;
}) {
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");

	if (isEditing) {
		const commit = async () => {
			const trimmed = draft.trim();
			try {
				// The RAW text, or `null` to clear. The column is not trimmed
				// server-side, so an all-whitespace draft sent as-is would
				// persist as a summary made of spaces.
				await onSave(trimmed.length > 0 ? draft : null);
				setIsEditing(false);
			} catch {
				// The toast on the mutation says what happened; the draft stays
				// on screen because it is the only copy of it.
			}
		};
		return (
			<div className="max-w-3xl space-y-2">
				<Textarea
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					rows={3}
					maxLength={500}
					aria-label="Topic summary"
					placeholder="What this topic is about, in a paragraph."
					disabled={isSaving}
				/>
				<div className="flex items-center justify-end gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={isSaving}
						onClick={() => setIsEditing(false)}
					>
						Cancel
					</Button>
					<Button
						type="button"
						size="sm"
						disabled={isSaving}
						onClick={commit}
					>
						Save summary
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="max-w-3xl space-y-2">
			{pitch ? (
				<p className="text-foreground text-sm leading-relaxed">
					{pitch}
				</p>
			) : (
				<EmptyState>This topic has no summary yet.</EmptyState>
			)}
			{canEdit ? (
				<div className="flex justify-end">
					{/* The module's edit idiom — the same outline button with a
					    leading pencil the question cards use. A bare text
					    button here was a second pattern for the same act. The
					    empty case takes a plus instead: there is nothing to
					    edit yet. */}
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							setDraft(pitch ?? "");
							setIsEditing(true);
						}}
					>
						{pitch ? (
							<PencilIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
						) : (
							<PlusIcon
								className="mr-1.5 size-3.5"
								aria-hidden="true"
							/>
						)}
						{pitch ? "Edit summary" : "Add a summary"}
					</Button>
				</div>
			) : null}
		</div>
	);
}

/**
 * The private notebook, and the one field on a topic the AI never touches.
 *
 * The same shape as Feature Maturation's notes section, down to saving on
 * blur: a notebook with a Save button is one people forget to press. The hint
 * is a promise, not a description — `notes` must stay out of every prompt
 * builder and every AI-facing context on this page, including the assistant
 * rail's `context` prop.
 *
 * The local mirror is re-seeded only when the SERVER value actually changes,
 * so a refetch landing mid-sentence cannot clobber what is being typed.
 */
function TopicNotes({
	notes,
	canEdit,
	onSave,
}: {
	notes: string | null;
	canEdit: boolean;
	onSave: (notes: string) => void;
}) {
	const [draft, setDraft] = useState(notes ?? "");
	const [lastSaved, setLastSaved] = useState(notes ?? "");

	useEffect(() => {
		const incoming = notes ?? "";
		if (incoming !== lastSaved) {
			setLastSaved(incoming);
			setDraft(incoming);
		}
	}, [notes, lastSaved]);

	if (!canEdit) {
		// Writing needs the same permission every other edit on this page does,
		// so a reader gets the text without a field that would 403 on blur.
		return notes ? (
			<section aria-labelledby="topic-notes-heading">
				<h3 id="topic-notes-heading" className="publishing-label">
					Notes
				</h3>
				<p className="mt-3 whitespace-pre-wrap text-foreground text-sm leading-relaxed">
					{notes}
				</p>
			</section>
		) : null;
	}

	return (
		<section aria-labelledby="topic-notes-heading">
			<h3 id="topic-notes-heading" className="publishing-label">
				Notes
			</h3>
			<p className="mt-1 text-muted-foreground text-xs">
				Your private notebook for this topic. Jot down context, open
				thoughts, or reminders — the AI never reads or edits this.
			</p>
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => {
					// Nothing typed, nothing sent — a blur that changed nothing
					// must not write. The RAW text goes up: the procedure trims
					// only to TEST emptiness and stores what it was given, so a
					// client-side trim would eat the trailing blank line every
					// notebook grows.
					if (draft !== lastSaved) {
						setLastSaved(draft);
						onSave(draft);
					}
				}}
				placeholder="Add your own notes about this topic…"
				aria-label="Notes"
				className="mt-3 min-h-[160px] resize-y"
			/>
		</section>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
