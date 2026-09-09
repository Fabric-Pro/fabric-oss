"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, PencilIcon, SparklesIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
	type AssignableMember,
	QuestionAssigneePicker,
} from "../stories/maturation/QuestionAssigneePicker";
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
	kind: "QUESTION" | "AI_UPDATE";
	status: string;
	authorType: "USER" | "AGENT";
	authorUserId: string | null;
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
 * `POSSIBLY_RESOLVED` roots — soft-closed by reconciliation rather than
 * settled by anyone — render in their own group, collapsed behind a toggle
 * (mirroring `SummaryQuestionsPanel`'s `showPossiblyResolved`, IN4). Unlike
 * that sibling, which only offers to restore one, this table's
 * `answerTopicQuestion` deliberately keeps POSSIBLY_RESOLVED answerable — it
 * was soft-closed because a regeneration stopped raising it, not settled by
 * anyone — so the group gets the SAME `QuestionCard` controls OPEN questions
 * get, not a restore button.
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
			// default. `answerSource` counts recommendation ACCEPTANCE — the
			// column `20260828120000_repoint_ai_edited_answer_source` exists to
			// keep honest. The amend editor is seeded with the answer already on
			// record, never with `recommendedResponse`, so nothing typed here is
			// an act of taking the AI's wording: re-typing your own text is
			// MANUAL, and so is replacing an AI answer with your own. An
			// amendment that happened to land on the recommendation's exact words
			// still was not reached by accepting it.
			answerSource: "MANUAL",
		});
	};

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
					<h3 className="editorial-label">Open questions</h3>
					<ul className="space-y-3">
						{open.map((thread) => (
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
								onAssign={(assigneeUserIds) =>
									assign.mutate({
										projectId,
										topicId,
										organizationId,
										questionRootId: thread.root.id,
										assigneeUserIds,
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
			) : null}

			{resolved.length > 0 ? (
				<div className="space-y-3">
					<h3 className="editorial-label">Answered</h3>
					<ul className="space-y-3">
						{resolved.map((thread) => (
							<AnsweredCard
								key={thread.root.id}
								thread={thread}
								canEdit={canEdit}
								isSubmitting={amend.isPending}
								onAmend={(supersedesId, text) =>
									submitAmendment(thread, supersedesId, text)
								}
							/>
						))}
					</ul>
				</div>
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
						<h3 className="editorial-label">Possibly resolved</h3>
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
										onAssign={(assigneeUserIds) =>
											assign.mutate({
												projectId,
												topicId,
												organizationId,
												questionRootId: thread.root.id,
												assigneeUserIds,
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
}: {
	thread: TopicDecisionThread;
	canEdit: boolean;
	isSubmitting: boolean;
	onAnswer: (text: string, source: AnswerSource) => void;
	members: AssignableMember[];
	onMemberQueryChange: (query: string) => void;
	/** The COMPLETE desired set — the server takes set semantics. */
	onAssign: (assigneeUserIds: string[]) => void;
	isAssignSaving: boolean;
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
	// A question with no recommendation has nothing to accept or edit, so its
	// free-form field IS the only affordance and starts open. One WITH a
	// recommendation starts collapsed, showing it plus "Use this answer" /
	// "Edit" — whether the editor was opened FROM the recommendation is what
	// separates a MANUAL answer from one the AI seeded, the same distinction
	// `SummaryQuestionsPanel` draws for features.
	const [isEditing, setIsEditing] = useState(() => !hasRecommendation);
	const [fromSuggestion, setFromSuggestion] = useState(false);
	const [draft, setDraft] = useState("");

	const openEditor = () => {
		setDraft(root.recommendedResponse ?? "");
		setFromSuggestion(true);
		setIsEditing(true);
	};

	/**
	 * Open the editor seeded with ONE of the suggested answers.
	 *
	 * `fromSuggestion` stays true, so an answer edited from an option records
	 * `AI_EDITED` rather than `MANUAL` — the person started from the AI's
	 * wording, which is a different fact about acceptance from having typed
	 * their own, and the metric measures exactly that difference.
	 */
	const openEditorWith = (text: string) => {
		setDraft(text);
		setFromSuggestion(true);
		setIsEditing(true);
	};

	const cancelEdit = () => {
		setIsEditing(false);
		setFromSuggestion(false);
		setDraft("");
	};

	const submitDraft = () => {
		// Three outcomes, decided by what the field was seeded with, mirroring
		// `SummaryQuestionsPanel`: no seed means nothing was taken from the AI,
		// so MANUAL — that covers typing your own even with a recommendation on
		// offer. A seed saved untouched is a plain acceptance (AI_SUGGESTED),
		// reached through the editor instead of "Use this answer" but the same
		// act. Only a seed the person actually changed is AI_EDITED.
		//
		// Classifying an untouched seed as AI_EDITED would reintroduce exactly
		// the misclassification `20260828120000_repoint_ai_edited_answer_source`
		// swept out of `decision_log_entry`, in a second table. The column
		// exists to measure recommendation acceptance, so two surfaces must not
		// name the same act differently.
		const typed = draft.trim();
		const seed = fromSuggestion
			? (root.recommendedResponse ?? "").trim()
			: null;
		onAnswer(
			draft,
			seed === null
				? "MANUAL"
				: typed === seed
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
			className="space-y-2 rounded-lg border border-border bg-card p-4"
		>
			<div className="flex items-start justify-between gap-3">
				<p className="min-w-0 flex-1 text-foreground text-sm leading-relaxed">
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

			{canEdit ? (
				isEditing ? (
					<div className="space-y-2">
						<Textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							placeholder="Type an answer…"
							rows={3}
							aria-label="Your answer"
							disabled={isSubmitting}
						/>
						<div className="flex items-center justify-end gap-2">
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
					 * Picking one records `AI_SUGGESTED` — the person took the
					 * AI's wording. Editing it first records `AI_EDITED`, which
					 * is what keeps the acceptance metric honest about the
					 * difference.
					 */
					<div className="space-y-2">
						<p className="flex items-center gap-2 font-medium text-secondary text-xs uppercase tracking-[0.16em]">
							<SparklesIcon
								className="size-3.5"
								aria-hidden="true"
							/>
							Suggested answers
						</p>
						{options.map((option) => (
							<div
								key={option.text}
								className="flex items-start gap-2 rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/40"
							>
								<button
									type="button"
									disabled={isSubmitting}
									onClick={() =>
										onAnswer(option.text, "AI_SUGGESTED")
									}
									className="min-w-0 flex-1 text-left"
								>
									<span className="block font-medium text-sm">
										{option.text}
									</span>
									<span className="mt-1 block text-muted-foreground text-xs leading-relaxed">
										{option.justification}
									</span>
								</button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={isSubmitting}
									aria-label={`Edit "${option.text}" before answering`}
									onClick={() => openEditorWith(option.text)}
								>
									<PencilIcon
										className="size-3.5"
										aria-hidden="true"
									/>
								</Button>
							</div>
						))}
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={isSubmitting}
							onClick={openEditor}
						>
							Type your own
						</Button>
					</div>
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
								onClick={openEditor}
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
			) : hasRecommendation ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					Suggested: {root.recommendedResponse}
				</p>
			) : null}
		</li>
	);
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
		<li className="space-y-2 rounded-lg border border-border bg-card p-4">
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
