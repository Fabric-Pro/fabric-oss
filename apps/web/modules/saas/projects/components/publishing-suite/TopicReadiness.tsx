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
	// look less ready every time it regenerated.
	const questions = threads.filter((t) => t.root.kind === "QUESTION");
	const total = questions.length;

	if (total === 0) {
		return null;
	}

	// POSSIBLY_RESOLVED means the newest analysis stopped raising a question
	// somebody had already answered. It is answered — soft-closing it is how
	// the reconciler avoids losing the answer, not a statement that it reopened.
	const resolved = questions.filter(
		(t) =>
			t.root.status === "RESOLVED" ||
			t.root.status === "POSSIBLY_RESOLVED",
	).length;

	const open = total - resolved;
	const pct = Math.round((resolved / total) * 100);

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
						{open === 0
							? `All ${total} decisions answered`
							: `${resolved} of ${total} decisions answered`}
					</span>
				</span>
			</TooltipTrigger>
			<TooltipContent>
				{open === 0
					? "Every question the analysis raised has an answer. A draft can assert what they settled."
					: `${open} unanswered. A draft will write around each one — generalizing it, using a neutral placeholder, or leaving it out — rather than assert it. ${pct}% answered.`}
			</TooltipContent>
		</Tooltip>
	);
}
