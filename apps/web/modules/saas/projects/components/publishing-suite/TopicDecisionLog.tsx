"use client";

import { Button } from "@ui/components/button";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	CircleDashedIcon,
	PencilLineIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import {
	AuthorLabel,
	emptyAnswerText,
	hasUsableAnswer,
	liveAnswerReply,
	QuestionNotes,
	supersededAnswerReplies,
	type TopicDecisionThread,
	useAmendAnswer,
} from "./TopicQuestionsPanel";

type Filter = "all" | "OPEN" | "RESOLVED";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "OPEN", label: "Open" },
	{ key: "RESOLVED", label: "Resolved" },
];

type Props = {
	threads: TopicDecisionThread[];
	isLoading?: boolean;
	/**
	 * Amending happens HERE as well as on Summary & Questions — the same
	 * placement Feature Maturation uses, and for the reason the log exists: it
	 * is where you read a decision, so it is where you notice it is wrong.
	 * Until now the log was read-only and the pencil lived one tab away.
	 */
	projectId: string;
	topicId: string;
	organizationId: string | null;
	canEdit?: boolean;
};

/**
 * The Decision Log tab — the topic's decision-thread rows (Publishing Suite
 * Phase 2A-3, FR43–FR47, Fizzy #1851), the SAME `decisionsQuery` Task 6's
 * `TopicQuestionsPanel` answers from, read here as a filterable,
 * reverse-chronological history instead of a worklist. One query, two tabs —
 * a second fetch would let them disagree about the same rows.
 *
 * Mirrors the Feature Maturation `DecisionLogPanel` (IN5): newest-first
 * roots, an All/Open/Resolved filter, and AI Updates in their own
 * collapsed-by-default group. Two deliberate departures from that sibling:
 *
 *  - The default filter is RESOLVED, not "all" — the log is the changelog of
 *    settled decisions; open items live (and stay answerable) on the
 *    Summary & Questions tab, and stay reachable here only via the filter.
 *  - The AI Updates group is keyed off the real `root.kind === "AI_UPDATE"`
 *    column, not the sibling's sentinel `impactedSection` string — this
 *    table has a column for it, so no sentinel is needed.
 *
 * `POSSIBLY_RESOLVED` roots — soft-closed by reconciliation rather than
 * settled by anyone (see `reconcileTopicQuestions`) — render on Summary &
 * Questions in their own collapsed group, and here with their own status
 * marker instead of folding into Open or Resolved.
 */
