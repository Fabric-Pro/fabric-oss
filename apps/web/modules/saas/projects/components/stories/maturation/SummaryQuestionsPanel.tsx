"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Markdown } from "@ui/components/markdown";
import { Skeleton } from "@ui/components/skeleton";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2, Pencil, SparklesIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import {
	type AssignableMember,
	QuestionAssigneePicker,
} from "./QuestionAssigneePicker";
import {
	mentionedMemberIds,
	QuestionMentionTextarea,
} from "./QuestionMentionTextarea";
import type { AiReadinessData } from "./ReadinessBar";
import { ReadinessBar } from "./ReadinessBar";
import type {
	AnswerSource,
	DecisionLogThread,
	QuestionAssignee,
	SuggestedAnswerOption,
} from "./types";
import { useScrollToQuestion } from "./use-scroll-to-question";

/** Max suggested options to render per question (FR-3: 1–4; mirrors the API cap). */
const MAX_SUGGESTED_OPTIONS = 4;

/**
 * Deduped, capped list of AI-suggested options (each with its justification).
 * Drops blank text and dedupes by text (case-insensitive).
 */
function suggestionOptions(
	suggestedOptions: SuggestedAnswerOption[] | null | undefined,
): SuggestedAnswerOption[] {
	const seen = new Set<string>();
	const out: SuggestedAnswerOption[] = [];
	for (const opt of suggestedOptions ?? []) {
		const text = opt?.text?.trim();
		if (!text) {
			continue;
		}
		const key = text.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		out.push({ text, justification: opt.justification ?? "" });
		if (out.length >= MAX_SUGGESTED_OPTIONS) {
			break;
		}
	}
	return out;
}

/**
 * Fixed topic taxonomy order (mirrors `QUESTION_TOPICS` in the API classifier).
 * Open questions are grouped under these headers; anything unmapped (or a
 * pre-topic question with `topic: null`) falls into "Other", rendered last.
 */
const TOPIC_ORDER = [
	"Scope & Requirements",
	"Tooling & Tech",
	"Data & Storage",
	"UX & Design",
	"Rollout & Migration",
	"Integrations & Sources",
	"Testing & QA",
	"Other",
] as const;

const OTHER_TOPIC = "Other";

/**
 * Label for the "Ask" action: name up to two people, count beyond.
 *
 * The control sits in a row with two others, so an unbounded list of names would
 * reflow it. Two is where a name still reads as a person rather than a tally.
 */
function formatAskNames(names: string[]): string {
	if (names.length === 1) {
		return names[0];
	}
	if (names.length === 2) {
		return `${names[0]} & ${names[1]}`;
	}
	return `${names.length} people`;
}

/** Group open-question threads by topic, in the fixed taxonomy order. */
function groupByTopic(
	openQuestions: DecisionLogThread[],
): { topic: string; items: DecisionLogThread[] }[] {
	const byTopic = new Map<string, DecisionLogThread[]>();
	for (const thread of openQuestions) {
		const topic = thread.root.topic ?? OTHER_TOPIC;
		const bucket = byTopic.get(topic);
		if (bucket) {
			bucket.push(thread);
		} else {
			byTopic.set(topic, [thread]);
		}
	}
	const orderOf = (t: string) => {
		const i = TOPIC_ORDER.indexOf(t as (typeof TOPIC_ORDER)[number]);
		return i === -1 ? TOPIC_ORDER.length - 1 : i;
	};
	return [...byTopic.entries()]
		.map(([topic, items]) => ({ topic, items }))
		.sort((a, b) => orderOf(a.topic) - orderOf(b.topic));
}

