"use client";

import { currentAnswerReply } from "@repo/utils/publishing-restrictions";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, PencilIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
	type AssignableMember,
	QuestionAssigneePicker,
} from "../stories/maturation/QuestionAssigneePicker";
import {
	mentionedMemberIds,
	QuestionMentionTextarea,
} from "../stories/maturation/QuestionMentionTextarea";
import { SuggestedAnswerOptions } from "../stories/maturation/SuggestedAnswerOptions";
import { useScrollToQuestion } from "../stories/maturation/use-scroll-to-question";
import type { ProjectMember } from "./topic-shared";

/**
 * A turn in a topic's decision thread, as `listTopicDecisions` returns it.
 *
 * Declared locally rather than imported from `@repo/database` or the API
 * package, mirroring the convention `maturation/types.ts` documents for the
 * same reason: a "use client" module may import a value from `@repo/database`
 * never — and the shape is kept in lock-step with `TopicDecisionEntrySchema`
 * (`packages/api/.../publishing-suite/topic-decisions.ts`), whose Zod
 * `.output()` is the runtime source of truth.
 */
interface TopicDecisionEntry {
	id: string;
	parentId: string | null;
	/** BLOCKER is a thing the topic is MISSING — see `TopicBlockers`. It rides
	 *  the same read; every consumer here filters to QUESTION. */
	kind: "QUESTION" | "AI_UPDATE" | "BLOCKER";
	status: string;
	authorType: "USER" | "AGENT";
	authorUserId: string | null;
	/** Who decided, when a person did. Null for an AI turn, and null for an
	 *  author whose account has since been removed. */
	author?: { id: string; name: string; image: string | null } | null;
	questionId: string | null;
	decisionKind: string | null;
	subject: string | null;
	summary: string | null;
	content: string | null;
	recommendedResponse: string | null;
	/** Several answers to choose between; absent on every pre-existing row. */
	answerOptions?: { text: string; justification: string }[] | null;
	/** Who the question is waiting on. Empty, never absent — see the schema. */
	assignees: { assigneeUserId: string; assignedByUserId: string }[];
	whyItMatters: string | null;
	answerSource: string | null;
	analysisVersion: number | null;
	createdAt: string | Date;
}

export interface TopicDecisionThread {
	root: TopicDecisionEntry;
	replies: TopicDecisionEntry[];
}

type AnswerSource = "AI_SUGGESTED" | "AI_EDITED" | "MANUAL";

/**
 * The words around a question's suggested answers.
 *
 * Hardcoded English, as the rest of this surface still is — Feature Maturation
 * passes the same shape out of `maturation.summaryQuestions.*`. When this suite
 * is translated, only this constant moves.
 */
const SUGGESTED_ANSWER_LABELS = {
	heading: "Suggested answers",
	typeYourOwn: "Type your own",
	editAria: (text: string) => `Edit "${text}" before answering`,
	editTooltip: "Edit",
} as const;

type Props = {
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit: boolean;
	isLoading?: boolean;
	/**
	 * The decision list is being fetched. True while a cached list is on screen
	 * and a fresher one is on its way: a `#q-<id>` link's arrival is done only
	 * once a list with no fetch in flight has been seen, so a cached list can
	 * still open a group before then.
	 */
	isFetching?: boolean;
	/** The latest analysis attempt is FAILED — an empty list means "we could
	 * not ask", not "there was nothing to ask". */
	analysisFailed?: boolean;
	/** A run is in flight — an empty list means "not yet", not "nothing to
	 * ask", and the reader is one poll away from a list. */
	isGeneratingAnalysis?: boolean;
	threads: TopicDecisionThread[];
	/**
	 * The project's members, for the per-question assignee picker.
	 *
	 * Passed down rather than queried here because the page already holds this
	 * list for its two topic-level pickers, and a third copy of the same query
	 * would be a third thing that can be loading while the other two are not.
	 */
	members?: readonly ProjectMember[];
};

/**
 * Amending an answer, for every surface that offers it.
 *
 * Two surfaces do: Summary & Questions, where an answer is given, and the
 * Decision Log, which is where you READ a decision and therefore where you
 * notice it is wrong — the same placement Feature Maturation uses. Both drive
 * this one hook rather than each holding a mutation, so the stale handling,
 * the toasts and the invalidation cannot drift apart between the two tabs.
 *
 * A SEPARATE procedure from `answerTopicQuestion`: that one refuses an
 * already-settled root on purpose, and the refusal is what keeps a
 * double-submit from minting two replies for one act. Amending appends a
 * superseding turn instead, so the question keeps its history.
 */