export function TopicDecisionLog({
	threads,
	isLoading = false,
	projectId,
	topicId,
	organizationId,
	canEdit = false,
}: Props) {
	// One hook, shared with `TopicQuestionsPanel`, so the stale handling and
	// the toasts cannot drift apart between the two tabs that offer this.
	const { submitAmendment, isAmending } = useAmendAnswer({
		projectId,
		topicId,
		organizationId,
	});
	// The log is the changelog of settled decisions, not a parking lot for
	// unanswered questions — those live on the Summary & Questions tab. Open
	// items stay reachable via the filter.
	const [filter, setFilter] = useState<Filter>("RESOLVED");
	// A regeneration note is history, not a decision. Interleaving it expanded
	// buries the decisions the log exists to show.
	const [aiUpdatesOpen, setAiUpdatesOpen] = useState(false);

	if (isLoading) {
		return (
			<div
				data-testid="topic-decision-log-loading"
				className="space-y-3"
				aria-busy="true"
			>
				<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
				<div className="h-16 rounded-lg bg-muted motion-safe:animate-pulse" />
			</div>
		);
	}

	if (threads.length === 0) {
		return (
			<EmptyState>No decisions recorded for this topic yet.</EmptyState>
		);
	}

	// Reverse-chronological (newest first), then narrowed by the active
	// status filter.
	const sorted = [...threads].sort(
		(a, b) =>
			new Date(b.root.createdAt).getTime() -
			new Date(a.root.createdAt).getTime(),
	);
	const filtered =
		filter === "all"
			? sorted
			: sorted.filter((th) => th.root.status === filter);

	const decisions = filtered.filter((th) => th.root.kind !== "AI_UPDATE");
	const aiUpdates = filtered.filter((th) => th.root.kind === "AI_UPDATE");

	return (
		<TooltipProvider>
			{/* NO width cap, deliberately — see the panel-width test. The
			    cap was carried over from `DecisionLogPanel`, which is mounted
			    in a narrow column; here it pinned a tab panel to 768px and
			    centred it, leaving a gutter that detached the log from the tab
			    bar above it. The reading measure comes from the two columns
			    below instead, which is what "it does not need full width"
			    actually asked for: a readable line, not a narrower page. */}
			<section className="space-y-5">
				<div className="flex items-center justify-between gap-3">
					<h2 className="publishing-label">Decision log</h2>
					{/* biome-ignore lint/a11y/useSemanticElements: a filter toggle group, not a form fieldset */}
					<div
						className="inline-flex items-center rounded-md border border-border p-0.5"
						role="group"
						aria-label="Filter decisions"
					>
						{FILTERS.map((f) => (
							<button
								key={f.key}
								type="button"
								onClick={() => setFilter(f.key)}
								aria-pressed={filter === f.key}
								className={cn(
									"rounded px-2.5 py-1 text-xs transition-colors",
									filter === f.key
										? "bg-accent font-medium text-foreground"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{f.label}
							</button>
						))}
					</div>
				</div>

				{decisions.length > 0 ? (
					<ol className="space-y-2">
						{decisions.map((thread) => (
							<DecisionCard
								key={thread.root.id}
								thread={thread}
								canEdit={canEdit}
								isSubmitting={isAmending}
								onAmend={(supersedesId, text) =>
									submitAmendment(thread, supersedesId, text)
								}
							/>
						))}
					</ol>
				) : (
					<p className="text-muted-foreground text-sm">
						{filterEmptyMessage(filter)}
					</p>
				)}

				{aiUpdates.length > 0 ? (
					<section aria-label="AI updates">
						<button
							type="button"
							onClick={() => setAiUpdatesOpen((open) => !open)}
							aria-expanded={aiUpdatesOpen}
							aria-controls="decision-log-ai-updates"
							className="flex w-full items-center gap-2 py-1 text-left"
						>
							<ChevronDownIcon
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground transition-transform",
									!aiUpdatesOpen && "-rotate-90",
								)}
								aria-hidden="true"
							/>
							<h3 className="publishing-label">AI Updates</h3>
							<span className="text-[11px] text-muted-foreground/70">
								{aiUpdates.length}
							</span>
						</button>
						{aiUpdatesOpen ? (
							<ol
								id="decision-log-ai-updates"
								className="mt-2 space-y-2"
							>
								{aiUpdates.map((thread) => (
									<AiUpdateCard
										key={thread.root.id}
										thread={thread}
									/>
								))}
							</ol>
						) : null}
					</section>
				) : null}
			</section>
		</TooltipProvider>
	);
}

function filterEmptyMessage(filter: Filter): string {
	switch (filter) {
		case "OPEN":
			return "No open decisions.";
		case "RESOLVED":
			return "No resolved decisions yet.";
		default:
			return "No decisions recorded for this topic yet.";
	}
}

/**
 * A single decision — the question (+ status + who/when) with its answer, if
 * any, beneath it.
 *
 * This comment used to say the table records no author name and that `AuthorLabel`
 * could therefore only ever print a generic string. That was true when the log
 * shipped and is not true now: the `author` relation is on the wire and
 * `AuthorLabel` renders `author.name`, falling back to a generic label only for
 * a row that genuinely has none. The stale sentence outlived the fix and was
 * later cited in review as evidence of a defect that did not exist — so state
 * what the code does, and check it before repeating it.
 *
 * Still genuinely absent, unlike the maturation sibling: `sourceProvenance`.
 * There is no chip here saying which meeting or document a decision came from.
 *
 * An AMENDED question has more than one answer. The log is the changelog, so
 * it shows the current answer (`liveAnswerReply`) in the same place it always
 * did and the earlier ones beneath as history — the append-only record is the
 * whole reason amending supersedes rather than edits. The notes asked on the
 * question sit in the question's own column: they are not answers, current or
 * previous.
 */
