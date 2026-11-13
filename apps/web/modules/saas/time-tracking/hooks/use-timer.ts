"use client";

import type { TimeActivity } from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { StoryRef } from "../lib/entry-draft";
import { invalidateTimeEntries } from "../lib/time-tracking-api";
import {
	conflictTimer,
	type TimerPreference,
	type TimerView,
	timerRefetchInterval,
} from "../lib/timer-model";
import { browserTimeZone } from "../lib/zoned-time";

/** Same-browser tabs tell each other the timer changed on this channel. */
const TIMER_CHANNEL = "fabric-time-timer";

/** While a timer exists, how often a tab rereads it for other devices. */
const SLOW_REFETCH_MS = 60_000;

let channel: BroadcastChannel | null = null;

function timerChannel(): BroadcastChannel | null {
	if (typeof BroadcastChannel === "undefined") {
		return null;
	}
	channel ??= new BroadcastChannel(TIMER_CHANNEL);
	return channel;
}

/** Tell the browser's other tabs to reread the timer and the entries. */
export function broadcastTimerChange(): void {
	timerChannel()?.postMessage("changed");
}

/** What a new timer runs on. */
export interface TimerStartValues {
	projectId: string;
	activity: TimeActivity;
	story: StoryRef | null;
}

/**
 * A request to open the widget from elsewhere in the page: a start button
 * while a timer runs, or the reminder. `stop` opens it at the stop question;
 * `startNext` starts another timer once this one is saved.
 */
interface TimerOpenRequest {
	stop?: boolean;
	startNext?: TimerStartValues;
}

type OpenListener = (request: TimerOpenRequest) => void;

const openListeners = new Set<OpenListener>();

export function requestTimerOpen(request: TimerOpenRequest = {}): void {
	for (const listener of openListeners) {
		listener(request);
	}
}

/** Receive open requests; the widget is the one listener. */
export function useTimerOpenRequests(listener: OpenListener): void {
	const latest = useRef(listener);
	latest.current = listener;
	useEffect(() => {
		const forward: OpenListener = (request) => latest.current(request);
		openListeners.add(forward);
		return () => {
			openListeners.delete(forward);
		};
	}, []);
}

function timerQueryKey(organizationId: string) {
	return orpc.timeTracking.timer.get.queryKey({ input: { organizationId } });
}

/**
 * The caller's timer and timer preferences in an organization, shared by
 * every component that reads them. Reread when the window regains focus, and
 * once a minute while a timer exists so a change on another device arrives,
 * in a hidden tab too while reminders are on.
 * `fetchedAt` is when this copy arrived; the elapsed time counts from it.
 */
export function useTimer(organizationId: string | null) {
	const query = useQuery({
		...orpc.timeTracking.timer.get.queryOptions({
			input: { organizationId: organizationId ?? "" },
		}),
		enabled: organizationId !== null,
		refetchOnWindowFocus: true,
		refetchIntervalInBackground: true,
		refetchInterval: (current) =>
			timerRefetchInterval({
				hasTimer: Boolean(current.state.data?.timer),
				remindersOn:
					current.state.data?.preference?.timerReminders ?? false,
				tabVisible:
					typeof document === "undefined" ||
					document.visibilityState === "visible",
				intervalMs: SLOW_REFETCH_MS,
			}),
	});
	return {
		timer: query.data?.timer ?? null,
		preference: query.data?.preference ?? null,
		fetchedAt: query.dataUpdatedAt,
	};
}

/**
 * Reread the timer and the entries when another tab of this browser changes
 * them. Mounted once, by the widget.
 */
export function useTimerSync(): void {
	const queryClient = useQueryClient();
	useEffect(() => {
		const source = timerChannel();
		if (!source) {
			return;
		}
		const reread = () => {
			void queryClient.invalidateQueries({
				queryKey: orpc.timeTracking.timer.key(),
			});
			void invalidateTimeEntries(queryClient);
		};
		source.addEventListener("message", reread);
		return () => source.removeEventListener("message", reread);
	}, [queryClient]);
}

/**
 * The current time, renewed every `intervalMs` while `ticking` and the page
 * is visible. Only the text that reads it changes; nothing animates.
 */
export function useTimerClock(ticking: boolean, intervalMs = 1000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		if (!ticking) {
			return;
		}
		let interval: number | undefined;
		const stop = () => {
			if (interval !== undefined) {
				window.clearInterval(interval);
				interval = undefined;
			}
		};
		const follow = () => {
			stop();
			if (document.visibilityState === "visible") {
				setNow(Date.now());
				interval = window.setInterval(
					() => setNow(Date.now()),
					intervalMs,
				);
			}
		};
		follow();
		document.addEventListener("visibilitychange", follow);
		return () => {
			stop();
			document.removeEventListener("visibilitychange", follow);
		};
	}, [ticking, intervalMs]);
	return now;
}