export function useAmendAnswer({
	projectId,
	topicId,
	organizationId,
}: {
	projectId: string;
	topicId: string;
	organizationId: string | null;
}) {
	const queryClient = useQueryClient();
	const amend = useMutation(
		orpc.projects.publishingSuite.amendTopicQuestion.mutationOptions({
			onSuccess: (result) => {
				if (result.status === "stale") {
					// Someone else amended first. The refetch below replaces the
					// text on screen, so the toast only has to explain why the
					// words the reader just typed are not the ones they see.
					toast.warning(
						"Someone else changed this answer first. Your edit was not saved — the current answer is shown below.",
					);
				}
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			onError: () => {
				toast.error("Could not save your answer. Please try again.");
			},
		}),
	);

	/**
	 * Returns the outcome rather than firing and forgetting, because the card
	 * has to decide whether to close its editor on it. A `stale` amendment is
	 * REFUSED — the draft in that textarea is then the only copy of what the
	 * person typed, and closing on submit would destroy it while the toast told
	 * them it had not been saved.
	 */
	const submitAmendment = async (
		thread: TopicDecisionThread,
		supersedesId: string,
		text: string,
	): Promise<{ status: string } | undefined> => {
		const questionId = thread.root.questionId;
		const trimmed = text.trim();
		if (!questionId || trimmed.length === 0) {
			return undefined;
		}
		return amend.mutateAsync({
			projectId,
			topicId,
			organizationId,
			questionId,
			supersedesId,
			answer: trimmed,
			// MANUAL, always, and this is a measurement decision rather than a
			// default. `answerSource` counts recommendation ACCEPTANCE. The
			// amend editor is seeded with the answer already on record, never
			// with `recommendedResponse`, so nothing typed here is an act of
			// taking the AI's wording: re-typing your own text is MANUAL, and
			// so is replacing an AI answer with your own. An amendment that
			// happened to land on the recommendation's exact words still was
			// not reached by accepting it.
			answerSource: "MANUAL",
		});
	};

	return { submitAmendment, isAmending: amend.isPending };
}

/**
 * What each question is ABOUT, for grouping.
 *
 * `decisionKind` has been stored on every root since the column was added, and
 * its own doc-comment says grouping was the point: it is kept on the row rather
 * than re-read from the analysis precisely so a question answered against
 * version 1 still renders its own grouping after version 2 supersedes that
 * analysis. Nothing grouped by it until now -- eleven readers, all of them
 * filtering or labelling.
 *
 * These are RISK categories, not work areas. Feature Maturation groups by a
 * subject taxonomy ("Scope & Requirements", "UX & Design"); a publishing review
 * is triage of what is blocking a draft, so "Asset approval" and "Authorship"
 * are the honest headings. Matching FMv2's wording would need a second
 * classifier field and a prompt change.
 */
const DECISION_KIND_LABELS: Record<string, string> = {
	ASSET_APPROVAL: "Asset approval",
	AUDIENCE_SCOPE: "Audience and scope",
	AUTHORSHIP: "Authorship",
	CLAIM_STRENGTH: "Claim strength",
	CODEBASE_DETAIL: "Codebase detail",
	CUSTOMER_NAME: "Customer name",
	INTERNAL_UI: "Internal UI",
	METRICS_APPROVAL: "Metrics approval",
	VIDEO_WALKTHROUGH: "Video walkthrough",
};

/** Unknown and absent kinds land here, and it sorts last. */
const OTHER_GROUP = "Other";

function groupByDecisionKind(
	threads: TopicDecisionThread[],
): { label: string; threads: TopicDecisionThread[] }[] {
	const byLabel = new Map<string, TopicDecisionThread[]>();
	for (const thread of threads) {
		const kind = thread.root.decisionKind ?? "";
		const label = DECISION_KIND_LABELS[kind] ?? OTHER_GROUP;
		const bucket = byLabel.get(label);
		if (bucket) {
			bucket.push(thread);
		} else {
			byLabel.set(label, [thread]);
		}
	}
	return [...byLabel.entries()]
		.map(([label, group]) => ({ label, threads: group }))
		.sort((a, b) => {
			if (a.label === OTHER_GROUP) {
				return 1;
			}
			if (b.label === OTHER_GROUP) {
				return -1;
			}
			return a.label.localeCompare(b.label);
		});
}

/**
 * Suppress grouping that would not help.
 *
 * One group is not a grouping -- it is a second heading saying what the first
 * already said. `SummaryQuestionsPanel` draws the same line for the same
 * reason, suppressing when everything lands in one bucket. Six questions across
 * five categories is five headings and no grouping either, so a group has to
 * earn its heading by holding more than one.
 */
function worthGrouping(
	groups: { label: string; threads: TopicDecisionThread[] }[],
): boolean {
	return (
		groups.length > 1 && groups.some((group) => group.threads.length > 1)
	);
}

/**
 * The Summary & Questions tab's questions, and the controls to answer them
 * (Publishing Suite Phase 2A-3, Fizzy #1851).
 *
 * The topic's decision-thread ROWS — `threads` — are the source of truth for
 * what renders here, not the planning analysis' own JSON blob that 2A-2's
 * `readPlanningQuestions` reads. Only a row carries a status and an answer,
 * and reconciliation (`reconcileTopicQuestions`) is what keeps a row's
 * identity stable across regenerations; a blob re-read fresh on every
 * analysis has no such continuity. The blob stays the analysis's own record
 * of what it raised — it is not read for display again, and this file is
 * deliberately the only question renderer left.
 *
 * This tab is the WORKLIST. What is still open renders in full; a settled
 * question collapses behind a count, because the open list is what anyone
 * comes here to work and a topic accumulates answers without ever shedding
 * them. The full record of a decision — its earlier answers and its
 * attribution — is the Decision Log's job either way; what stays here is the
 * fast route from "I just answered that" to amending it. The notes asked on a
 * question render with the question wherever the question renders.
 *
 * `POSSIBLY_RESOLVED` roots — soft-closed by reconciliation rather than
 * settled by anyone — render in their own group, collapsed behind a toggle
 * (mirroring `SummaryQuestionsPanel`'s `showPossiblyResolved`, IN4).
 *
 * They get BOTH affordances, which is the one place this panel is richer than
 * its sibling. `answerTopicQuestion` deliberately keeps a soft-closed root
 * answerable — it was set aside because a regeneration stopped raising it, not
 * settled by anyone — so the group keeps the full `QuestionCard` controls. It
 * now also carries Restore, which it did not: the panel said these "can still
 * be answered" while offering no way to put one back on the list that gets
 * worked through, so the only route back was another regeneration happening to
 * raise it again. `SummaryQuestionsPanel` has had that lever since #5.
 */
export function TopicQuestionsPanel({
	projectId,
	topicId,
	organizationId,
	canEdit,
	isLoading = false,
	isFetching = false,
	analysisFailed = false,
	isGeneratingAnalysis = false,
	threads,
	members = [],
}: Props) {
	const queryClient = useQueryClient();
	const [showAnswered, setShowAnswered] = useState(false);
	const [showPossiblyResolved, setShowPossiblyResolved] = useState(false);
	// The picker's own search box. Filtered here rather than on the server —
	// unlike Feature Maturation, this surface already holds the whole member
	// list for the topic's other two pickers, so a round trip per keystroke
	// would buy nothing.
	const [memberQuery, setMemberQuery] = useState("");

	// Land a notification ON its question rather than at the top of the topic.
	// Shares the maturation reader, and so the `#q-<rootId>` fragment
	// `publishingQuestionAssigned` writes, rather than inventing a second
	// anchor convention for the same act.
	useScrollToQuestion(!isLoading);

	/**
	 * Open the collapsed group that holds the linked question — once, on
	 * arrival.
	 *
	 * Answered and Possibly resolved start collapsed, so a card in either is not
	 * in the page and the scroll above finds nothing. This opens the group the
	 * linked question is in, and never closes one, for the list that arrives: a
	 * cached list shown while a refetch is in flight can open a group, the fresh
	 * list opens the real one. The arrival is DONE for that fragment only once a
	 * list that actually CONTAINED the linked question has been seen while
	 * nothing was in flight — not merely once nothing is in flight. A request
	 * that exhausted its retries reaches this effect as an empty list with
	 * `isFetching` already false; finding no linked thread in it leaves the
	 * arrival open, so the next list a successful refetch delivers still gets a
	 * chance to open the group. Nothing after a real arrival opens anything —
	 * answering the linked question, a later refetch or a window-focus refetch
	 * leaves the groups as the person set them. The tab remounts this panel, so
	 * coming back to it with the fragment still in the URL is a new arrival.
	 *
	 * Declared before the loading return so the hook order never changes. Keyed
	 * on `threads` as well as the two flags, because TanStack Query reports
	 * `isLoading` false whenever a cached list exists. The fragment check is
	 * `useScrollToQuestion`'s, so the two agree on what names a question.
	 */
	const arrival = useRef({ hash: "", done: false });
	useEffect(() => {
		if (isLoading || typeof window === "undefined") {
			return;
		}
		const hash = window.location.hash;
		const id = hash.slice(3);
		if (!hash.startsWith("#q-") || !/^[0-9a-z_-]+$/i.test(id)) {
			return;
		}
		if (arrival.current.hash !== hash) {
			arrival.current = { hash, done: false };
		}
		if (arrival.current.done) {
			return;
		}
		// This panel's own question filter, so a root it does not render never
		// opens a group.
		const linked = threads.find(
			(t) =>
				t.root.id === id &&
				t.root.kind === "QUESTION" &&
				t.root.decisionKind !== "CONTENT_TYPE",
		);
		if (linked?.root.status === "RESOLVED") {
			setShowAnswered(true);
		} else if (linked?.root.status === "POSSIBLY_RESOLVED") {
			setShowPossiblyResolved(true);
		}
		if (linked && !isFetching) {
			arrival.current.done = true;
		}
	}, [isLoading, isFetching, threads]);

	const assignableMembers = useMemo<AssignableMember[]>(() => {
		const rows = members.map((m) => ({
			id: m.userId,
			name: m.user.name ?? null,
			email: m.user.email ?? null,
			avatarUrl: m.user.image ?? null,
		}));
		const needle = memberQuery.trim().toLowerCase();
		return needle === ""
			? rows
			: rows.filter((row) =>
					`${row.name ?? ""} ${row.email ?? ""}`
						.toLowerCase()
						.includes(needle),
				);
	}, [members, memberQuery]);

	const answer = useMutation(
		orpc.projects.publishingSuite.answerTopicQuestion.mutationOptions({
			onSuccess: (result) => {
				if (result.status === "question_changed") {
					// Nothing was recorded: a newer analysis rewrote this question
					// after the member started writing. The refetch below puts the
					// new wording on screen, and the card keeps the draft.
					toast.error(
						"A newer analysis changed this question. Read it again, then save your answer.",
					);
				}
				// One invalidation, both this panel and the Decision Log — which
				// reads the same query — update from a single refetch.
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			onError: () => {
				// A 403, the NOT_FOUND `answerTopicQuestion` throws for a stale
				// question, or a dropped connection must not leave the button
				// re-enabling with nothing said — the same toast shape
				// `PlanningAnalysisTab` uses for its own mutation failures.
				toast.error("Could not save your answer. Please try again.");
			},
		}),
	);

	/**
	 * Who a question is waiting on (#1851) — the routing Feature Maturation
	 * already has, over a publishing question.
	 *
	 * SET SEMANTICS: the picker submits the COMPLETE list every time, so
	 * assigning, re-assigning and clearing are one call. It NEVER answers
	 * anything — the root keeps its status, which is what separates asking
	 * somebody from settling the question yourself.
	 *
	 * `variables` is read in `isPending` below so only the card being saved
	 * disables its picker; a bare `assign.isPending` would freeze every
	 * question's picker on the page while one of them wrote.
	 */
	/**
	 * Bring a soft-closed question back onto the list that gets answered.
	 *
	 * The panel already told the reader these "can still be answered" and gave
	 * them nothing to act on: a regeneration had set the root aside, and only
	 * another regeneration could undo it. Feature Maturation has had this since
	 * #5. The transition is one-way (`POSSIBLY_RESOLVED -> OPEN`) and nothing is
	 * deleted either way, so restoring is always safe to undo by re-answering.
	 */
	const restore = useMutation(
		orpc.projects.publishingSuite.restoreQuestion.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			onError: () => {
				toast.error(
					"Could not restore that question. Please try again.",
				);
				// A refused restore usually means the question is no longer set
				// aside: somebody answered it first, and the server's claim on
				// POSSIBLY_RESOLVED lost. Refetching moves the card to the group
				// it is really in instead of offering Restore on it again.
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
		}),
	);

	const assign = useMutation(
		orpc.projects.publishingSuite.setQuestionAssignees.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey:
						orpc.projects.publishingSuite.listTopicDecisions.queryKey(
							{ input: { projectId, topicId, organizationId } },
						),
				});
			},
			onError: () => {
				toast.error(
					"Could not change who this question is assigned to. Please try again.",
				);
			},
		}),
	);

	/**
	 * Correcting a settled answer (#1851, review follow-up) — the affordance
	 * Feature Maturation's Decision Log already has.
	 *
	 * A SEPARATE mutation, not a second call to `answerTopicQuestion`: that one
	 * refuses an already-settled root on purpose, and the refusal is what keeps
	 * a double-submit from minting two replies for one act. Amending appends a
	 * superseding turn instead, so the question keeps its history.
	 */
	const { submitAmendment, isAmending } = useAmendAnswer({
		projectId,
		topicId,
		organizationId,
	});

	/**
	 * Save an answer with the analysis version the member saw (Fizzy #1988).
	 *
	 * `onQuestionChanged` is the card's own: it runs, with the version this
	 * request SENT, when the server refuses the answer because a newer analysis
	 * rewrote the question. Per call rather than on the mutation because only
	 * the card knows what it captured. TanStack Query runs a per-call callback
	 * only for the latest `mutate` of this mutation and only while the panel is
	 * mounted; a refusal it misses leaves that card's capture in place, and the
	 * next submit is refused again — the same toast, nothing written.
	 */
	const submitAnswer = (
		thread: TopicDecisionThread,
		text: string,
		answerSource: AnswerSource,
		expectedAnalysisVersion: number | null,
		onQuestionChanged: (refusedVersion: number | null) => void,
	) => {
		const questionId = thread.root.questionId;
		const trimmed = text.trim();
		if (!questionId || trimmed.length === 0) {
			return;
		}
		answer.mutate(
			{
				projectId,
				topicId,
				organizationId,
				questionId,
				answer: trimmed,
				answerSource,
				expectedAnalysisVersion,
			},
			{
				onSuccess: (result, variables) => {
					if (result.status === "question_changed") {
						onQuestionChanged(
							variables.expectedAnalysisVersion ?? null,
						);
					}
				},
			},
		);
	};

	if (isLoading) {
		return (
			<div
				data-testid="topic-questions-loading"
				className="space-y-3"
				aria-busy="true"
			>
				<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
				<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
			</div>
		);
	}

	/**
	 * `CONTENT_TYPE` is excluded: it is the content-types checklist now, not a
	 * question.
	 *
	 * The generator stopped minting these, but topics created before that still
	 * carry them — and leaving them here would ask for a decision the checklist
	 * directly above already shows, in the exact "should we produce a LinkedIn
	 * Post?" wording the owner objected to. Filtered rather than migrated: the
	 * rows stay in the Decision Log, where an answer someone actually gave is
	 * still part of the record.
	 */
	const questions = threads.filter(
		(t) =>
			t.root.kind === "QUESTION" &&
			t.root.decisionKind !== "CONTENT_TYPE",
	);
	const open = questions.filter((t) => t.root.status === "OPEN");
	const resolved = questions.filter((t) => t.root.status === "RESOLVED");
	const possiblyResolved = questions.filter(
		(t) => t.root.status === "POSSIBLY_RESOLVED",
	);
	const openGroups = groupByDecisionKind(open);
	const isGrouped = worthGrouping(openGroups);

	if (questions.length === 0) {
		// A run in flight is not a topic that raised nothing: the questions
		// land WITH the analysis, so this reader is one poll away from a list
		// and the flat empty line below tells them the opposite.
		if (isGeneratingAnalysis && !analysisFailed) {
			return (
				<div
					data-testid="topic-questions-generating"
					className="space-y-3"
					aria-busy="true"
				>
					<p className="text-muted-foreground text-sm">
						Generating the planning analysis. This usually takes a
						minute or two.
					</p>
					<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
					<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
				</div>
			);
		}
		return (
			<EmptyState>
				{analysisFailed
					? "The planning analysis could not be generated, so no questions were raised."
					: "No open questions yet. They arrive with the planning analysis."}
			</EmptyState>
		);
	}

	return (
		<section className="space-y-5">
			{open.length > 0 ? (
				<div className="space-y-3">
					<h3 className="publishing-label">Open questions</h3>
					{openGroups.map((group) => (
						<div key={group.label} className="space-y-3">
							{/* A SUB-heading: the same editorial idiom as
							    `publishing-label` without its red bar, which
							    belongs to the section above and would read as a
							    second section if repeated here. */}
							{isGrouped ? (
								<h4 className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.16em]">
									{group.label}
								</h4>
							) : null}
							<ul className="space-y-3">
								{group.threads.map((thread) => (
									<QuestionCard
										key={thread.root.id}
										thread={thread}
										canEdit={canEdit}
										isSubmitting={answer.isPending}
										onAnswer={(
											text,
											source,
											version,
											onQuestionChanged,
										) =>
											submitAnswer(
												thread,
												text,
												source,
												version,
												onQuestionChanged,
											)
										}
										members={assignableMembers}
										onMemberQueryChange={setMemberQuery}
										onAssign={(assigneeUserIds, note) =>
											assign.mutate({
												projectId,
												topicId,
												organizationId,
												questionRootId: thread.root.id,
												assigneeUserIds,
												note,
											})
										}
										isAssignSaving={
											assign.isPending &&
											assign.variables?.questionRootId ===
												thread.root.id
										}
									/>
								))}
							</ul>
						</div>
					))}
				</div>
			) : (
				// Not `null`: the readiness bar directly above says the topic is
				// clear, and a blank strip under it reads as a section that
				// failed to load rather than as one with nothing left in it.
				<EmptyState>
					No open questions right now. New questions and gaps will
					surface here as the topic is reviewed.
				</EmptyState>
			)}

			{resolved.length > 0 ? (
				<section aria-label="Answered questions">
					<button
						type="button"
						onClick={() => setShowAnswered((open) => !open)}
						aria-expanded={showAnswered}
						aria-controls="questions-answered"
						className="flex w-full items-center gap-2 py-1 text-left"
					>
						<ChevronDownIcon
							className={cn(
								"size-3.5 shrink-0 text-muted-foreground transition-transform",
								!showAnswered && "-rotate-90",
							)}
							aria-hidden="true"
						/>
						<h3 className="publishing-label">Answered</h3>
						<span className="text-[11px] text-muted-foreground/70">
							{resolved.length}
						</span>
					</button>
					{showAnswered ? (
						<ul id="questions-answered" className="mt-2 space-y-3">
							{resolved.map((thread) => (
								<AnsweredCard
									key={thread.root.id}
									thread={thread}
									canEdit={canEdit}
									isSubmitting={isAmending}
									onAmend={(supersedesId, text) =>
										submitAmendment(
											thread,
											supersedesId,
											text,
										)
									}
								/>
							))}
						</ul>
					) : null}
				</section>
			) : null}

			{possiblyResolved.length > 0 ? (
				<section aria-label="Possibly resolved questions">
					<button
						type="button"
						onClick={() => setShowPossiblyResolved((open) => !open)}
						aria-expanded={showPossiblyResolved}
						aria-controls="questions-possibly-resolved"
						className="flex w-full items-center gap-2 py-1 text-left"
					>
						<ChevronDownIcon
							className={cn(
								"size-3.5 shrink-0 text-muted-foreground transition-transform",
								!showPossiblyResolved && "-rotate-90",
							)}
							aria-hidden="true"
						/>
						<h3 className="publishing-label">Possibly resolved</h3>
						<span className="text-[11px] text-muted-foreground/70">
							{possiblyResolved.length}
						</span>
					</button>
					{showPossiblyResolved ? (
						<div
							id="questions-possibly-resolved"
							className="mt-2 space-y-3"
						>
							<p className="text-muted-foreground text-xs">
								The latest analysis stopped raising these — they
								can still be answered.
							</p>
							<ul className="space-y-3">
								{possiblyResolved.map((thread) => (
									<QuestionCard
										key={thread.root.id}
										thread={thread}
										canEdit={canEdit}
										isSubmitting={answer.isPending}
										onAnswer={(
											text,
											source,
											version,
											onQuestionChanged,
										) =>
											submitAnswer(
												thread,
												text,
												source,
												version,
												onQuestionChanged,
											)
										}
										members={assignableMembers}
										onMemberQueryChange={setMemberQuery}
										onAssign={(assigneeUserIds, note) =>
											assign.mutate({
												projectId,
												topicId,
												organizationId,
												questionRootId: thread.root.id,
												assigneeUserIds,
												note,
											})
										}
										isAssignSaving={
											assign.isPending &&
											assign.variables?.questionRootId ===
												thread.root.id
										}
										onRestore={() =>
											restore.mutate({
												projectId,
												topicId,
												organizationId,
												questionRootId: thread.root.id,
											})
										}
										isRestoring={
											restore.isPending &&
											restore.variables
												?.questionRootId ===
												thread.root.id
										}
									/>
								))}
							</ul>
						</div>
					) : null}
				</section>
			) : null}
		</section>
	);
}

