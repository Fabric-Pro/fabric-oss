"use client";

import { cn } from "@ui/lib";
import { CheckIcon, CircleAlertIcon, Loader2Icon } from "lucide-react";
import type { TopicStatusSaveState } from "./use-topic-status-overlay";

/**
 * "Saving… / Saved / Not saved" beside a topic's status control (Fizzy #2646).
 *
 * ALWAYS mounted, empty at rest: a live region inserted at the moment its
 * text appears is not reliably announced, so the region exists first and
 * only its content changes. `<output>` carries the implicit `status` role.
 * Words carry the meaning; the icons are decoration and colour is never the
 * only signal.
 *
 * Callers render it AFTER the status control. From `sm` up, `reserveWidth`
 * gives it a FIXED 80 px box, so the text coming and going cannot change the
 * cluster's width or move the control. Measured labels: "Saving…" 64.7 px,
 * "Saved" 51.1 px, "Not saved" 73.3 px. Fixed rather than `min-w`: a wider
 * fallback font or text scaling overflows the box instead of widening it and
 * pushing a right-anchored cluster. No box below `sm`: the Inbox control is
 * full-width there, and 80 px would leave it too narrow for "In progress".
 * Instead, below `sm` each caller puts the control's cluster on a left-aligned
 * line with nothing after the note, so the control's left edge stays put: a
 * fixed-width control does not move, and a full-width one narrows from its
 * right end while the note shows.
 * A label never wraps either way — a second line would change the height.
 */
export function TopicStatusSaveIndicator({
	state,
	reserveWidth = false,
	className,
}: {
	state: TopicStatusSaveState;
	/** Hold a fixed-width slot from `sm` up. For editable controls only — a
	 * viewer's control is disabled, so the slot would be dead space. */
	reserveWidth?: boolean;
	className?: string;
}) {
	return (
		<output
			aria-live="polite"
			data-testid="topic-status-save-indicator"
			className={cn(
				"inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs",
				reserveWidth && "sm:w-20",
				state === "error"
					? "text-destructive"
					: "text-muted-foreground",
				className,
			)}
		>
			{state === "saving" ? (
				<>
					<Loader2Icon
						className="size-3 motion-safe:animate-spin"
						aria-hidden="true"
					/>
					Saving…
				</>
			) : null}
			{state === "saved" ? (
				<>
					<CheckIcon className="size-3" aria-hidden="true" />
					Saved
				</>
			) : null}
			{state === "error" ? (
				<>
					<CircleAlertIcon className="size-3" aria-hidden="true" />
					Not saved
				</>
			) : null}
		</output>
	);
}