function DecisionCard({
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
	const answer = liveAnswerReply(thread);
	const usableAnswer = hasUsableAnswer(answer);
	const superseded = supersededAnswerReplies(thread);
	const createdAt = new Date(root.createdAt);
	const [isEditing, setIsEditing] = useState(false);
	const [draft, setDraft] = useState("");

	/**
	 * Amend a RESOLVED QUESTION only.
	 *
	 * RESOLVED, matching `DecisionLogPanel`: a question nobody has settled —
	 * open or set aside — is answered on Summary & Questions, and
	 * `amendTopicQuestionAnswer` refuses it as `not_found`. QUESTION, because
	 * that function looks roots up by `kind: "QUESTION"`: a blocker's answer
	 * renders here too, and a pencil on it failed with "Could not save your
	 * answer" on every try.
	 */
	const canAmend =
		canEdit && root.kind === "QUESTION" && root.status === "RESOLVED";

	/**
	 * Close on SUCCESS, never on submit — the rule `AnsweredCard` documents.
	 * A `stale` amendment is refused, and the textarea then holds the only copy
	 * of what the person wrote; closing eagerly would throw it away while the
	 * toast announced that nothing had been saved.
	 */
	const saveAmendment = async (supersedesId: string) => {
		try {
			const result = await onAmend(supersedesId, draft);
			if (result?.status !== "stale") {
				setIsEditing(false);
			}
		} catch {
			// The hook's `onError` has already said so; keep the draft.
		}
	};

	return (
		<li
			data-testid="decision-root"
			className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2 sm:gap-4"
		>
			{/* Two columns, question left and answer right, the shape
			    `DecisionLogPanel` uses. Stacked at full page width a decision
			    read as two unrelated paragraphs and the eye had to find which
			    answer belonged to which question; side by side the pairing is
			    the layout. Falls back to one column below `sm`, where two
			    would be two narrow columns instead of one readable one. */}
			<div className="min-w-0 space-y-2">
				<div className="flex items-start justify-between gap-2">
					<p className="text-foreground text-sm leading-relaxed">
						{root.summary ?? root.content ?? ""}
					</p>
					<StatusMarker status={root.status} />
				</div>
				<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
					<AuthorLabel
						authorType={root.authorType}
						author={root.author}
					/>
					{/* Where the question CAME FROM, which the log had no way
					    of saying. This table has no `sourceProvenance` column
					    like its maturation sibling, but it does record which
					    analysis raised a root — and "the run that asked this"
					    is the provenance question a reader actually has when a
					    decision looks stale. */}
					{root.authorType === "AGENT" &&
					root.analysisVersion !== null ? (
						<span className="rounded-full border border-border px-2 py-0.5">
							Analysis v{root.analysisVersion}
						</span>
					) : null}
					<time dateTime={createdAt.toISOString()}>
						{createdAt.toLocaleString()}
					</time>
				</div>
				{/* In the QUESTION column, not beside it: a direct child of the
				    grid <li> would be placed in the answer column. */}
				<QuestionNotes thread={thread} />
			</div>
			{answer ? (
				<div className="min-w-0 space-y-2 sm:border-border sm:border-l sm:pl-4">
					{isEditing ? (
						<>
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
									onClick={() => saveAmendment(answer.id)}
									disabled={
										isSubmitting ||
										draft.trim().length === 0
									}
								>
									Save answer
								</Button>
							</div>
						</>
					) : (
						<div className="flex items-start justify-between gap-2">
							<div
								className="min-w-0"
								data-testid="decision-answer"
							>
								<p className="text-foreground text-sm leading-relaxed">
									{usableAnswer
										? answer.content
										: emptyAnswerText(canAmend)}
								</p>
								{/* The DECISION's author, which is the one a
								    reader is looking for. The root above is the
								    AI raising the question; the reply is the
								    person settling it, and on an amended thread
								    it is the person who settled it LAST. */}
								<p className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
									<AuthorLabel
										authorType={answer.authorType}
										author={answer.author}
									/>
									<time
										dateTime={new Date(
											answer.createdAt,
										).toISOString()}
									>
										{new Date(
											answer.createdAt,
										).toLocaleString()}
									</time>
								</p>
							</div>
							{canAmend ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="shrink-0"
											aria-label={`Amend the answer to "${root.subject ?? root.content ?? "this decision"}"`}
											onClick={() => {
												setDraft(
													answer.content?.trim() ??
														"",
												);
												setIsEditing(true);
											}}
										>
											<PencilLineIcon
												className="size-3.5"
												aria-hidden="true"
											/>
										</Button>
									</TooltipTrigger>
									<TooltipContent side="left">
										Amend
									</TooltipContent>
								</Tooltip>
							) : null}
						</div>
					)}
				</div>
			) : null}
			{superseded.length > 0 ? (
				<ol
					className="space-y-1 border-border border-l-2 pl-3"
					aria-label="Previous answers"
				>
					{superseded.map((reply) => (
						<li key={reply.id}>
							<p className="text-muted-foreground text-xs leading-relaxed line-through">
								{reply.content}
							</p>
							<time
								className="text-[11px] text-muted-foreground/70"
								dateTime={new Date(
									reply.createdAt,
								).toISOString()}
							>
								{new Date(reply.createdAt).toLocaleString()}
							</time>
						</li>
					))}
				</ol>
			) : null}
		</li>
	);
}

