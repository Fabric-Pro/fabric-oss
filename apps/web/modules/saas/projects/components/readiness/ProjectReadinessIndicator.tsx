"use client";

import { cn } from "@ui/lib";
import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectReadiness } from "./ProjectReadinessProvider";

/**
 * The persistent readiness indicator in the project header (Fizzy #2165).
 *
 * Sits BESIDE the existing status badge rather than replacing it. The card asks
 * for the status-label area, but Draft / Active / Completed / Archived carries
 * its own meaning that readiness does not subsume — a Ready project can still be
 * a draft, and an archived one can still be fully set up.
 *
 * Renders nothing only when the feature is off. A project with no phase set is
 * still graded — against an inferred phase, flagged "assumed" — because hiding
 * the indicator made the whole feature invisible on every project predating it.
 */
export function ProjectReadinessIndicator() {
	const t = useTranslations("readiness");
	const readiness = useProjectReadiness();
	if (!readiness) {
		return null;
	}

	const { data, isExpanded, setExpanded } = readiness;
	if (!data?.enabled) {
		return null;
	}

	const tone =
		data.level === "READY"
			? {
					dot: "bg-secondary",
					text: "text-muted-foreground",
					label: t("level.READY"),
				}
			: data.level === "PARTIALLY_READY"
				? {
						dot: "bg-highlight",
						text: "text-foreground",
						label: t("level.PARTIALLY_READY"),
					}
				: {
						// `destructive`, not `primary`: this theme resolves
						// `--primary` to a teal, so a "not ready" dot sat next to
						// a "ready" emerald as two greens. See the panel's
						// LEVEL_TONE for the full note.
						dot: "bg-destructive",
						text: "text-foreground",
						label: t("level.NOT_READY"),
					};

	const gapCount = data.activeGaps.length;
	// An assumed phase must never look like a chosen one.
	const assumed = data.phaseSource === "inferred";

	return (
		<button
			type="button"
			onClick={() => setExpanded(!isExpanded)}
			aria-expanded={isExpanded}
			aria-label={`Project readiness: ${tone.label}. ${
				gapCount === 0 ? "No open items." : `${gapCount} open items.`
			} Select to ${isExpanded ? "collapse" : "expand"} the checklist.`}
			className={cn(
				"inline-flex items-center gap-2 rounded-full border border-border/60 px-2.5 py-1",
				"text-xs transition-colors hover:bg-accent focus-visible:outline-none",
				"focus-visible:ring-2 focus-visible:ring-ring",
				tone.text,
			)}
		>
			<span
				className={cn("size-2 rounded-full", tone.dot)}
				aria-hidden="true"
			/>
			<span>{tone.label}</span>
			{assumed && (
				<span className="text-muted-foreground text-[10px] uppercase tracking-wider">
					assumed
				</span>
			)}
			{data.level !== "READY" && gapCount > 0 && (
				<span className="text-muted-foreground tabular-nums">
					{gapCount}
				</span>
			)}
			{/* The panel collapses into this pill, and on the 20 Aug review a
			    collapsed panel had no visible way back — nothing said this was
			    the control that reopens it. A chevron that points the way it
			    will move says so without copy. */}
			<ChevronDownIcon
				className={cn(
					"size-3 text-muted-foreground motion-safe:transition-transform",
					isExpanded && "rotate-180",
				)}
				aria-hidden="true"
			/>
		</button>
	);
}
