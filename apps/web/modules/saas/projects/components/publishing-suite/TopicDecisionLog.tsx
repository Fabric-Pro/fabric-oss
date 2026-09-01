"use client";

import { cn } from "@ui/lib";
import {
	CheckCircle2Icon,
	ChevronDownIcon,
	CircleDashedIcon,
	SparklesIcon,
} from "lucide-react";
import { useState } from "react";
import type { TopicDecisionThread } from "./TopicQuestionsPanel";

type Filter = "all" | "OPEN" | "RESOLVED";

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
	{ key: "all", label: "All" },
	{ key: "OPEN", label: "Open" },
	{ key: "RESOLVED", label: "Resolved" },
];

type Props = {
	threads: TopicDecisionThread[];
	isLoading?: boolean;
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
 * settled by anyone (see `reconcileTopicQuestions`) — are hidden from the
 * Summary & Questions tab, but the log is the full history, so they render
 * here with their own status marker instead of folding into Open or
 * Resolved.
 */
export function TopicDecisionLog({ threads, isLoading = false }: Props) {
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
		<section className="space-y-5">
			<div className="flex items-center justify-between gap-3">
				<h2 className="editorial-label">Decision log</h2>
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
						<DecisionCard key={thread.root.id} thread={thread} />
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
						<h3 className="editorial-label">AI Updates</h3>
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
 * any, beneath it. Unlike the maturation sibling, this table carries no
 * `authorName` / `sourceProvenance` columns, so attribution here is limited
 * to what the row actually stores: who raised it (always the AI) and who
 * answered it (always the answering project member, per
 * `answerTopicQuestion`) — never a name, since the table does not record one.
 */
function DecisionCard({ thread }: { thread: TopicDecisionThread }) {
	const root = thread.root;
	const answer = thread.replies.find(
		(r) => r.content !== null && r.content.trim().length > 0,
	);
	const createdAt = new Date(root.createdAt);

	return (
		<li
			data-testid="decision-root"
			className="space-y-2 rounded-lg border border-border bg-card p-4"
		>
			<div className="flex items-start justify-between gap-2">
				<p className="text-foreground text-sm leading-relaxed">
					{root.summary ?? root.content ?? ""}
				</p>
				<StatusMarker status={root.status} />
			</div>
			<div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
				<AuthorLabel authorType={root.authorType} />
				<time dateTime={createdAt.toISOString()}>
					{createdAt.toLocaleString()}
				</time>
			</div>
			{answer ? (
				<div className="border-border border-t pt-2">
					<p className="text-foreground text-sm leading-relaxed">
						{answer.content}
					</p>
				</div>
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

function AuthorLabel({ authorType }: { authorType: "USER" | "AGENT" }) {
	if (authorType === "AGENT") {
		return (
			<span className="inline-flex items-center gap-1 font-medium text-foreground">
				<SparklesIcon className="size-3" aria-hidden="true" />
				AI
			</span>
		);
	}
	return <span className="font-medium text-foreground">Team member</span>;
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
