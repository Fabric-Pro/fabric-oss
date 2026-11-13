"use client";

import { cn } from "@ui/lib";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useTimer, useTimerClock } from "../hooks/use-timer";
import { type TimerDotState, timerDotState } from "../lib/timer-model";

const DOT_CLASSES: Readonly<Record<TimerDotState, string>> = {
	running: "bg-primary",
	paused: "border-2 border-primary bg-transparent",
	long: "bg-highlight",
	saved: "bg-success",
};

/**
 * The timer's state as a dot: solid while running, a hollow ring while
 * paused, amber once the running segment passed eight hours, emerald when
 * saved. Decorative; the label beside it (or an `sr-only` text) says it.
 */
export function TimerDot({
	state,
	className,
}: {
	state: TimerDotState;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2 shrink-0 rounded-full",
				DOT_CLASSES[state],
				className,
			)}
		/>
	);
}

/** The nav checks the amber threshold once a minute, not every second. */
const NAV_CLOCK_MS = 60_000;

/**
 * The dot the My time nav item carries while a timer is running or paused,
 * whatever the widget preference: the safety net when the widget is hidden.
 * `undefined` when there is no timer (or no organization).
 */
export function useTimerNavIndicator(
	organizationId: string | null,
): { node: ReactNode; label: string } | undefined {
	const t = useTranslations("timeTracking.timer.nav");
	const { timer, fetchedAt } = useTimer(organizationId);
	const now = useTimerClock(timer?.status === "RUNNING", NAV_CLOCK_MS);
	if (!timer) {
		return undefined;
	}
	const state = timerDotState(timer, fetchedAt, now);
	return {
		node: (
			<TimerDot
				state={state}
				className="-right-1 -top-1 pointer-events-none absolute ring-2 ring-card"
			/>
		),
		label: t(state),
	};
}
