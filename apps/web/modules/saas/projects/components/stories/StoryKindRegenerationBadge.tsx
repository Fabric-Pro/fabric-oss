"use client";

/**
 * Compact card-level state for the body redraft a type conversion starts
 * (Fizzy #2048).
 *
 * The roadmap card and the board kebab never render the description or the
 * acceptance criteria, so "show the in-flight state over the body" is not
 * something either surface can do. They show this chip on the card instead:
 * the item is being rewritten, or the rewrite was refused and the content the
 * card is summarising is still the old type's.
 *
 * `role="status"` makes the chip its own polite live region, so it announces
 * when it appears and when it changes without every card carrying a
 * permanently mounted region.
 */

import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { StoryKindRegenerationState } from "./useStoryKindRegeneration";

export function StoryKindRegenerationBadge({
	state,
}: {
	state: StoryKindRegenerationState;
}) {
	const t = useTranslations("projects.stories.convertKind");

	if (!state.isRunning && !state.hasRecentFailure) {
		return null;
	}

	const running = state.isRunning;
	const label = running ? t("badgeRunning") : t("badgeFailed");
	const description = running ? t("badgeRunningAria") : t("badgeFailedAria");

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					{/* `<output>` carries an implicit polite live region, so the
					    chip announces itself when it appears without every card
					    on the roadmap holding a permanently mounted one. */}
					<output
						aria-label={description}
						data-testid="story-kind-regeneration-badge"
						data-state={running ? "running" : "failed"}
						className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
							running
								? "border-primary/40 bg-primary/10 text-primary"
								: "border-destructive/40 bg-destructive/10 text-destructive"
						}`}
					>
						{running ? (
							<Loader2Icon
								className="size-3 motion-safe:animate-spin"
								aria-hidden="true"
							/>
						) : (
							<TriangleAlertIcon
								className="size-3"
								aria-hidden="true"
							/>
						)}
						{label}
					</output>
				</TooltipTrigger>
				<TooltipContent>
					{running ? t("inFlightBody") : t("failedBody")}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
