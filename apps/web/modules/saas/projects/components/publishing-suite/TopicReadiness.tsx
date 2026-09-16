"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import type { TopicDecisionThread } from "./TopicQuestionsPanel";

/**
 * How close a topic is to being safe to draft from (Fizzy #1851).
 *
 * The PO asked for "a readiness bar, same as in feature maturation". This is
 * NOT `StageProgress`, and the difference is the reason a second component
 * exists: a feature moves through a fixed pipeline of named stages, so its bar
 * is positional — segment three of five means Sanity Check. A publishing topic
 * has no pipeline. What it has is a set of decisions the analysis raised, each
 * of which is answered or is not, and the honest "how close am I" signal is the
 * proportion answered rather than a position on a track it does not run on.
 *
 * The segments are borrowed from `StageProgress` on purpose, so the two read as
 * the same family of indicator even though they measure different things.
 */
export function TopicReadiness({
	threads,
	className,
}: {
	threads: TopicDecisionThread[];
	className?: string;
}) {
	// AI_UPDATE rows are the analysis narrating itself between versions; they
	// are not decisions anyone can answer, so counting them would make a topic
	// look less ready every time it regenerated. CONTENT_TYPE rows are left out
	// for the reason the questions panel, the Summary & Questions badge and the
	// assistant leave them out: they are the content-types checklist now,
	// nothing restricts on them, and a legacy one can be neither answered nor
	// restored — counting it would hold a topic "not ready" that nobody can make
	// ready.
	const questions = threads.filter(
		(t) =>
			t.root.kind === "QUESTION" &&
			t.root.decisionKind !== "CONTENT_TYPE",
	);
	const total = questions.length;

	if (total === 0) {
		return null;
	}

	// SETTLED, not necessarily ANSWERED — `RESOLVED` or `POSSIBLY_RESOLVED`.
	//
	// This is a REVERSAL. `POSSIBLY_RESOLVED` used to be excluded, on the
	// reasoning that nobody had answered it and the generation tab treats it as
	// unresolved, so counting it "would call a topic ready beside a tab that
	// says it is not".
	//
	// What that missed is that nothing can ever clear one. A soft-closed root
	// is not in the panel's open list — it sits collapsed under "Possibly
	// resolved" — and it returns to `OPEN` only if a later analysis raises the
	// same question again. So it sat in this denominator as permanently
	// unanswerable, and a topic carrying one could never reach 100%. One
	// observed topic read `21 of 28` with every live decision answered and all
	// seven strays left by a since-fixed subject-drift bug.
	//
	// Feature Maturation, which this mirrors on the same `DecisionStatus` enum,
	// has always counted it this way (`evaluate-ai-readiness.ts` puts it in
	// `resolvedQuestions`), and the enum's own comment calls it "dropped from
	// the active open list".
	//
	// The contradiction the old comment guarded against is real but narrower
	// than it looks: only a SAFETY-CRITICAL soft-closed question still badges a
	// generation tab, and answering it — which stays possible from the Decision
	// Log — clears both at once.
	const resolved = questions.filter(
		(t) =>
			t.root.status === "RESOLVED" ||
			t.root.status === "POSSIBLY_RESOLVED",
	).length;

	const open = total - resolved;
	const pct = Math.round((resolved / total) * 100);

	// Blockers are NOT decisions and stay out of the ratio — a blocker is a
	// thing the topic is missing, not a question anybody can answer, and
	// folding them into the denominator would make "answered" mean two things.
	//
	// But they cannot be ignored either. This sits directly below
	// `TopicBlockers`, and counting only questions let it read "All 6 decisions
	// answered" with two blockers open immediately above it — the page
	// contradicting itself in adjacent lines. So the ratio stays about
	// decisions and the ALL-CLEAR is withheld while a blocker is open.
	const openBlockers = threads.filter(
		(t) => t.root.kind === "BLOCKER" && t.root.status === "OPEN",
	).length;
	const allClear = open === 0 && openBlockers === 0;

	// Enough segments to read as progress, few enough to stay a glance.
	const SEGMENTS = 10;
	const filled = Math.round((resolved / total) * SEGMENTS);

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span
					className={cn("flex min-w-0 items-center gap-2", className)}
					data-testid="topic-readiness"
				>
					<span className="flex shrink-0 gap-0.5" aria-hidden="true">
						{Array.from({ length: SEGMENTS }, (_, i) => (
							<span
								key={i}
								className={cn(
									"h-1.5 w-3 rounded-full",
									i < filled
										? "bg-secondary"
										: "bg-muted-foreground/25",
								)}
							/>
						))}
					</span>
					{/* The number carries the meaning; the bar only reinforces
					    it, so the indicator survives being read without colour
					    (WCAG 2.1 AA). */}
					<span className="truncate text-muted-foreground text-xs">
						{allClear
							? `All ${total} decisions answered`
							: `${resolved} of ${total} decisions answered`}
						{openBlockers > 0
							? ` · ${openBlockers} blocking ${
									openBlockers === 1 ? "item" : "items"
								}`
							: ""}
					</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{allClear
					? "Every question the analysis raised has an answer. A draft can assert what they settled."
					: [
							open > 0
								? `${open} unanswered. A draft will write around each one — generalizing it, using a neutral placeholder, or leaving it out — rather than assert it. ${pct}% answered.`
								: `Every question has an answer (${pct}%).`,
							openBlockers > 0
								? `${openBlockers} blocking ${
										openBlockers === 1 ? "item" : "items"
									} still needed before this topic is ready.`
								: "",
						]
							.filter(Boolean)
							.join(" ")}
			</TooltipContent>
		</Tooltip>
	);
}