type Props = {
	summaryDigest: string | null;
	/** OPEN-status thread roots — the questions/gaps the PO still has to work. */
	openQuestions: DecisionLogThread[];
	/**
	 * POSSIBLY_RESOLVED thread roots — questions the latest Clean Spec refresh no
	 * longer lists (#5). Shown collapsed; restorable, never deleted.
	 */
	possiblyResolvedQuestions?: DecisionLogThread[];
	/** Human-owned notebook text (`workingNotesContent`). The AI never writes it. */
	workingNotesContent: string | null;
	/**
	 * Summary is unavailable and being produced: the editor-state query is still
	 * loading, the first-open seed hasn't fired yet, or a (re)generation is in
	 * flight. Drives the spinner so the tab never shows a static "No summary yet"
	 * state during the pre-seed window (#1796). When settled with no digest, the
	 * empty state shows instead.
	 */
	isGenerating?: boolean;
	onAnswer: (
		questionId: string,
		answer: string,
		opts?: { summary?: string; answerSource?: AnswerSource },
	) => void;
	/** Per-feature auto-propose-answers toggle state (#7). */
	autoProposeAnswers?: boolean;
	/** Toggle auto-propose answers — wired to `setAutoProposeAnswers` (#7). */
	onToggleAutoPropose?: (enabled: boolean) => void;
	/** True while the auto-propose toggle mutation is in flight. */
	togglingAutoPropose?: boolean;
	/** Save the notebook text — wired to `setWorkingNotes` (fired on blur). */
	onSaveNotes: (content: string) => void;
	/** Re-open a soft-closed question — wired to `restoreQuestion` (#5). */
	onRestoreQuestion?: (questionRootId: string) => void;
	/**
	 * Who each open question is waiting on (#1751), keyed by thread root id.
	 * Absent when the feature ships dark, which is what keeps every control
	 * below invisible without a second flag check per call site.
	 */
	questionAssignees?: Record<string, QuestionAssignee[]>;
	/** Project members offered by the picker and the `@` popover (AC-3). */
	assignableMembers?: AssignableMember[];
	/** Drives the member search behind both. */
	onAssigneeQueryChange?: (query: string) => void;
	/**
	 * Set the COMPLETE assignee list for a question. `note` carries the sentence
	 * the asker had typed, and is stored as context — never as an answer, so the
	 * question stays open.
	 */
	onSetAssignees?: (
		questionRootId: string,
		assigneeUserIds: string[],
		note?: string,
	) => void;
	/** The question root whose assignment mutation is in flight, else null. */
	settingAssigneesId?: string | null;
	/** The `questionId` currently being answered (mutation pending), else null. */
	answeringId: string | null;
	/** The question root id currently being restored (mutation pending), else null. */
	restoringId?: string | null;
	/** Optional feature readiness signals for ReadinessBar calculation */
	hasAcceptanceCriteria?: boolean;
	blockingGapCount?: number;
	isSpecRecentlyUpdated?: boolean;
	hasFunctionalRequirements?: boolean;
	resolvedQuestionsCount?: number;
	storyKind?: "FEATURE" | "BUG";
	hasExpectedResult?: boolean;
	hasActualResult?: boolean;
	needsMoreInfo?: boolean;
	isAiMode?: boolean;
	isAiEvaluating?: boolean;
	aiResult?: AiReadinessData | null;
	onToggleAiMode?: (enabled: boolean) => void;
};

/**
 * Tab 1 — Summary & Questions. Three stacked
 * sections in a fixed order: Summary (AI-owned digest, read-only), Questions
 * (answered inline, expand-in-place — answering resolves the thread and the
 * server propagates a scoped patch to the spec deterministically), and Notes
 * (the human's free-text notebook — the only place the PO writes prose; the AI
 * never touches it). Questions are no longer scanned from this tab — they arrive
 * from a maturation run (stage advance / Enhance).
 */