function QuestionCard({
	thread,
	canEdit,
	isSubmitting,
	onAnswer,
	members,
	onMemberQueryChange,
	onAssign,
	isAssignSaving,
	onRestore,
	isRestoring = false,
}: {
	thread: TopicDecisionThread;
	canEdit: boolean;
	isSubmitting: boolean;
	/**
	 * Save an answer. `expectedAnalysisVersion` is the analysis version of the
	 * question as the member saw it; `onQuestionChanged` runs, with the version
	 * the refused request sent, when a newer analysis has rewritten the question
	 * since.
	 */
	onAnswer: (
		text: string,
		source: AnswerSource,
		expectedAnalysisVersion: number | null,
		onQuestionChanged: (refusedVersion: number | null) => void,
	) => void;
	members: AssignableMember[];
	onMemberQueryChange: (query: string) => void;
	/**
	 * The COMPLETE desired set — the server takes set semantics.
	 *
	 * `note` is the sentence that explains the ask. Without one the server's
	 * original rule stands and a re-save is silent; with one, everybody the
	 * question now waits on hears it, because re-asking somebody already
	 * assigned is the ordinary way a second question gets asked.
	 */
	onAssign: (assigneeUserIds: string[], note?: string) => void;
	isAssignSaving: boolean;
	/**
	 * Put a soft-closed question back on the open list. Only the possibly-
	 * resolved group passes it; everywhere else there is nothing to restore.
	 */
	onRestore?: () => void;
	isRestoring?: boolean;
}) {
	const root = thread.root;
	const options = root.answerOptions ?? [];
	/**
	 * The stored assignee ids, resolved against the member list for names and
	 * avatars.
	 *
	 * An id with no member row left — somebody who has since left the project —
	 * still gets an entry rather than vanishing, because a question silently
	 * showing fewer people than it is actually assigned to is worse than one
	 * showing a nameless avatar. Saving the picker afterwards drops them, which
	 * is the correct resolution: the server refuses non-members outright.
	 */
	const assignees = useMemo(
		() =>
			root.assignees.map((a) => {
				const member = members.find((m) => m.id === a.assigneeUserId);
				return {
					id: a.assigneeUserId,
					name: member?.name ?? member?.email ?? "Former member",
					avatarUrl: member?.avatarUrl ?? null,
					assignedByUserId: a.assignedByUserId,
				};
			}),
		[root.assignees, members],
	);
	// A question with SEVERAL options has something to accept, even when the
	// legacy single `recommendedResponse` is empty — so the editor must not
	// start open and hide them.
	const hasRecommendation =
		Boolean(root.recommendedResponse?.trim()) || options.length > 0;
	/**
	 * Whether the person explicitly opened the editor ("Edit", a pencil, "Type
	 * your own").
	 *
	 * DERIVED (`isEditing` below), not stored once at mount. The card keeps its
	 * key across a refetch (`thread.root.id`), and a regenerated analysis can
	 * refresh an OPEN root with `answerOptions` it did not have before — exactly
	 * the upgrade path this feature's own changeset describes. A one-time
	 * decision made at mount cannot see that: a question with no recommendation
	 * and no options started in the editor, and when options arrived later on
	 * the SAME root the stored flag never moved, so they stayed hidden behind an
	 * editor nobody opened until the card remounted.
	 *
	 * The same stored state also broke "Ask" the other way: on a question with
	 * NOTHING to accept, `cancelEdit` set it `false`, and false with no
	 * recommendation and no options fell through to the recommendation branch —
	 * rendering an empty "Suggested: " line beside a "Use this answer" button
	 * that would have submitted nothing.
	 */
	const [editorOpened, setEditorOpened] = useState(false);
	/**
	 * The text the editor was seeded with, or `null` when it was opened empty
	 * (#1907's shape, mirrored from `SummaryQuestionsPanel`). Seeding is what
	 * separates the three provenances on submit: `null` is MANUAL — nothing was
	 * taken from the AI, including "type your own" on a question that DID offer
	 * a recommendation or options — an UNCHANGED seed is a plain AI_SUGGESTED
	 * acceptance, and a CHANGED one is a real AI_EDITED edit.
	 *
	 * Replaces a `fromSuggestion` boolean that compared the typed text against
	 * `root.recommendedResponse` instead. That comparison is wrong for every
	 * OPTION: a derived approval question has `recommendedResponse: null`, so
	 * an untouched option edit always failed the comparison and was recorded
	 * as `AI_EDITED` regardless of whether anything had actually changed.
	 */
	const [editingSeed, setEditingSeed] = useState<string | null>(null);
	const [draft, setDraft] = useState("");
	/**
	 * The analysis version of the question as the member saw it when they
	 * started composing. Set by `captureVersion` — each editor opener, and the
	 * first keystroke while nothing is captured and no refusal is pending.
	 * Cleared by `cancelEdit` and by a refusal of this card's answer, which
	 * keeps the editor and the draft.
	 *
	 * `submitDraft` sends it when set, else the version on screen at the click.
	 * The page refetches decisions under an open editor (an analysis leaving
	 * GENERATING, a window refocus after the query's stale time), this card
	 * keeps its key and its draft across that refetch on purpose, and a version
	 * read fresh at submit would be the NEW one — the server would then accept
	 * an answer written against wording the member never saw. A one-click
	 * answer sends the version on screen at the click instead.
	 */
	const seenVersion = useRef<number | null | undefined>(undefined);
	/**
	 * The version a refused answer SENT, while the refetch that refusal started
	 * has not landed — `null` when no refusal is pending (a wrapper, because a
	 * root's version can itself be `null`).
	 *
	 * A keystroke while that version is still on screen must not capture it, or
	 * the retry resends the version the server just refused; the first
	 * keystroke after the new version renders captures that one instead. Keyed
	 * on the version SENT, not the one on screen when the refusal came back: a
	 * refetch can land between the submit and the refusal, and the version on
	 * screen is then already the new one — the one the next keystroke must
	 * capture.
	 */
	const refused = useRef<{ version: number | null } | null>(null);

	/** Composing starts: remember the version on screen now. */
	const captureVersion = () => {
		seenVersion.current = root.analysisVersion;
		refused.current = null;
	};

	/**
	 * Send an answer with the version it was written against. When the server
	 * refuses it because the question changed, forget the capture and remember
	 * what was refused, so the retry is written against the wording now coming.
	 */
	const sendAnswer = (
		text: string,
		source: AnswerSource,
		version: number | null,
	) =>
		onAnswer(text, source, version, (refusedVersion) => {
			seenVersion.current = undefined;
			refused.current = { version: refusedVersion };
		});
	// The editor is SHOWN when the person opened it — including by typing,
	// which the textarea's `onChange` below also treats as opening it, so a
	// person mid-draft is never collapsed out from under themselves by
	// options arriving — or when there is nothing to accept (no
	// recommendation and no options — the field is then the only affordance,
	// whatever `editorOpened` says). `editorOpened` alone is enough: every
	// path that gives `draft` a non-empty value also sets it, and the one
	// path that clears both together (`cancelEdit`) keeps that true, so a
	// separate `draft !== ""` term would only ever agree with `editorOpened`
	// and never catch a case it misses.
	const isEditing = editorOpened || !hasRecommendation;
	// Resolved against the members already known, not the filtered search
	// result: narrowing the list while typing a second name must not silently
	// un-mention the first.
	const mentioned = mentionedMemberIds(draft, members);

	/**
	 * Open the editor seeded with the single recommendation, from "Edit".
	 *
	 * The seed is the recommendation's own text, because the person started
	 * from the AI's wording — saved back UNCHANGED, that is an acceptance
	 * (`AI_SUGGESTED`); changed, it is `AI_EDITED`.
	 */
	const openEditorFromRecommendation = () => {
		captureVersion();
		const seed = root.recommendedResponse ?? "";
		setDraft(seed);
		setEditingSeed(seed);
		setEditorOpened(true);
	};

	/**
	 * Open an EMPTY editor, from "Type your own".
	 *
	 * Seeding nothing and leaving `editingSeed` `null` is what makes the answer
	 * record `MANUAL`. Both were previously routed through one helper that
	 * always seeded and always set the flag, so "type your own" pre-filled the
	 * AI's sentence and then recorded `AI_SUGGESTED`/`AI_EDITED` for it —
	 * `MANUAL` was unreachable on any question that carried a recommendation,
	 * which is precisely the misclassification
	 * `20260828120000_repoint_ai_edited_answer_source` swept out of
	 * `decision_log_entry`. `SummaryQuestionsPanel`'s equivalent passes no seed.
	 */
	const openEditorBlank = () => {
		captureVersion();
		setDraft("");
		setEditingSeed(null);
		setEditorOpened(true);
	};

	/**
	 * Open the editor seeded with ONE of the suggested answers.
	 *
	 * The seed is that OPTION's own text — never `root.recommendedResponse`,
	 * which a derived approval question always carries as `null`. Saved back
	 * UNCHANGED, this is a plain acceptance (`AI_SUGGESTED`); only a CHANGED
	 * submission is `AI_EDITED` — the person started from the AI's wording
	 * either way, which is a different fact about acceptance from having typed
	 * their own, and the metric measures exactly that difference.
	 */
	const openEditorWith = (text: string) => {
		captureVersion();
		setDraft(text);
		setEditingSeed(text);
		setEditorOpened(true);
	};

	const cancelEdit = () => {
		setEditorOpened(false);
		setEditingSeed(null);
		setDraft("");
		seenVersion.current = undefined;
		refused.current = null;
	};

	const submitDraft = () => {
		// Three outcomes, decided by what the field was seeded with (#1907's
		// shape, mirrored from `SummaryQuestionsPanel`): no seed means nothing
		// was taken from the AI, so MANUAL — that covers typing your own even
		// with a recommendation or options on offer. A seed saved untouched is
		// a plain acceptance (AI_SUGGESTED), reached through the editor instead
		// of "Use this answer" or an option's own button but the same act. Only
		// a seed the person actually changed is AI_EDITED.
		//
		// The seed is whatever the editor was actually opened WITH — the single
		// recommendation, or one option's own text — never
		// `root.recommendedResponse` compared on its own: a derived approval
		// question has `recommendedResponse: null`, so comparing against it
		// made every untouched OPTION edit fail the comparison and read as
		// AI_EDITED. Classifying an untouched seed as AI_EDITED would also
		// reintroduce exactly the misclassification
		// `20260828120000_repoint_ai_edited_answer_source` swept out of
		// `decision_log_entry`, in a second table. The column exists to measure
		// recommendation acceptance, so two surfaces must not name the same act
		// differently.
		const typed = draft.trim();
		sendAnswer(
			draft,
			editingSeed === null
				? "MANUAL"
				: typed === editingSeed.trim()
					? "AI_SUGGESTED"
					: "AI_EDITED",
			seenVersion.current !== undefined
				? seenVersion.current
				: root.analysisVersion,
		);
	};

	return (
		<li
			// The scroll target for a `#q-<rootId>` notification link. The RAW
			// root id, with no prefix of its own — `useScrollToQuestion` strips
			// the fragment's, and a second one here is how the writer and the
			// reader drift apart.
			data-question-anchor={root.id}
			data-testid={`question-${root.id}`}
			className="space-y-2 rounded-lg border border-border bg-card p-3"
		>
			<div className="flex items-start justify-between gap-3">
				<p className="min-w-0 flex-1 font-medium text-foreground text-sm leading-relaxed">
					{root.summary}
				</p>
				{/* Rendered for a reader too, disabled: who a question is
				    waiting on is worth SEEING even when you cannot change it,
				    and hiding it would make an assigned question look
				    unassigned to exactly the people most likely to answer it. */}
				<QuestionAssigneePicker
					assignees={assignees}
					members={members}
					onChange={onAssign}
					onQueryChange={onMemberQueryChange}
					disabled={!canEdit}
					saving={isAssignSaving}
				/>
			</div>
			{root.whyItMatters ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					{root.whyItMatters}
				</p>
			) : null}
			<QuestionNotes thread={thread} />
			{canEdit && onRestore ? (
				<Button
					type="button"
					variant="outline"
					size="sm"
					disabled={isRestoring}
					onClick={onRestore}
				>
					Restore to open questions
				</Button>
			) : null}

			{canEdit ? (
				isEditing ? (
					<div className="space-y-2">
						{/* The SAME mention textarea Feature Maturation uses,
						    not a copy: it is generic on `members` and has no
						    story-shaped types, and its sibling
						    `QuestionAssigneePicker` is already rendered above.
						    Naming someone here is how you ask them — typing
						    an answer and typing a question to a colleague are
						    the same box, and which one it was is decided by
						    whether a name is in it. */}
						<QuestionMentionTextarea
							value={draft}
							onChange={(value) => {
								setDraft(value);
								// Typing is opening the editor. Without this, an
								// editor that was showing only because there was
								// nothing to accept would collapse the moment
								// options arrived and the person then cleared
								// their typed text back to empty.
								setEditorOpened(true);
								// Typing is also how composing STARTS on a question
								// with nothing to accept, so the first keystroke
								// captures the version on screen — unless it is the
								// version a refused answer just sent, whose
								// replacement has not landed yet.
								const refusalPending =
									refused.current !== null &&
									refused.current.version ===
										root.analysisVersion;
								if (
									seenVersion.current === undefined &&
									!refusalPending
								) {
									captureVersion();
								}
							}}
							members={members}
							onQueryChange={onMemberQueryChange}
							disabled={isSubmitting}
							placeholder="Type an answer, or @name to ask someone…"
							ariaLabel="Your answer"
						/>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{/* ASK, not answer. `onAssign` routes the question
							    and leaves its status alone; `submitDraft` settles it.
							    Offering both when a name is present is what
							    stops "@ana can you check this?" being recorded
							    as the decision. */}
							{mentioned.length > 0 ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isSubmitting}
									onClick={() => {
										onAssign(
											[
												...new Set([
													...assignees.map(
														(a) => a.id,
													),
													...mentioned,
												]),
											],
											draft.trim(),
										);
										cancelEdit();
									}}
								>
									Ask
								</Button>
							) : null}
							{hasRecommendation ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={cancelEdit}
									disabled={isSubmitting}
								>
									Cancel
								</Button>
							) : null}
							<Button
								type="button"
								size="sm"
								onClick={submitDraft}
								disabled={
									isSubmitting || draft.trim().length === 0
								}
							>
								Submit
							</Button>
						</div>
					</div>
				) : options.length > 0 ? (
					/**
					 * SEVERAL suggested answers, the way Feature Maturation
					 * offers them: each is a real option with the reasoning
					 * that supports it, and the pencil opens the editor seeded
					 * with that text so a near-miss can be adjusted rather than
					 * retyped.
					 *
					 * Picking one records `AI_SUGGESTED` directly. Opening the
					 * pencil and submitting the SAME text is the same
					 * acceptance, reached through the editor — `AI_SUGGESTED`,
					 * not `AI_EDITED`. Only a submission that actually CHANGED
					 * the text is `AI_EDITED`, which is what keeps the
					 * acceptance metric honest about the difference (see
					 * `submitDraft`'s `editingSeed` comparison).
					 */
					<SuggestedAnswerOptions
						options={options}
						labels={SUGGESTED_ANSWER_LABELS}
						disabled={isSubmitting}
						onAccept={(option) =>
							sendAnswer(
								option.text,
								"AI_SUGGESTED",
								root.analysisVersion,
							)
						}
						onEdit={(option) => openEditorWith(option.text)}
						onTypeYourOwn={openEditorBlank}
					/>
				) : (
					<div className="space-y-2">
						<p className="text-muted-foreground text-sm leading-relaxed">
							Suggested: {root.recommendedResponse}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								size="sm"
								onClick={() =>
									sendAnswer(
										root.recommendedResponse ?? "",
										"AI_SUGGESTED",
										root.analysisVersion,
									)
								}
								disabled={isSubmitting}
							>
								Use this answer
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={openEditorFromRecommendation}
								disabled={isSubmitting}
							>
								<PencilIcon
									className="mr-1.5 size-3.5"
									aria-hidden="true"
								/>
								Edit
							</Button>
						</div>
					</div>
				)
			) : options.length > 0 ? (
				<ReadOnlySuggestedOptions options={options} />
			) : root.recommendedResponse?.trim() ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					Suggested: {root.recommendedResponse}
				</p>
			) : null}
		</li>
	);
}

