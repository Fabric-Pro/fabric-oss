"use client";

import { Markdown } from "@ui/components/markdown";
import { cn } from "@ui/lib";
import {
	CheckCircle2,
	ChevronDown,
	CircleDashed,
	FileText,
	Sparkles,
	XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import type { DecisionLogThread, DecisionStatus } from "./types";

type Props = {
	threads: DecisionLogThread[];
};

type Filter = "all" | "OPEN" | "RESOLVED";

/**
 * Sentinel `impactedSection` that buckets AGENT-authored change-summary notes
 * into their own "AI Updates" group (kept in sync with the same literal in the
 * API `record-change-note` procedure). These render as run-history notes, not
 * Q&A decisions, and the group is collapsed by default.
 */
const AI_UPDATES_SECTION = "AI Updates";

/**
 * Tab 2 — Decision Log (§10.1 / AC-3.1–AC-3.2). Threaded, reverse-chronological,
 * timestamped log — the human-readable changelog the PO reviews INSTEAD of a
 * 1k-row diff. Each root shows its status (icon + text, never color-only), author
 * (AI vs. you), the spec changes it produced ("Changed: …"), and its replies. A
 * status filter narrows to open vs. resolved.
 */
export function DecisionLogPanel({ threads }: Props) {
	const t = useTranslations("projects.stories.maturation.decisionLog");
	// Default to decisions only — the Decision Log is the changelog of settled
	// decisions, not a parking lot for unanswered questions (those live in the
	// Summary & Questions tab). Open items stay reachable via the filter.
	const [filter, setFilter] = useState<Filter>("RESOLVED");
	// Collapsed group keys. Groups are expanded by default; collapsing a settled
	// batch (e.g. "the 13 placeholder questions") keeps the log scannable.
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
		// The AI Updates run-history group starts collapsed (Option A).
		() => new Set([AI_UPDATES_SECTION]),
	);
	const toggleGroup = (key: string) =>
		setCollapsed((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});

	// Roots reverse-chronological (newest first, AC-3.2); filter by status.
	const sortedThreads = useMemo(() => {
		const sorted = [...threads].sort(
			(a, b) => b.root.createdAt.getTime() - a.root.createdAt.getTime(),
		);
		if (filter === "all") {
			return sorted;
		}
		return sorted.filter((th) => th.root.status === filter);
	}, [threads, filter]);

	// Group the (filtered) decisions by topic — `root.impactedSection`. A null
	// section falls into the "General" bucket, rendered last. Each group keeps the
	// reverse-chronological order within it; groups are ordered by their freshest
	// decision so the most-recently-touched topic sits on top.
	const groups = useMemo(() => {
		const byTopic = new Map<string | null, DecisionLogThread[]>();
		for (const th of sortedThreads) {
			const key = th.root.impactedSection;
			const bucket = byTopic.get(key);
			if (bucket) {
				bucket.push(th);
			} else {
				byTopic.set(key, [th]);
			}
		}
		return [...byTopic.entries()]
			.map(([section, items]) => ({ section, items }))
			.sort((a, b) => {
				if (a.section === null) {
					return 1;
				}
				if (b.section === null) {
					return -1;
				}
				return (
					b.items[0].root.createdAt.getTime() -
					a.items[0].root.createdAt.getTime()
				);
			});
	}, [sortedThreads]);

	const filters: { key: Filter; label: string }[] = [
		{ key: "all", label: t("filterAll") },
		{ key: "OPEN", label: t("filterOpen") },
		{ key: "RESOLVED", label: t("filterResolved") },
	];

	return (
		<div className="mx-auto max-w-3xl">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
					{t("heading")}
				</h2>
				{threads.length > 0 && (
					// biome-ignore lint/a11y/useSemanticElements: a filter toggle group, not a form fieldset
					<div
						className="inline-flex items-center rounded-md border p-0.5"
						role="group"
						aria-label={t("heading")}
					>
						{filters.map((f) => (
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
				)}
			</div>

			{threads.length === 0 ? (
				<p className="mt-3 text-sm text-muted-foreground">
					{t("empty")}
				</p>
			) : sortedThreads.length === 0 ? (
				<p className="mt-3 text-sm text-muted-foreground">
					{t("emptyFiltered")}
				</p>
			) : (
				<div className="mt-4 space-y-4">
					{groups.map((group) => {
						const key = group.section ?? "__general__";
						const label = group.section ?? t("generalGroup");
						const isCollapsed = collapsed.has(key);
						const regionId = `decision-group-${key}`;
						return (
							<section key={key} aria-label={label}>
								{/* Collapsible group header — editorial label + a
								    count, toggles its decisions. Keyboard-operable
								    button so the state is announced (aria-expanded). */}
								<button
									type="button"
									onClick={() => toggleGroup(key)}
									aria-expanded={!isCollapsed}
									aria-controls={regionId}
									className="flex w-full items-center gap-2 py-1 text-left"
								>
									<ChevronDown
										className={cn(
											"size-3.5 shrink-0 text-muted-foreground transition-transform",
											isCollapsed && "-rotate-90",
										)}
										aria-hidden="true"
									/>
									<h3 className="editorial-label text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
										{label}
									</h3>
									<span className="text-[11px] text-muted-foreground/70">
										{group.items.length}
									</span>
								</button>
								{!isCollapsed && (
									<ol
										id={regionId}
										className="mt-2 space-y-2"
									>
										{group.items.map((thread) => (
											<DecisionThreadCard
												key={thread.root.id}
												thread={thread}
											/>
										))}
									</ol>
								)}
							</section>
						);
					})}
				</div>
			)}
		</div>
	);
}

/**
 * A single decision thread card — compact two-column: the question (+ meta +
 * status) on the LEFT, the answer(s) on the RIGHT. Stacks on narrow screens. The
 * "Changed:" spec-propagation summary sits as a full-width footer when present.
 */
function DecisionThreadCard({ thread }: { thread: DecisionLogThread }) {
	const t = useTranslations("projects.stories.maturation.decisionLog");
	const changed = thread.root.cleanSpecPropagation?.appliedSummaries ?? [];

	// AI-update notes are run-history, not Q&A: render the change bullets (one per
	// line) with an "AI update" marker instead of the two-column question/answer.
	if (thread.root.impactedSection === AI_UPDATES_SECTION) {
		const bullets = (thread.root.content ?? "")
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean);
		return (
			<li className="rounded-lg border bg-card p-3">
				<div className="flex flex-wrap items-center gap-2">
					<span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
						{thread.root.authorName ? (
							thread.root.authorName
						) : (
							<>
								<Sparkles
									className="size-3"
									aria-hidden="true"
								/>
								{t("agent")}
							</>
						)}
					</span>

					{thread.root.sourceProvenance && (
						<span
							title={thread.root.sourceProvenance}
							className="inline-block align-middle max-w-[200px] truncate text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm"
						>
							{thread.root.sourceProvenance}
						</span>
					)}

					<time
						dateTime={thread.root.createdAt.toISOString()}
						className="text-xs text-muted-foreground"
					>
						{thread.root.createdAt.toLocaleString()}
					</time>
				</div>
				<ul className="mt-2 space-y-1">
					{bullets.map((b) => (
						<li
							key={b}
							className="flex gap-2 text-sm leading-snug text-foreground"
						>
							<span
								aria-hidden="true"
								className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
							/>
							<span>{b}</span>
						</li>
					))}
				</ul>
			</li>
		);
	}

	return (
		<li className="rounded-lg border bg-card p-3">
			<div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
				{/* Left — the question + who/when + status */}
				<div className="min-w-0">
					<div className="flex items-start justify-between gap-2">
						<p className="text-sm font-medium text-foreground">
							{thread.root.status === "FORMATTING_ONLY"
								? t("formattingOnly")
								: (thread.root.summary ??
									thread.root.content ??
									"")}
						</p>
						<StatusMarker status={thread.root.status} />
					</div>
					<div className="mt-1.5 flex flex-wrap items-center gap-2">
						<span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
							{thread.root.authorName ? (
								thread.root.authorName
							) : thread.root.authorType === "AGENT" ? (
								<>
									<Sparkles
										className="size-3"
										aria-hidden="true"
									/>
									{t("aiGenerated")}
								</>
							) : (
								t("unknownAuthor")
							)}
						</span>

						{thread.root.sourceProvenance ? (
							<span
								title={thread.root.sourceProvenance}
								className="inline-block align-middle max-w-[200px] truncate text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm"
							>
								{thread.root.sourceProvenance}
							</span>
						) : (
							<span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 italic">
								{t("unattributed")}
							</span>
						)}
						<time
							dateTime={thread.root.createdAt.toISOString()}
							className="text-xs text-muted-foreground"
						>
							{thread.root.createdAt.toLocaleString()}
						</time>
					</div>
				</div>

				{/* Right — the answer(s) */}
				<div className="min-w-0 sm:border-l sm:border-border sm:pl-4">
					{thread.replies.length > 0 ? (
						<ul className="space-y-2">
							{thread.replies.map((reply) => (
								<li key={reply.id} className="space-y-1">
									<Markdown className="leading-relaxed text-foreground">
										{reply.summary ?? reply.content ?? ""}
									</Markdown>
									<div className="mt-1 flex flex-wrap items-center gap-2">
										<span className="inline-flex items-center gap-1 text-xs text-foreground font-medium">
											{reply.authorName ? (
												reply.authorName
											) : reply.authorType === "AGENT" ? (
												<>
													<Sparkles
														className="size-3"
														aria-hidden="true"
													/>
													{t("aiGenerated")}
												</>
											) : (
												t("unknownAuthor")
											)}
										</span>

										{reply.sourceProvenance ? (
											<span
												title={reply.sourceProvenance}
												className="inline-block align-middle max-w-[200px] truncate text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-sm"
											>
												{reply.sourceProvenance}
											</span>
										) : (
											<span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60 italic">
												{t("unattributed")}
											</span>
										)}
									</div>
									<time
										dateTime={reply.createdAt.toISOString()}
										className="text-xs text-muted-foreground block mt-1"
									>
										{reply.createdAt.toLocaleString()}
									</time>
								</li>
							))}
						</ul>
					) : (
						<p
							className="text-xs text-muted-foreground/60"
							aria-hidden="true"
						>
							—
						</p>
					)}
				</div>
			</div>

			{changed.length > 0 && (
				<div className="mt-2 rounded-md bg-muted/50 px-3 py-2">
					<p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
						{t("changed")}
					</p>
					<ul className="mt-1 space-y-0.5">
						{changed.map((c) => (
							<li key={c} className="text-sm text-foreground">
								{c}
							</li>
						))}
					</ul>
				</div>
			)}
		</li>
	);
}

/**
 * Resolved/rejected/open/formatting marker — icon + text so the state is
 * announced to screen readers, not conveyed by color alone (§10.2).
 */
function StatusMarker({ status }: { status: DecisionStatus }) {
	const t = useTranslations("projects.stories.maturation.decisionLog");

	switch (status) {
		case "RESOLVED":
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-secondary">
					<CheckCircle2 className="size-3.5" aria-hidden="true" />
					{t("resolvedMarker")}
				</span>
			);
		case "REJECTED":
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-destructive">
					<XCircle className="size-3.5" aria-hidden="true" />
					{t("rejectedMarker")}
				</span>
			);
		case "FORMATTING_ONLY":
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
					<FileText className="size-3.5" aria-hidden="true" />
					{t("formattingOnly")}
				</span>
			);
		default:
			return (
				<span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-highlight">
					<CircleDashed className="size-3.5" aria-hidden="true" />
					{t("openMarker")}
				</span>
			);
	}
}