/** What a change to the timer's fields sends; fields left out are kept. */
export type TimerPatch = Omit<
	Parameters<typeof orpcClient.timeTracking.timer.update>[0],
	"organizationId" | "timerId" | "version"
>;

type TimerChange =
	| { kind: "pause" | "resume" | "discard"; timer: TimerView }
	| { kind: "update"; timer: TimerView; patch: TimerPatch };

async function sendTimerChange(
	organizationId: string,
	change: TimerChange,
): Promise<TimerView | null> {
	const target = {
		organizationId,
		timerId: change.timer.id,
		version: change.timer.version,
	};
	switch (change.kind) {
		case "pause":
			return (await orpc.timeTracking.timer.pause.call(target)).timer;
		case "resume":
			return (await orpc.timeTracking.timer.resume.call(target)).timer;
		case "update":
			return (
				await orpc.timeTracking.timer.update.call({
					...target,
					...change.patch,
				})
			).timer;
		case "discard":
			await orpc.timeTracking.timer.discard.call(target);
			return null;
		default: {
			const unhandled: never = change;
			throw new Error(`Unhandled timer change: ${String(unhandled)}`);
		}
	}
}

/**
 * Every change to the caller's timer and preferences. Each answer replaces
 * the cached timer and tells the other tabs; a CONFLICT adopts the timer it
 * carries (the view was stale) instead of failing.
 */
export function useTimerActions(organizationId: string) {
	const t = useTranslations("timeTracking.timer");
	const queryClient = useQueryClient();
	const queryKey = timerQueryKey(organizationId);

	const adopt = (timer: TimerView | null, preference?: TimerPreference) => {
		queryClient.setQueryData(queryKey, (current) => {
			const nextPreference = preference ?? current?.preference;
			return nextPreference
				? { timer, preference: nextPreference }
				: current;
		});
		broadcastTimerChange();
	};

	/** Adopt a conflicting timer, or report the failure; true when adopted. */
	const recover = (
		error: unknown,
		failure: "changeFailed" | "startFailed" | "stopFailed",
		conflict: "changedElsewhere" | "alreadyRunning",
	): boolean => {
		const current = conflictTimer(error);
		if (current) {
			adopt(current);
			toast.info(t(conflict));
			return true;
		}
		void queryClient.invalidateQueries({ queryKey });
		toast.error(t(failure));
		return false;
	};

	const change = useMutation({
		mutationFn: (request: TimerChange) =>
			sendTimerChange(organizationId, request),
		onSuccess: (timer, request) => {
			adopt(timer);
			if (request.kind === "discard") {
				toast.success(t("discarded"));
			}
		},
		onError: (error) => {
			recover(error, "changeFailed", "changedElsewhere");
		},
	});

	const start = useMutation({
		mutationFn: (values: TimerStartValues) =>
			orpc.timeTracking.timer.start.call({
				organizationId,
				projectId: values.projectId,
				activity: values.activity,
				storyId: values.story?.id ?? null,
				timezone: browserTimeZone(),
			}),
		onSuccess: (result) => {
			adopt(result.timer, result.preference);
			// With the widget off nothing else on screen says it started.
			if (result.preference.timerWidget === "OFF") {
				toast.success(t("started"));
			}
		},
		onError: (error) => {
			if (recover(error, "startFailed", "alreadyRunning")) {
				requestTimerOpen();
			}
		},
	});

	const preference = useMutation({
		mutationFn: (
			patch: Pick<
				Parameters<
					typeof orpcClient.timeTracking.timer.setPreference
				>[0],
				"timerWidget" | "timerReminders"
			>,
		) =>
			orpc.timeTracking.timer.setPreference.call({
				organizationId,
				...patch,
			}),
		onSuccess: (result) => {
			queryClient.setQueryData(queryKey, (current) =>
				current
					? { ...current, preference: result.preference }
					: current,
			);
			broadcastTimerChange();
		},
		onError: () => {
			toast.error(t("settings.saveFailed"));
		},
	});

	return {
		isChanging: change.isPending,
		isStarting: start.isPending,
		change: change.mutate,
		/** Resolves true once started; failures are already reported. */
		start: (values: TimerStartValues): Promise<boolean> =>
			start.mutateAsync(values).then(
				() => true,
				() => false,
			),
		/** Resolves the saved preferences, or null when saving failed. */
		setPreference: (
			patch: Parameters<typeof preference.mutateAsync>[0],
		): Promise<TimerPreference | null> =>
			preference.mutateAsync(patch).then(
				(result) => result.preference,
				() => null,
			),
		/** Put a timer (or none) in the cache and tell the other tabs. */
		adopt,
		recover,
	};
}
