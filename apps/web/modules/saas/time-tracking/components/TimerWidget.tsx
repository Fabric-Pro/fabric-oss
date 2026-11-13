"use client";

import { formatDurationMinutes } from "@repo/utils/time-tracking";
import { useIsGuestInOrg } from "@saas/organizations/hooks/use-is-guest-in-org";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { cn } from "@ui/lib";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
	broadcastTimerChange,
	type TimerStartValues,
	useTimer,
	useTimerActions,
	useTimerClock,
	useTimerOpenRequests,
	useTimerSync,
} from "../hooks/use-timer";
import { useTimerReminder } from "../hooks/use-timer-reminder";
import { useTimerStop } from "../hooks/use-timer-stop";
import { invalidateTimeEntries } from "../lib/time-tracking-api";
import {
	formatElapsed,
	type SavedTimer,
	type TimerDotState,
	type TimerPreference,
	timerDotState,
	timerElapsedAt,
	widgetContent,
} from "../lib/timer-model";
import { readSavedTimer, writeSavedTimer } from "../lib/timer-storage";
import { browserTimeZone } from "../lib/zoned-time";
import { TimerDot } from "./TimerDot";
import { TimerPanel } from "./TimerPanel";
import { TimerSavedPanel } from "./TimerSavedPanel";

/**
 * The running timer's widget, mounted once in the app shell: a chip in the
 * shell's bottom-right dock (`dockSlot`) that opens upward into a panel.
 *
 * The dock floats over every page, so the chip never takes a page's own
 * header space, which on some pages (the dashboard) holds controls. Only an
 * organization member's own timer shows; a guest's My time is in their own
 * organization.
 */
export function TimerWidget({ dockSlot }: { dockSlot: HTMLElement | null }) {
	const { organizationId, isOrgContext, basePath } = useOrganizationContext();
	const isGuest = useIsGuestInOrg();
	if (!isOrgContext || isGuest || !organizationId) {
		return null;
	}
	return (
		<TimerWidgetBody
			key={organizationId}
			organizationId={organizationId}
			basePath={basePath}
			dockSlot={dockSlot}
		/>
	);
}

