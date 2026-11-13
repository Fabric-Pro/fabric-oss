"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import {
	clockLabel,
	openSegmentSeconds,
	reminderDue,
	reminderNeedsProposal,
	type TimerPreference,
	type TimerView,
} from "../lib/timer-model";
import {
	claimReminderCheck,
	rememberReminded,
	wasReminded,
} from "../lib/timer-storage";
import { browserTimeZone } from "../lib/zoned-time";
import { requestTimerOpen } from "./use-timer";

/** One tab of the browser holds this while it decides on a reminder. */
const REMINDER_LOCK = "fabric-time-timer-reminder";

async function withReminderLock(task: () => Promise<void>): Promise<void> {
	if (typeof navigator !== "undefined" && "locks" in navigator) {
		await navigator.locks.request(
			REMINDER_LOCK,
			{ ifAvailable: true },
			async (lock) => {
				if (lock) {
					await task();
				}
			},
		);
		return;
	}
	await task();
}

/**
 * The opt-in browser reminder of a running timer: once per timer, after its
 * running segment passes four hours or when Stop would ask when work
 * stopped, checked whenever the timer is reread (once a minute). Never for a
 * paused timer, never without permission, and from one tab only: the
 * decision runs under a Web Lock, and the reminded timers are shared through
 * local storage. Clicking it brings the tab forward with the widget open at
 * the stop question.
 */
export function useTimerReminder(params: {
	organizationId: string;
	timer: TimerView | null;
	preference: TimerPreference | null;
	fetchedAt: number;
}): void {
	const t = useTranslations("timeTracking.timer.reminder");
	const { organizationId, timer, fetchedAt } = params;
	const remindersOn = params.preference?.timerReminders ?? false;

	useEffect(() => {
		if (
			!timer ||
			timer.status !== "RUNNING" ||
			!remindersOn ||
			typeof Notification === "undefined" ||
			Notification.permission !== "granted" ||
			wasReminded(timer.id)
		) {
			return;
		}
		const openSeconds = openSegmentSeconds(timer, fetchedAt, Date.now());
		const needsProposal = reminderNeedsProposal(openSeconds);
		const dueAlready = reminderDue({
			status: timer.status,
			remindersOn,
			alreadyReminded: false,
			openSeconds,
			stopQuestionDue: false,
		});
		if (!dueAlready && !needsProposal) {
			return;
		}

		let cancelled = false;
		void withReminderLock(async () => {
			if (cancelled || wasReminded(timer.id)) {
				return;
			}
			let stopQuestionDue = false;
			if (!dueAlready) {
				if (!claimReminderCheck(Date.now())) {
					return;
				}
				try {
					const proposal =
						await orpc.timeTracking.timer.proposeStop.call({
							organizationId,
						});
					stopQuestionDue =
						proposal.timerId === timer.id && proposal.needsQuestion;
				} catch {
					return;
				}
			}
			if (
				cancelled ||
				!reminderDue({
					status: timer.status,
					remindersOn,
					alreadyReminded: wasReminded(timer.id),
					openSeconds,
					stopQuestionDue,
				})
			) {
				return;
			}
			rememberReminded(timer.id);
			const startedAt = timer.segments[0]?.startAt;
			const notification = new Notification(t("title"), {
				body: t("body", {
					project: timer.projectName,
					time: startedAt
						? clockLabel(startedAt, browserTimeZone())
						: "",
				}),
				tag: `fabric-time-timer-${timer.id}`,
			});
			notification.onclick = () => {
				window.focus();
				requestTimerOpen({ stop: true });
				notification.close();
			};
		});
		return () => {
			cancelled = true;
		};
	}, [organizationId, timer, fetchedAt, remindersOn, t]);
}
