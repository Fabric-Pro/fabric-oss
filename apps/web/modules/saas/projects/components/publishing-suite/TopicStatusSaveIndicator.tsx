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
 */
export function TopicStatusSaveIndicator({
	state,
	className,
}: {
	state: TopicStatusSaveState;
	className?: string;
}) {
	return (
		<output
			aria-live="polite"
			data-testid="topic-status-save-indicator"
			className={cn(
				"inline-flex shrink-0 items-center gap-1 text-xs",
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