function TimerWidgetBody({
	organizationId,
	basePath,
	dockSlot,
}: {
	organizationId: string;
	basePath: string;
	dockSlot: HTMLElement | null;
}) {
	const t = useTranslations("timeTracking.timer");
	const router = useRouter();
	const queryClient = useQueryClient();
	const { timer, preference, fetchedAt } = useTimer(organizationId);
	const actions = useTimerActions(organizationId);
	useTimerSync();
	useTimerReminder({ organizationId, timer, preference, fetchedAt });

	const [timeZone, setTimeZone] = useState("UTC");
	const [saved, setSaved] = useState<SavedTimer | null>(null);
	useEffect(() => {
		setTimeZone(browserTimeZone());
		setSaved(readSavedTimer(organizationId));
	}, [organizationId]);
	const keepSaved = (next: SavedTimer | null) => {
		setSaved(next);
		writeSavedTimer(next);
	};

	// A timer that starts (here, in another tab or on another device)
	// replaces the last one's outcome.
	const timerId = timer?.id ?? null;
	useEffect(() => {
		if (timerId) {
			setSaved(null);
			writeSavedTimer(null);
		}
	}, [timerId]);

	const [open, setOpen] = useState(false);
	const [revealed, setRevealed] = useState(false);
	const [undoing, setUndoing] = useState(false);
	/** The timer to start once this one is stopped ("stop it and start here"). */
	const pendingStart = useRef<TimerStartValues | null>(null);

	const startPending = () => {
		const next = pendingStart.current;
		pendingStart.current = null;
		if (next) {
			void actions.start(next);
		}
	};

	const stopper = useTimerStop({
		organizationId,
		timer,
		actions,
		onSaved: (outcome) => {
			keepSaved(outcome);
			startPending();
		},
		onDiscarded: startPending,
	});
	const cancelStop = () => {
		pendingStart.current = null;
		stopper.cancel();
	};

	useTimerOpenRequests((request) => {
		setRevealed(true);
		setOpen(true);
		if (request.startNext) {
			pendingStart.current = request.startNext;
			if (!timer) {
				startPending();
				return;
			}
		}
		if (
			(request.stop || request.startNext) &&
			timer &&
			stopper.state.phase === "idle"
		) {
			stopper.begin();
		}
	});

	const content = preference
		? widgetContent({
				hasTimer: timer !== null,
				hasSaved: saved !== null,
				widget: preference.timerWidget,
				revealed,
			})
		: "none";
	const now = useTimerClock(
		content === "timer" && timer?.status === "RUNNING",
	);

	const previousContent = useRef(content);
	useEffect(() => {
		const wasShown = previousContent.current !== "none";
		previousContent.current = content;
		if (content !== "none") {
			return;
		}
		setOpen(false);
		// Discarding or undoing from the panel removes the widget with the
		// control that held focus; hand focus to the page rather than leaving
		// it on the document body.
		if (wasShown && document.activeElement === document.body) {
			document.getElementById("main-content")?.focus();
		}
	}, [content]);

	const closeWidget = async (
		widget: Exclude<TimerPreference["timerWidget"], "SHOWN">,
	) => {
		const previous = preference?.timerWidget ?? "SHOWN";
		setOpen(false);
		setRevealed(false);
		const result = await actions.setPreference({ timerWidget: widget });
		if (!result) {
			return;
		}
		toast(
			t(widget === "OFF" ? "closeMenu.turnedOff" : "closeMenu.hidden"),
			{
				action: {
					label: t("closeMenu.undo"),
					onClick: () =>
						void actions.setPreference({ timerWidget: previous }),
				},
			},
		);
	};

	const undoSaved = async (outcome: SavedTimer) => {
		setUndoing(true);
		const results = await Promise.allSettled(
			outcome.entryIds.map((entryId) =>
				orpc.timeTracking.deleteEntry.call({ entryId }),
			),
		);
		const remaining = outcome.entryIds.filter(
			(_, index) => results[index]?.status === "rejected",
		);
		setUndoing(false);
		await invalidateTimeEntries(queryClient);
		broadcastTimerChange();
		if (remaining.length > 0) {
			keepSaved({ ...outcome, entryIds: remaining });
			toast.error(t("saved.undoFailed"));
			return;
		}
		keepSaved(null);
		setOpen(false);
		toast.success(t("saved.undone"));
	};

	if (content === "none") {
		return null;
	}

	const spokenDuration = (seconds: number) =>
		t("spokenDuration", {
			hours: Math.floor(seconds / 3600),
			minutes: Math.floor((seconds % 3600) / 60),
		});

	let chip: {
		dot: TimerDotState;
		time: string;
		project: string;
		label: string;
	};
	let panel: ReactNode;
	if (content === "timer" && timer) {
		const elapsed = timerElapsedAt(timer, fetchedAt, now);
		const dot = timerDotState(timer, fetchedAt, now);
		chip = {
			dot,
			time: formatElapsed(elapsed),
			project: timer.projectName,
			label: t("chipLabel", {
				state: t(`state.${dot}`),
				duration: spokenDuration(elapsed),
				project: timer.projectName,
			}),
		};
		panel = (
			<TimerPanel
				organizationId={organizationId}
				timer={timer}
				dot={dot}
				elapsedSeconds={elapsed}
				timeZone={timeZone}
				actions={actions}
				stopper={{ ...stopper, cancel: cancelStop }}
				onMinimize={() => setOpen(false)}
				onClose={(widget) => void closeWidget(widget)}
			/>
		);
	} else if (content === "saved" && saved) {
		chip = {
			dot: "saved",
			time: formatDurationMinutes(saved.totalMinutes),
			project: saved.projectName,
			label: t("chipLabel", {
				state: t("state.saved"),
				duration: spokenDuration(saved.totalMinutes * 60),
				project: saved.projectName,
			}),
		};
		panel = (
			<TimerSavedPanel
				saved={saved}
				busy={undoing || actions.isStarting}
				onStartAgain={() => {
					void actions
						.start({
							projectId: saved.projectId,
							activity: saved.activity,
							story: saved.story,
						})
						.then((started) => {
							if (started) {
								keepSaved(null);
							}
						});
				}}
				onOpenDay={() => {
					setOpen(false);
					router.push(
						`${basePath}/time?view=day&date=${saved.workDate}`,
					);
				}}
				onUndo={() => void undoSaved(saved)}
				onClose={() => {
					setOpen(false);
					setRevealed(false);
					keepSaved(null);
				}}
			/>
		);
	} else {
		return null;
	}

	const widget = (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) {
					setRevealed(false);
				}
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					aria-label={chip.label}
					className={cn(
						"inline-flex h-8 max-w-[18rem] items-center gap-2 rounded-full border border-border bg-card px-3 text-sm shadow-xs",
						"motion-safe:transition-colors motion-safe:duration-150 hover:bg-muted",
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
					)}
				>
					<TimerDot state={chip.dot} />
					<span className="font-semibold tabular-nums">
						{chip.time}
					</span>
					<span className="min-w-0 max-w-[9.5rem] truncate text-muted-foreground">
						{chip.project}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				side="top"
				aria-label={t("panelLabel")}
				className="w-[min(22.5rem,calc(100vw-2rem))]"
			>
				{panel}
			</PopoverContent>
		</Popover>
	);

	return dockSlot ? createPortal(widget, dockSlot) : null;
}