/**
 * A run-history note ("Questions after regeneration: …"), rendered as a
 * single sentence — the reconciler writes one line
 * (`reconcileTopicQuestions`), not the maturation table's newline-joined
 * change bullets, so there is nothing to split into a list.
 *
 * `root.summary` — "Planning analysis v<n>" — is the version-change summary
 * FR47 names; without it the card showed only the sentence below and never
 * said which regeneration produced it.
 */
function AiUpdateCard({ thread }: { thread: TopicDecisionThread }) {
	const root = thread.root;
	const createdAt = new Date(root.createdAt);

	return (
		<li
			data-testid="decision-root"
			className="space-y-1.5 rounded-lg border border-border bg-card p-3"
		>
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
				<span className="inline-flex items-center gap-1 font-medium text-foreground">
					<SparklesIcon className="size-3" aria-hidden="true" />
					AI
				</span>
				<time dateTime={createdAt.toISOString()}>
					{createdAt.toLocaleString()}
				</time>
			</div>
			<p className="font-medium text-foreground text-xs">
				{root.summary}
			</p>
			<p className="text-foreground text-sm leading-relaxed">
				{root.content}
			</p>
		</li>
	);
}

/**
 * Resolved/open/possibly-resolved marker — icon + text so the state is
 * announced to screen readers and sighted users alike, never conveyed by
 * colour alone (WCAG 2.1 AA).
 */
function StatusMarker({ status }: { status: string }) {
	switch (status) {
		case "RESOLVED":
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-secondary text-xs font-medium">
					<CheckCircle2Icon className="size-3.5" aria-hidden="true" />
					Resolved
				</span>
			);
		case "OPEN":
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-highlight text-xs font-medium">
					<CircleDashedIcon className="size-3.5" aria-hidden="true" />
					Open
				</span>
			);
		default:
			// POSSIBLY_RESOLVED — the only other status this table writes
			// (`reconcileTopicQuestions`). Soft-closed, not settled, so it gets
			// its own marker rather than being folded into Open or Resolved.
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground text-xs font-medium">
					<CircleDashedIcon className="size-3.5" aria-hidden="true" />
					Possibly resolved
				</span>
			);
	}
}

function EmptyState({ children }: { children: React.ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed bg-muted/40 p-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
