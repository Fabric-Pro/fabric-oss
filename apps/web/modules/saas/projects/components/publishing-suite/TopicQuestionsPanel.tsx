"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { ChevronDownIcon, PencilIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
}: Props) {
	const queryClient = useQueryClient();
	const [showPossiblyResolved, setShowPossiblyResolved] = useState(false);

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

	const questions = threads.filter((t) => t.root.kind === "QUESTION");
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
}: {
	thread: TopicDecisionThread;
	canEdit: boolean;
	isSubmitting: boolean;
	onAnswer: (text: string, source: AnswerSource) => void;
}) {
	const root = thread.root;
	const hasRecommendation = Boolean(root.recommendedResponse?.trim());
	// A question with no recommendation has nothing to accept or edit, so its
	// free-form field IS the only affordance and starts open. One WITH a
	// recommendation starts collapsed, showing it plus "Use this answer" /
	// "Edit" — whether the editor was opened FROM the recommendation is what
	// separates a MANUAL answer from one the AI seeded, the same distinction
	// `SummaryQuestionsPanel` draws for features.
	const [isEditing, setIsEditing] = useState(!hasRecommendation);
	const [fromSuggestion, setFromSuggestion] = useState(false);
	const [draft, setDraft] = useState("");

	const openEditor = () => {
		setDraft(root.recommendedResponse ?? "");
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
		<li className="space-y-2 rounded-lg border border-border bg-card p-4">
			<p className="text-foreground text-sm leading-relaxed">
				{root.summary}
			</p>
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

function AnsweredCard({ thread }: { thread: TopicDecisionThread }) {
	const root = thread.root;
	// The answer text lives on the reply, not the root — `answerTopicQuestion`
	// records it as a REPLY so the question survives beside its answer.
	const answerReply = thread.replies.find(
		(r) => r.content !== null && r.content.trim().length > 0,
	);
	return (
		<li className="space-y-2 rounded-lg border border-border bg-card p-4">
			<p className="text-foreground text-sm leading-relaxed">
				{root.summary}
			</p>
			{answerReply ? (
				<p className="text-muted-foreground text-sm leading-relaxed">
					{answerReply.content}
				</p>
			) : null}
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