export function SummaryQuestionsPanel({
	summaryDigest,
	openQuestions,
	possiblyResolvedQuestions = [],
	workingNotesContent,
	isGenerating = false,
	onAnswer,
	autoProposeAnswers = true,
	onToggleAutoPropose,
	togglingAutoPropose = false,
	onSaveNotes,
	onRestoreQuestion,
	questionAssignees,
	assignableMembers = [],
	onAssigneeQueryChange,
	onSetAssignees,
	settingAssigneesId = null,
	answeringId,
	restoringId = null,
	hasAcceptanceCriteria,
	blockingGapCount,
	isSpecRecentlyUpdated,
	hasFunctionalRequirements,
	resolvedQuestionsCount,
	storyKind = "FEATURE",
	hasExpectedResult,
	hasActualResult,
	needsMoreInfo,
	isAiMode,
	isAiEvaluating,
	aiResult,
	onToggleAiMode,
}: Props) {
	const t = useTranslations("projects.stories.maturation.summaryQuestions");
	const tTooltip = useTranslations("tooltips.maturation");
	const [activeId, setActiveId] = useState<string | null>(null);
	const [answer, setAnswer] = useState("");
	const [summary, setSummary] = useState("");
	// The suggestion text the open answer field was seeded with, or null when the
	// field was opened empty. Seeding is what separates the three provenances on
	// submit: null is MANUAL (nothing was taken from the AI — including "type your
	// own" on a question that DID offer suggestions), an unchanged seed is a plain
	// AI_SUGGESTED acceptance, and a changed one is a real AI_EDITED edit (#1907).
	const [editingSeed, setEditingSeed] = useState<string | null>(null);
	const [showPossiblyResolved, setShowPossiblyResolved] = useState(false);

	/**
	 * Everyone the member search has returned SO FAR.
	 *
	 * `assignableMembers` is a search result, not a roster: it narrows to
	 * whatever the `@` token currently reads, so by the time a third name is
	 * being typed the first two are no longer in it. Resolving mentions against
	 * it drops everyone named before the last token — which is why typing
	 * `@and` and picking a second person silently un-mentioned the first, while
	 * a bare `@` (an unfiltered search) named them all.
	 *
	 * Only the resolution reads this. The picker and the `@` popover keep the
	 * filtered list, because narrowing is exactly what they are for.
	 */
	const [knownMembers, setKnownMembers] = useState<AssignableMember[]>([]);
	useEffect(() => {
		if (assignableMembers.length === 0) {
			return;
		}
		setKnownMembers((previous) => {
			const byId = new Map(previous.map((member) => [member.id, member]));
			let grew = false;
			for (const member of assignableMembers) {
				if (!byId.has(member.id)) {
					byId.set(member.id, member);
					grew = true;
				}
			}
			// Same set back when nothing is new, so this never re-renders itself.
			return grew ? [...byId.values()] : previous;
		});
	}, [assignableMembers]);

	// Local mirror of the notebook text. Seeded from the server value and only
	// re-synced when the server value actually changes (e.g. another tab/user),
	// so in-progress typing is never clobbered by a re-render. `setWorkingNotes`
	// is the only writer, fired on blur; we deliberately don't re-hydrate on its
	// success.
	const [notes, setNotes] = useState(workingNotesContent ?? "");
	const [lastServerNotes, setLastServerNotes] = useState(
		workingNotesContent ?? "",
	);
	useEffect(() => {
		const incoming = workingNotesContent ?? "";
		if (incoming !== lastServerNotes) {
			setLastServerNotes(incoming);
			setNotes(incoming);
		}
	}, [workingNotesContent, lastServerNotes]);

	const commitNotes = () => {
		if (notes !== lastServerNotes) {
			setLastServerNotes(notes);
			onSaveNotes(notes);
		}
	};

	// `seed` pre-fills the field with a suggestion's text (the Edit affordance);
	// omitting it opens an empty field, which is what "type your own" and a
	// question with no suggestions both do.
	const open = (id: string, seed?: string) => {
		setActiveId(id);
		setAnswer(seed ?? "");
		setSummary("");
		setEditingSeed(seed ?? null);
	};

	// Group the open questions by topic so the PO can triage by subject. A single
	// group with everything in "Other" reads as an ungrouped list, which is the
	// right fallback for questions minted before topics existed.
	const questionGroups = useMemo(
		() => groupByTopic(openQuestions),
		[openQuestions],
	);
	const isGrouped =
		questionGroups.length > 1 ||
		(questionGroups[0]?.topic !== OTHER_TOPIC &&
			questionGroups.length === 1);

	// Scroll to the question a notification linked to, once the list has arrived.
	useScrollToQuestion(openQuestions.length > 0);

	/**
	 * Status tally for the top of the list (AC-20).
	 *
	 * `Assigned` is DERIVED — an open question with somebody on it — not a stored
	 * status. A status enum member would fall out of the `OPEN` predicates behind
	 * the roadmap's open-question count and the reconciliation sweep, so the
	 * distinction lives here, where it is only ever display.
	 */
	const statusCounts = useMemo(() => {
		const assigned = questionAssignees
			? openQuestions.filter(
					(thread) =>
						(questionAssignees[thread.root.id]?.length ?? 0) > 0,
				).length
			: 0;
		return {
			answered: resolvedQuestionsCount ?? 0,
			assigned,
			unanswered: openQuestions.length - assigned,
		};
	}, [openQuestions, questionAssignees, resolvedQuestionsCount]);

	const renderThread = (thread: DecisionLogThread) => {
		const isActive = activeId === thread.root.id;
		// answerQuestion resolves the OPEN root by its stable questionId (not the
		// row id), so pending state + the submitted value both key off questionId.
		const isAnswering = answeringId === thread.root.questionId;
		// AI recommendations (#7): one click on a suggested option records the
		// answer as AI_SUGGESTED; "type your own" opens the field as AI_EDITED.
		const options = suggestionOptions(thread.root.suggestedOptions);
		const hasSuggestions = options.length > 0;
		// Assignment controls are present only when the caller wired them, which is
		// how the feature ships dark without a flag check at every control.
		const assignmentEnabled = Boolean(questionAssignees && onSetAssignees);
		const assignees = questionAssignees?.[thread.root.id] ?? [];
		// Everyone named in the draft answer. Their presence is what offers the
		// second action — the text alone cannot say whether they are being cited
		// or asked, so the author picks.
		const mentioned = isActive
			? mentionedMemberIds(answer, knownMembers)
			: [];
		const mentionedNames = mentioned
			.map((id) => knownMembers.find((m) => m.id === id)?.name)
			.filter((name): name is string => Boolean(name));

		return (
			<li
				key={thread.root.id}
				// Same raw root id the notification's `#q-<id>` fragment carries, so
				// a deep link lands on this row (AC-12).
				data-question-anchor={thread.root.id}
				className="rounded-lg border bg-card p-3"
			>
				<p className="text-sm font-medium text-foreground">
					{thread.root.summary ?? thread.root.content ?? ""}
				</p>
				{thread.root.content && thread.root.summary && (
					<Markdown className="mt-1 leading-relaxed text-muted-foreground">
						{thread.root.content}
					</Markdown>
				)}

				{assignmentEnabled && (
					<div className="mt-2 flex items-center gap-1">
						<QuestionAssigneePicker
							assignees={assignees}
							members={assignableMembers}
							onChange={(ids) =>
								onSetAssignees?.(thread.root.id, ids)
							}
							onQueryChange={onAssigneeQueryChange ?? (() => {})}
							saving={settingAssigneesId === thread.root.id}
						/>
					</div>
				)}

				{/* The turns already on the question — in practice the sentence
				    somebody typed when they asked ("could you take the second
				    part?"). A notification links straight here, so a recipient
				    who cannot see what they were asked has been handed a bare
				    assignment (#1751 follow-up). Answers never appear: answering
				    flips the root out of OPEN and off this list entirely. */}
				{thread.replies.length > 0 && (
					<ul className="mt-3 space-y-2 border-l-2 border-border pl-3">
						{thread.replies.map((reply) => (
							<li key={reply.id}>
								<div className="flex flex-wrap items-baseline gap-2">
									<span className="text-xs font-medium text-foreground">
										{reply.authorName ??
											t("noteAuthorUnknown")}
									</span>
									<time
										dateTime={reply.createdAt.toISOString()}
										className="text-[11px] text-muted-foreground"
									>
										{reply.createdAt.toLocaleString()}
									</time>
								</div>
								<Markdown className="mt-0.5 text-sm leading-relaxed text-foreground">
									{reply.content ?? ""}
								</Markdown>
							</li>
						))}
					</ul>
				)}

				{isActive ? (
					<div className="mt-3 space-y-2">
						{assignmentEnabled ? (
							<QuestionMentionTextarea
								value={answer}
								onChange={setAnswer}
								members={assignableMembers}
								onQueryChange={
									onAssigneeQueryChange ?? (() => {})
								}
								placeholder={t("answerPlaceholder")}
								ariaLabel={t("answerLabel")}
								disabled={isAnswering}
							/>
						) : (
							<Textarea
								value={answer}
								onChange={(e) => setAnswer(e.target.value)}
								placeholder={t("answerPlaceholder")}
								rows={3}
								aria-label={t("answerLabel")}
								disabled={isAnswering}
							/>
						)}
						<div className="flex items-center justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								onClick={() => setActiveId(null)}
								disabled={isAnswering}
							>
								{t("cancel")}
							</Button>
							{/* Only offered once somebody is named: "as per @Sam,
							    ninety days" is an answer, "ninety days, right
							    @Sam?" is not, and the text cannot tell them
							    apart. With no mention there is one button and
							    the behaviour is exactly as before. */}
							{mentioned.length > 0 && (
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => {
										onSetAssignees?.(
											thread.root.id,
											[
												...assignees.map((a) => a.id),
												...mentioned,
											],
											answer.trim(),
										);
										setActiveId(null);
									}}
									disabled={
										isAnswering ||
										settingAssigneesId === thread.root.id
									}
								>
									{t("askMention", {
										names: formatAskNames(mentionedNames),
									})}
								</Button>
							)}
							<Button
								type="button"
								size="sm"
								onClick={() => submit(thread.root.questionId)}
								disabled={isAnswering || !answer.trim()}
								className="gap-1.5"
							>
								{isAnswering && (
									<Loader2 className="size-3.5 animate-spin" />
								)}
								{isAnswering
									? t("answering")
									: t("answerSubmit")}
							</Button>
						</div>
					</div>
				) : hasSuggestions ? (
					<div className="mt-3 space-y-2">
						<p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
							<SparklesIcon className="size-3 text-primary" />
							{t("suggestedAnswersLabel")}
						</p>
						<ul className="space-y-2">
							{options.map((opt) => (
								<li key={opt.text} className="relative">
									{/* Accept and Edit are siblings, not nested:
									    the accept affordance is itself a button,
									    so Edit cannot live inside it. The pencil
									    is only PAINTED inside, by positioning it
									    over the corner `pr-10` reserves below —
									    same DOM, two independent hit targets. */}
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => {
											if (thread.root.questionId) {
												onAnswer(
													thread.root.questionId,
													opt.text,
													{
														answerSource:
															"AI_SUGGESTED",
													},
												);
											}
										}}
										disabled={isAnswering}
										className="h-auto w-full flex-col items-start gap-0.5 whitespace-normal py-2 pr-10 text-left"
									>
										<span className="text-xs font-medium">
											{opt.text}
										</span>
										{opt.justification && (
											<span className="text-[11px] font-normal text-muted-foreground">
												{opt.justification}
											</span>
										)}
									</Button>
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												onClick={() =>
													open(
														thread.root.id,
														opt.text,
													)
												}
												disabled={isAnswering}
												// Several Edit controls render at
												// once, so a bare "Edit" is
												// ambiguous to a screen reader —
												// name the suggestion. The tooltip
												// is for sighted pointer users;
												// this is the real name.
												aria-label={t(
													"editSuggestionAria",
													{ text: opt.text },
												)}
												// Visible at rest rather than
												// revealed on hover: a hover-only
												// icon does not exist on touch.
												// `hover:bg-transparent` stops the
												// ghost fill painting a second
												// rectangle over the card.
												className="absolute top-1 right-1 size-7 text-muted-foreground opacity-70 transition-[color,opacity] hover:bg-transparent hover:text-foreground hover:opacity-100 focus-visible:opacity-100"
											>
												<Pencil className="size-3.5" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="left">
											{t("editSuggestion")}
										</TooltipContent>
									</Tooltip>
								</li>
							))}
						</ul>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => open(thread.root.id)}
							disabled={isAnswering}
							className="text-xs"
						>
							{t("typeYourOwn")}
						</Button>
					</div>
				) : (
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => open(thread.root.id)}
						className="mt-3 text-xs"
					>
						{t("answerLabel")}
					</Button>
				)}
			</li>
		);
	};

	const submit = (questionId: string | null) => {
		if (!answer.trim() || !questionId) {
			return;
		}
		const typed = answer.trim();
		onAnswer(questionId, typed, {
			summary,
			// Three outcomes, decided by what the field was seeded with (#1907):
			// no seed means nothing was taken from the AI, so MANUAL — this covers
			// "type your own" even when suggestions were on offer. A seed saved
			// untouched is a plain acceptance (AI_SUGGESTED), not an edit. Only a
			// seed the PO actually changed is AI_EDITED.
			answerSource:
				editingSeed === null
					? "MANUAL"
					: typed === editingSeed.trim()
						? "AI_SUGGESTED"
						: "AI_EDITED",
		});
	};

	return (
		<div className="mx-auto max-w-3xl space-y-8">
			<section aria-labelledby="maturation-digest-heading">
				<div className="flex items-center justify-between gap-4 pb-1">
					<h2
						id="maturation-digest-heading"
						className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
					>
						{t("digestHeading")}
					</h2>
					<ReadinessBar
						signals={{
							hasFullSpec: Boolean(
								summaryDigest &&
									summaryDigest.trim().length > 0,
							),
							hasAcceptanceCriteria: Boolean(
								hasAcceptanceCriteria ??
									(summaryDigest &&
										/acceptance\s+criteria|\bgiven\b.*\bwhen\b.*\bthen\b/i.test(
											summaryDigest,
										)),
							),
							blockingGapCount:
								blockingGapCount ??
								openQuestions.filter(
									(t) =>
										t.root.topic === "Gaps & Blockers" ||
										t.root.topic === "Blocking Gaps" ||
										/\bblocking\b|\bblocker\b/i.test(
											t.root.summary ?? "",
										),
								).length,
							isSpecRecentlyUpdated:
								isSpecRecentlyUpdated ??
								Boolean(
									summaryDigest &&
										summaryDigest.trim().length > 0,
								),
							hasFunctionalRequirements: Boolean(
								hasFunctionalRequirements ??
									(summaryDigest &&
										/functional\s+requirements|FR-\d+|FR\d+|\bFRs?\b/i.test(
											summaryDigest,
										)),
							),
							resolvedQuestionsCount: resolvedQuestionsCount ?? 0,
							openQuestionsCount: openQuestions.length,
							storyKind,
							hasExpectedResult,
							hasActualResult,
							needsMoreInfo,
						}}
						isAiMode={isAiMode}
						isAiEvaluating={isAiEvaluating}
						aiResult={aiResult}
						onToggleAiMode={onToggleAiMode}
					/>
				</div>
				<div className="mt-3 rounded-lg border bg-card p-4">
					{summaryDigest ? (
						<Markdown className="leading-relaxed text-foreground">
							{summaryDigest}
						</Markdown>
					) : isGenerating ? (
						// #1796: a deliberate "generating" state — a labelled header
						// plus a content skeleton shaped like the digest — so first
						// load reads as work-in-progress, not a bare inline spinner
						// mistaken for a button. Swaps out the moment the digest lands.
						<output className="block space-y-3" aria-live="polite">
							<div className="flex items-center gap-2 text-sm font-medium text-foreground">
								<Loader2 className="size-4 animate-spin text-primary" />
								<span>{t("digestGenerating")}</span>
								<span className="flex gap-1" aria-hidden="true">
									<span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
									<span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
									<span className="size-1 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
								</span>
							</div>
							<div className="space-y-2" aria-hidden="true">
								<Skeleton className="h-3 w-full" />
								<Skeleton className="h-3 w-[92%]" />
								<Skeleton className="h-3 w-[80%]" />
								<Skeleton className="h-3 w-[45%]" />
							</div>
						</output>
					) : (
						<p className="text-sm text-muted-foreground">
							{t("digestEmpty")}
						</p>
					)}
				</div>
			</section>

			<section aria-labelledby="maturation-questions-heading">
				<div className="flex items-center gap-2">
					<h2
						id="maturation-questions-heading"
						className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
					>
						{t("questionsHeading")}
					</h2>
					{openQuestions.length > 0 && (
						<Badge
							variant="warning"
							className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
							aria-label={t("unresolvedCount", {
								count: openQuestions.length,
							})}
						>
							{openQuestions.length}
						</Badge>
					)}
					{onToggleAutoPropose && (
						/* The trigger is the label + switch group, not the label
						   alone: a bare <span> never takes focus, so keyboard users
						   would never see the hint. Wrapping the group means
						   focusing the Switch opens it too. */
						<Tooltip>
							<TooltipTrigger asChild>
								<div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
									<span>{t("autoProposeLabel")}</span>
									<Switch
										checked={autoProposeAnswers}
										onCheckedChange={onToggleAutoPropose}
										disabled={togglingAutoPropose}
										aria-label={t("autoProposeLabel")}
									/>
								</div>
							</TooltipTrigger>
							<TooltipContent>
								{tTooltip("autoProposeHint")}
							</TooltipContent>
						</Tooltip>
					)}
				</div>

				{/* Status tally (AC-20) — who is blocked on what, at a glance.
				    Only meaningful once assignment is wired, so it rides the same
				    switch as the controls themselves. */}
				{questionAssignees && openQuestions.length > 0 && (
					<div className="mt-2 flex flex-wrap items-center gap-1.5">
						<Badge
							variant="secondary"
							className="text-[11px] font-normal"
						>
							{t("countAnswered", {
								count: statusCounts.answered,
							})}
						</Badge>
						<Badge
							variant="outline"
							className="text-[11px] font-normal"
						>
							{t("countAssigned", {
								count: statusCounts.assigned,
							})}
						</Badge>
						<Badge
							variant="outline"
							className="text-[11px] font-normal"
						>
							{t("countUnanswered", {
								count: statusCounts.unanswered,
							})}
						</Badge>
					</div>
				)}

				{openQuestions.length === 0 ? (
					<p className="mt-3 text-sm text-muted-foreground">
						{t("questionsEmpty")}
					</p>
				) : isGrouped ? (
					<div className="mt-3 space-y-6">
						{questionGroups.map((group) => (
							<div key={group.topic}>
								{/* Editorial topic header — uppercase, wide
								    tracking, thin red bar (`.editorial-label`). */}
								<h3 className="editorial-label text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
									{group.topic}
								</h3>
								<ul className="mt-2 space-y-3">
									{group.items.map(renderThread)}
								</ul>
							</div>
						))}
					</div>
				) : (
					<ul className="mt-3 space-y-3">
						{openQuestions.map(renderThread)}
					</ul>
				)}
			</section>

			{/* Possibly resolved (#5) — questions the latest refresh no longer lists.
			    Collapsed by default; each is restorable, none are deleted. */}
			{possiblyResolvedQuestions.length > 0 && (
				<section aria-labelledby="maturation-possibly-resolved-heading">
					<div className="flex items-center gap-2">
						<h2
							id="maturation-possibly-resolved-heading"
							className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
						>
							{t("possiblyResolvedHeading")}
						</h2>
						<Badge
							variant="secondary"
							className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
						>
							{possiblyResolvedQuestions.length}
						</Badge>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="ml-auto text-xs"
							onClick={() => setShowPossiblyResolved((v) => !v)}
							aria-expanded={showPossiblyResolved}
						>
							{showPossiblyResolved
								? t("hidePossiblyResolved")
								: t("showPossiblyResolved", {
										count: possiblyResolvedQuestions.length,
									})}
						</Button>
					</div>
					{showPossiblyResolved && (
						<>
							<p className="mt-2 text-xs text-muted-foreground">
								{t("possiblyResolvedHint")}
							</p>
							<ul className="mt-3 space-y-3">
								{possiblyResolvedQuestions.map((thread) => {
									const isRestoring =
										restoringId === thread.root.id;
									return (
										<li
											key={thread.root.id}
											className="rounded-lg border bg-muted/40 p-3"
										>
											<p className="text-sm text-muted-foreground">
												{thread.root.summary ??
													thread.root.content ??
													""}
											</p>
											<Button
												type="button"
												variant="outline"
												size="sm"
												onClick={() =>
													onRestoreQuestion?.(
														thread.root.id,
													)
												}
												disabled={
													isRestoring ||
													!onRestoreQuestion
												}
												className="mt-3 gap-1.5 text-xs"
											>
												{isRestoring && (
													<Loader2 className="size-3.5 animate-spin" />
												)}
												{isRestoring
													? t("restoring")
													: t("restore")}
											</Button>
										</li>
									);
								})}
							</ul>
						</>
					)}
				</section>
			)}

			{/* Notes — the human's notebook. Free-text, human-owned; the AI never
			    writes here. Saved on blur via `setWorkingNotes`. */}
			<section aria-labelledby="maturation-notes-heading">
				<h2
					id="maturation-notes-heading"
					className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground"
				>
					{t("notesHeading")}
				</h2>
				<p className="mt-1 text-xs text-muted-foreground">
					{t("notesHint")}
				</p>
				<Textarea
					value={notes}
					onChange={(e) => setNotes(e.target.value)}
					onBlur={commitNotes}
					placeholder={t("notesPlaceholder")}
					aria-label={t("notesHeading")}
					className="mt-3 min-h-[160px] resize-y"
				/>
			</section>
		</div>
	);
}
