"use client";

import type {
	TimeEntryWarning,
	TimeWarningCode,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { nextUnansweredWarning } from "../lib/entry-draft";
import { invalidateTimeEntries } from "../lib/time-tracking-api";
import {
	type SavedTimer,
	savedTimerFrom,
	stopStep,
	type TimerView,
} from "../lib/timer-model";
import { browserTimeZone } from "../lib/zoned-time";
import type { useTimerActions } from "./use-timer";

type TimerProposal = Awaited<
	ReturnType<typeof orpcClient.timeTracking.timer.proposeStop>
>;

/**
 * Where Stop is: reading the proposal, asking when work stopped (the
 * forgotten-timer question), saving, or asking about a warning the server
 * raised, one at a time, as a typed entry does.
 */
export type TimerStopState =
	| { phase: "idle" }
	| { phase: "proposing" }
	| {
			phase: "question";
			proposedStopAt: string;
			source: TimerProposal["source"];
	  }
	| { phase: "saving"; stopAt: string | undefined }
	| {
			phase: "warning";
			stopAt: string | undefined;
			warnings: TimeEntryWarning[];
			acknowledged: TimeWarningCode[];
	  };

/**
 * Stopping the caller's timer: `proposeStop` first, the question when it
 * asks, then `stop`, then the server's warning questions until it saves.
 */
export function useTimerStop(params: {
	organizationId: string;
	timer: TimerView | null;
	actions: ReturnType<typeof useTimerActions>;
	/** The timer was saved as entries. */
	onSaved: (saved: SavedTimer) => void;
	/** The timer stopped without saving (it ran under a minute). */
	onDiscarded: () => void;
}) {
	const t = useTranslations("timeTracking.timer");
	const queryClient = useQueryClient();
	const [state, setState] = useState<TimerStopState>({ phase: "idle" });
	const latest = useRef(params);
	latest.current = params;

	const fail = (error: unknown) => {
		setState({ phase: "idle" });
		latest.current.actions.recover(error, "stopFailed", "changedElsewhere");
	};

	const send = async (
		stopAt: string | undefined,
		acknowledged: TimeWarningCode[],
	) => {
		const { organizationId, timer, actions } = latest.current;
		if (!timer) {
			setState({ phase: "idle" });
			return;
		}
		setState({ phase: "saving", stopAt });
		try {
			const result = await orpc.timeTracking.timer.stop.call({
				organizationId,
				timerId: timer.id,
				version: timer.version,
				stopAt,
				timezone: browserTimeZone(),
				acknowledgedWarnings: acknowledged,
			});
			switch (result.status) {
				case "needs_confirmation":
					setState({
						phase: "warning",
						stopAt,
						warnings: result.warnings,
						acknowledged,
					});
					return;
				case "saved":
					setState({ phase: "idle" });
					actions.adopt(null);
					await invalidateTimeEntries(queryClient);
					latest.current.onSaved(
						savedTimerFrom({
							organizationId,
							timer,
							entries: result.entries,
						}),
					);
					return;
				case "discarded":
					setState({ phase: "idle" });
					actions.adopt(null);
					toast.info(t("nothingSaved"));
					latest.current.onDiscarded();
					return;
				default: {
					const unhandled: never = result;
					throw new Error(
						`Unhandled timer stop result: ${String(unhandled)}`,
					);
				}
			}
		} catch (error) {
			fail(error);
		}
	};

	const begin = async () => {
		setState({ phase: "proposing" });
		try {
			const proposal = await orpc.timeTracking.timer.proposeStop.call({
				organizationId: latest.current.organizationId,
			});
			const step = stopStep(proposal);
			switch (step.kind) {
				case "stopNow":
					await send(undefined, []);
					return;
				case "ask":
					setState({
						phase: "question",
						proposedStopAt: step.proposedStopAt,
						source: step.source,
					});
					return;
				default: {
					const unhandled: never = step;
					throw new Error(
						`Unhandled stop step: ${String(unhandled)}`,
					);
				}
			}
		} catch (error) {
			fail(error);
		}
	};

	const warning =
		state.phase === "warning"
			? nextUnansweredWarning(state.warnings, state.acknowledged)
			: null;

	return {
		state,
		/** The server's next unanswered objection, while one is open. */
		warning,
		busy: state.phase === "proposing" || state.phase === "saving",
		begin: () => void begin(),
		/** Stop at this instant; `undefined` is now. */
		stopAt: (stopAt: string | undefined) => void send(stopAt, []),
		confirmWarning: () => {
			if (state.phase !== "warning" || !warning) {
				return;
			}
			const acknowledged = [...state.acknowledged, warning.code];
			if (nextUnansweredWarning(state.warnings, acknowledged)) {
				setState({ ...state, acknowledged });
				return;
			}
			void send(state.stopAt, acknowledged);
		},
		cancel: () => setState({ phase: "idle" }),
	};
}