/**
 * A read-only viewer's view of a question's suggested answers.
 *
 * The SAME options `QuestionCard`'s editable branch offers, rendered as plain
 * text with no buttons — a `canEdit={false}` viewer can see what the AI
 * suggested and cannot act on any of it.
 *
 * This used to fall through to a branch that rendered `Suggested:
 * {root.recommendedResponse}` whenever `hasRecommendation` was true — which
 * options alone also satisfy. A derived approval question carries
 * `recommendedResponse: null` and its options instead, so a read-only viewer
 * saw the literal empty "Suggested: " line and never saw the options at all.
 */
function ReadOnlySuggestedOptions({
	options,
}: {
	options: { text: string; justification: string }[];
}) {
	// No `onAccept`, so the shared component renders the same options at the
	// same typography with no controls at all.
	return (
		<SuggestedAnswerOptions
			options={options}
			labels={SUGGESTED_ANSWER_LABELS}
		/>
	);
}

/**
 * How many answers were recorded AFTER the analysis was written.
 *
 * The signal behind "your analysis is behind your answers", and shared because
 * it now has two readers: the Planning & Analysis tab, which owns the
 * Regenerate action, and Summary & Questions, which is where answering happens
 * and where the notice therefore has to appear. It shipped living only on the
 * analysis tab, where Radix unmounted it and it could not fire for the person
 * who had just caused it. That tab is force-mounted now, so the unmount no
 * longer happens — but the notice still belongs on both, because it is about
 * answers, and answering happens here.
 *
 * The CURRENT answer (`liveAnswerReply`), not the first: amending appends a
 * superseding reply, and noticing the amendment is the whole point. And only a
 * USABLE one: an "Ask" note is not an answer, and a current answer saved empty
 * records nothing a regeneration could fold in.
 *
 * BLOCKERS count too, not just questions. A blocker answer is the case that
 * most needs the prompt: the quote or the approval it records reaches the
 * draft writers ONLY through a regenerated analysis, so skipping it left the
 * banner silent exactly where staleness costs the most.
 */
