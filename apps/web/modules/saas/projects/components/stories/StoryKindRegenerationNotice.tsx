"use client";

/**
 * The work item detail view's in-flight state for the body redraft a type
 * conversion starts (Fizzy #2048).
 *
 * It sits directly above the description / acceptance-criteria region, because
 * that region is what is about to be replaced, and it is the only surface that
 * can say so in full — the roadmap card and the board kebab never render the
 * body, so they carry a compact badge instead
 * (`StoryKindRegenerationBadge`).
 *
 * A refusal is reported here too, and that is the whole point of the component
 * existing for the failure case: a regeneration that fails leaves the previous
 * body intact, which on screen is indistinguishable from one that never
 * started. Without this panel the user is told the type changed and is left to
 * discover on their own that the content did not follow.
 *
 * Accessibility, mirroring `DuplicateResolveDialog`'s pairing in this same
 * directory: the spinner is `motion-safe:` so it does not animate under
 * `prefers-reduced-motion`, and the announcement lives in a polite live region
 * that is mounted at all times — a live region that appears WITH its text is
 * unreliably announced, so the region is always present and only its content
 * changes. On completion focus moves to the panel heading, which is the
 * heading of the body that just changed; leaving focus on the convert control
 * would strand it on a button that has re-rendered under a different label.
 */

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { CheckIcon, Loader2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import type { StoryKindRegenerationState } from "./useStoryKindRegeneration";

type NoticeTone = "running" | "completed" | "failed";

function resolveTone(state: StoryKindRegenerationState): NoticeTone | null {
	if (state.isRunning) {
		return "running";
	}
	if (state.justCompleted) {
		return "completed";
	}
	if (state.hasRecentFailure) {
		return "failed";
	}
	return null;
}

export function StoryKindRegenerationNotice({
	state,
	className,
}: {
	state: StoryKindRegenerationState;
	className?: string;
}) {
	const t = useTranslations("projects.stories.convertKind");
	const headingId = useId();
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [dismissedTone, setDismissedTone] = useState<NoticeTone | null>(null);

	const tone = resolveTone(state);

	// Move focus to the body's heading exactly once, when the redraft lands.
	const focusedForCompletionRef = useRef(false);
	useEffect(() => {
		if (tone !== "completed") {
			focusedForCompletionRef.current = false;
			return;
		}
		if (focusedForCompletionRef.current) {
			return;
		}
		focusedForCompletionRef.current = true;
		headingRef.current?.focus();
	}, [tone]);

	// A dismissal applies to the state that was dismissed, not to the item —
	// a later failure must still get through.
	useEffect(() => {
		setDismissedTone((current) => (current === tone ? current : null));
	}, [tone]);

	const announcement =
		tone === "running"
			? t("announceStarted")
			: tone === "completed"
				? t("announceCompleted")
				: tone === "failed"
					? t("announceFailed")
					: "";

	const visible = tone !== null && dismissedTone !== tone;

	return (
		<div className={className}>
			{/* Always mounted, so the text below is a CHANGE inside an existing
			    polite region rather than a region that appears already full. */}
			<output className="sr-only" aria-live="polite">
				{announcement}
			</output>

			{visible && tone !== null ? (
				<section
					className={cn(
						"mx-6 mt-3 flex shrink-0 items-start gap-3 rounded-lg border px-4 py-3",
						tone === "running" && "border-primary/40 bg-primary/10",
						tone === "completed" &&
							"border-secondary/40 bg-secondary/10",
						tone === "failed" &&
							"border-destructive/40 bg-destructive/10",
					)}
					aria-labelledby={headingId}
					aria-busy={tone === "running" ? true : undefined}
					data-testid="story-kind-regeneration-notice"
					data-tone={tone}
				>
					<span className="mt-0.5 shrink-0" aria-hidden="true">
						{tone === "running" ? (
							<Loader2Icon className="size-4 text-primary motion-safe:animate-spin" />
						) : tone === "completed" ? (
							<CheckIcon className="size-4 text-secondary" />
						) : (
							<TriangleAlertIcon className="size-4 text-destructive" />
						)}
					</span>

					<div className="min-w-0 flex-1">
						<h2
							id={headingId}
							ref={headingRef}
							tabIndex={-1}
							className="text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
						>
							{tone === "running"
								? t("inFlightTitle")
								: tone === "completed"
									? t("completedTitle")
									: t("failedTitle")}
						</h2>
						<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
							{tone === "running"
								? t("inFlightBody")
								: tone === "completed"
									? t("completedBody")
									: t("failedBody")}
						</p>
						{tone === "failed" && state.error ? (
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">
								{t("failedReason", { reason: state.error })}
							</p>
						) : null}
					</div>

					{tone !== "running" ? (
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-6 shrink-0 text-muted-foreground"
							aria-label={t("dismiss")}
							onClick={() => setDismissedTone(tone)}
						>
							<XIcon className="size-3.5" />
						</Button>
					) : null}
				</section>
			) : null}
		</div>
	);
}
