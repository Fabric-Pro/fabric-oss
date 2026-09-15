"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, PencilIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
	/** The latest analysis attempt is FAILED — an empty list means "we could
	 * not ask", not "there was nothing to ask". */
	analysisFailed?: boolean;
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
 * them. The full record of a decision — its reply history and its
 * attribution — is the Decision Log's job either way; what stays here is the
 * fast route from "I just answered that" to amending it.
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
	analysisFailed = false,
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
			onSuccess: () => {
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
	 * anything — the root stays OPEN, which is what separates asking somebody
	 * from settling the question yourself.
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

	const submitAnswer = (
		thread: TopicDecisionThread,
		text: string,
		answerSource: AnswerSource,
	) => {
		const questionId = thread.root.questionId;
		const trimmed = text.trim();
		if (!questionId || trimmed.length === 0) {
			return;
		}
		answer.mutate({
			projectId,
			topicId,
			organizationId,
			questionId,
			answer: trimmed,
			answerSource,
		});
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
										onAnswer={(text, source) =>
											submitAnswer(thread, text, source)
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
			) : null}

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
										onAnswer={(text, source) =>
											submitAnswer(thread, text, source)
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
	onAnswer: (text: string, source: AnswerSource) => void;
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
		setDraft(text);
		setEditingSeed(text);
		setEditorOpened(true);
	};

	const cancelEdit = () => {
		setEditorOpened(false);
		setEditingSeed(null);
		setDraft("");
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
		onAnswer(
			draft,
			editingSeed === null
				? "MANUAL"
				: typed === editingSeed.trim()
					? "AI_SUGGESTED"
					: "AI_EDITED",
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
							}}
							members={members}
							onQueryChange={onMemberQueryChange}
							disabled={isSubmitting}
							placeholder="Type an answer, or @name to ask someone…"
							ariaLabel="Your answer"
						/>
						<div className="flex flex-wrap items-center justify-end gap-2">
							{/* ASK, not answer. `onAssign` routes the question
							    and leaves it OPEN; `submitDraft` settles it.
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
							onAnswer(option.text, "AI_SUGGESTED")
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
									onAnswer(
										root.recommendedResponse ?? "",
										"AI_SUGGESTED",
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
 * How many live answers were recorded AFTER the analysis was written.
 *
 * The signal behind "your analysis is behind your answers", and shared because
 * it now has two readers: the Planning & Analysis tab, which owns the
 * Regenerate action, and Summary & Questions, which is where answering happens
 * and where the notice therefore has to appear. Radix unmounts an inactive
 * `TabsContent`, so a banner that lives only on the analysis tab cannot fire
 * for the person who just caused it — which is exactly how it shipped.
 *
 * The LIVE answer, not the first: amending appends a superseding reply, and
 * noticing the amendment is the whole point.
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
		if (thread.root.kind !== "QUESTION") {
			return false;
		}
		const answer = liveAnswerReply(thread);
		if (!answer) {
			return false;
		}
		const answeredAt = new Date(answer.createdAt).getTime();
		return !Number.isNaN(answeredAt) && answeredAt > writtenAt;
	}).length;
}

/**
 * The LIVE answer on a thread: the NEWEST reply carrying content.
 *
 * `.find()` — the first one — was correct while a question could only ever be
 * answered once. Amending appends a superseding reply rather than editing the
 * original, so the first reply is now the OLDEST answer and reading it would
 * show text the author has already replaced. `listTopicDecisions` returns
 * replies `createdAt asc`, so the last match is the current one.
 *
 * Exported because the Decision Log answers the same question about the same
 * threads, and two copies of this rule would diverge the first time either
 * moved — the log showing one answer while the tab beside it shows another is
 * exactly the confusion amending is supposed to remove.
 */
export function liveAnswerReply(
	thread: TopicDecisionThread,
): TopicDecisionThread["replies"][number] | undefined {
	for (let i = thread.replies.length - 1; i >= 0; i--) {
		const reply = thread.replies[i];
		if (reply.content !== null && reply.content.trim().length > 0) {
			return reply;
		}
	}
	return undefined;
}

/** Every answer this thread has superseded, oldest first. */
export function supersededAnswerReplies(
	thread: TopicDecisionThread,
): TopicDecisionThread["replies"] {
	const live = liveAnswerReply(thread);
	return thread.replies.filter(
		(r) =>
			r.id !== live?.id &&
			r.content !== null &&
			r.content.trim().length > 0,
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

	const openEditor = () => {
		setDraft(answerReply?.content ?? "");
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
		<li className="space-y-2 rounded-lg border border-border bg-card p-3">
			<p className="text-foreground text-sm leading-relaxed">
				{root.summary}
			</p>
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
						<p className="text-muted-foreground text-sm leading-relaxed">
							{answerReply.content}
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