export function countAnswersRecordedAfter(
	aiCreatedAt: Date | string | null,
	threads: readonly TopicDecisionThread[] | null | undefined,
): number {
	const writtenAt =
		aiCreatedAt === null ? null : new Date(aiCreatedAt).getTime();
	if (writtenAt === null || Number.isNaN(writtenAt)) {
		return 0;
	}
	return (threads ?? []).filter((thread) => {
		if (thread.root.kind !== "QUESTION" && thread.root.kind !== "BLOCKER") {
			return false;
		}
		const answer = liveAnswerReply(thread);
		if (!answer || !hasUsableAnswer(answer)) {
			return false;
		}
		const answeredAt = new Date(answer.createdAt).getTime();
		return !Number.isNaN(answeredAt) && answeredAt > writtenAt;
	}).length;
}

/**
 * The CURRENT answer on a thread, or `undefined`: the newest reply a member
 * recorded as the answer — authored by a `USER`, status `RESOLVED` — by
 * `createdAt`, then `id`.
 *
 * `currentAnswerReply` (`@repo/utils/publishing-restrictions`) is the rule and
 * this is its web-shaped wrapper. The drafting prompts (`settledDecision`) and
 * the amend guard (`amendTopicQuestionAnswer`) use the same rule, so the answer
 * on screen, the answer the drafts are written from, and the reply an
 * amendment must name are one reply.
 *
 * An "Ask" note is a `USER` reply with status `OPEN`, so it is never the
 * answer; it renders under its question through `QuestionNotes`. A current
 * answer saved blank IS returned — it is the reply an amendment supersedes —
 * and a surface that needs its text checks `hasUsableAnswer`.
 *
 * Exported because the Decision Log and the blockers list answer the same
 * question about the same threads.
 */
export function liveAnswerReply(
	thread: TopicDecisionThread,
): TopicDecisionThread["replies"][number] | undefined {
	return currentAnswerReply(thread.replies) ?? undefined;
}

/**
 * Whether a current answer carries text: not `null`, and not blank once
 * trimmed.
 *
 * Only a historical row fails this — the answer and amend procedures refuse a
 * whitespace-only answer — and on such a thread the answered card and the
 * Decision Log say the latest answer is empty instead of showing an older one.
 */
export function hasUsableAnswer(
	reply: TopicDecisionThread["replies"][number] | undefined,
): boolean {
	return (
		reply !== undefined &&
		reply.content !== null &&
		reply.content.trim().length > 0
	);
}

/**
 * What an answer surface says in place of a current answer saved empty. The
 * invitation only where an Amend control renders beside it.
 */
export function emptyAnswerText(canAmend: boolean): string {
	return canAmend
		? "The latest answer is empty — amend it to record one."
		: "The latest answer is empty.";
}

/**
 * Every earlier answer on this thread, oldest first (`listTopicDecisions`
 * returns replies `createdAt asc`): the answers a member recorded — `USER`,
 * `RESOLVED` — other than the current one, that carry text. A note is never a
 * previous answer, and a blank historical answer has nothing to show.
 */
export function supersededAnswerReplies(
	thread: TopicDecisionThread,
): TopicDecisionThread["replies"] {
	const current = liveAnswerReply(thread);
	return thread.replies.filter(
		(r) =>
			r.id !== current?.id &&
			r.authorType === "USER" &&
			r.status === "RESOLVED" &&
			hasUsableAnswer(r),
	);
}

/**
 * The notes asked on a question, oldest first: replies authored by a `USER`
 * with status `OPEN` and text — what `setTopicQuestionAssignees` writes for an
 * "Ask", and nothing else writes. The one rule for a note.
 */
function questionNotes(
	thread: TopicDecisionThread,
): TopicDecisionThread["replies"] {
	return thread.replies
		.filter(
			(r) =>
				r.authorType === "USER" &&
				r.status === "OPEN" &&
				r.content !== null &&
				r.content.trim().length > 0,
		)
		.sort((a, b) => {
			const at = new Date(a.createdAt).getTime();
			const bt = new Date(b.createdAt).getTime();
			if (at !== bt) {
				return at < bt ? -1 : 1;
			}
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
}

/**
 * The notes asked on a question, each with who asked and when.
 *
 * ALWAYS with the question — never in an answer's place, never struck through
 * as a previous answer: a note asks somebody something, and that stays true
 * after the question is answered. The open, set-aside and answered cards here
 * and every decision card in the Decision Log render notes through this one
 * component.
 *
 * In full, as plain text: the assignment notification cuts a note at 280
 * characters and links to this question, so this is where the rest of it is
 * read. `break-words` keeps a long unbroken token inside the card.
 */
export function QuestionNotes({ thread }: { thread: TopicDecisionThread }) {
	const notes = questionNotes(thread);
	if (notes.length === 0) {
		return null;
	}
	return (
		<ul aria-label="Notes on this question" className="space-y-2">
			{notes.map((note) => {
				const askedAt = new Date(note.createdAt);
				return (
					<li
						key={note.id}
						className="space-y-0.5 border-border border-l-2 pl-3"
					>
						<p className="text-muted-foreground text-xs">
							Asked by{" "}
							<AuthorLabel
								authorType={note.authorType}
								author={note.author}
							/>{" "}
							·{" "}
							<time dateTime={askedAt.toISOString()}>
								{askedAt.toLocaleString()}
							</time>
						</p>
						<p className="whitespace-pre-wrap break-words text-muted-foreground text-sm leading-relaxed">
							{note.content}
						</p>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Who made a decision, or asked about one.
 *
 * "Team member" was a placeholder that reached production: the id was on the
 * wire and the name never was, so every human decision in the log read as
 * anonymous. The name is the point of a log — "who decided this" is most of
 * what you come here to find out.
 *
 * The fallback stays for the two cases where there genuinely is no name: an
 * author whose account has been removed (`authorUserId` is `ON DELETE SET
 * NULL`, so the decision survives and the name does not), and a row minted
 * before the relation was selected.
 *
 * Lives here rather than in the Decision Log because both tabs render it and
 * the log already imports from this file; the reverse import would be a cycle.
 */
export function AuthorLabel({
	authorType,
	author,
}: {
	authorType: "USER" | "AGENT";
	author?: { name: string } | null;
}) {
	if (authorType === "AGENT") {
		return (
			<span className="inline-flex items-center gap-1 font-medium text-foreground">
				<SparklesIcon className="size-3" aria-hidden="true" />
				AI
			</span>
		);
	}
	return (
		<span className="font-medium text-foreground">
			{author?.name ?? "Team member"}
		</span>
	);
}

function AnsweredCard({
	thread,
	canEdit,
	isSubmitting,
	onAmend,
}: {
	thread: TopicDecisionThread;
	canEdit: boolean;
	isSubmitting: boolean;
	onAmend: (
		supersedesId: string,
		answer: string,
	) => Promise<{ status: string } | undefined>;
}) {
	const root = thread.root;
	// The answer text lives on the reply, not the root — `answerTopicQuestion`
	// records it as a REPLY so the question survives beside its answer.
	const answerReply = liveAnswerReply(thread);
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");

	// Trimmed, so a current answer saved blank opens an EMPTY editor: Save stays
	// disabled until there is something to record, and the amendment names the
	// blank reply it supersedes.
	const openEditor = () => {
		setDraft(answerReply?.content?.trim() ?? "");
		setIsEditing(true);
	};

	/**
	 * Close on SUCCESS, never on submit.
	 *
	 * Two outcomes leave the amendment unrecorded — the server refusing it as
	 * `stale` because a colleague amended first, and the request failing
	 * outright — and in both the textarea holds the only copy of what the
	 * person wrote. Closing eagerly would throw that away while the toast
	 * announced that nothing had been saved. Left open, the refreshed answer
	 * renders in the card beside the draft, which is exactly what someone needs
	 * to reconcile the two.
	 */
	const saveAmendment = async (supersedesId: string) => {
		try {
			const result = await onAmend(supersedesId, draft);
			if (result?.status !== "stale") {
				setIsEditing(false);
			}
		} catch {
			// The panel's `onError` has already said so; keep the draft.
		}
	};

	return (
		<li
			// The scroll target for a `#q-<rootId>` link, the open card's
			// convention: the RAW root id, no prefix of its own.
			data-question-anchor={root.id}
			className="space-y-2 rounded-lg border border-border bg-card p-3"
		>
			<p className="text-foreground text-sm leading-relaxed">
				{root.summary}
			</p>
			<QuestionNotes thread={thread} />
			{isEditing && answerReply ? (
				<div className="space-y-2">
					<Textarea
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						rows={3}
						aria-label="Your answer"
						disabled={isSubmitting}
					/>
					<div className="flex items-center justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setIsEditing(false)}
							disabled={isSubmitting}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="sm"
							onClick={() => saveAmendment(answerReply.id)}
							disabled={isSubmitting || draft.trim().length === 0}
						>
							Save answer
						</Button>
					</div>
				</div>
			) : (
				<>
					{answerReply ? (
						<p
							data-testid="decision-answer"
							className="text-muted-foreground text-sm leading-relaxed"
						>
							{hasUsableAnswer(answerReply)
								? answerReply.content
								: emptyAnswerText(canEdit)}
						</p>
					) : null}
					{/* Gated on an answer EXISTING as well as on `canEdit`:
					    there is nothing to supersede without one, and the
					    server refuses that call as `stale` rather than
					    inventing a first answer through the amend path. */}
					{canEdit && answerReply ? (
						<div className="flex justify-end">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={openEditor}
								disabled={isSubmitting}
							>
								<PencilIcon
									className="mr-1.5 size-3.5"
									aria-hidden="true"
								/>
								Amend
							</Button>
						</div>
					) : null}
				</>
			)}
		</li>
	);
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
