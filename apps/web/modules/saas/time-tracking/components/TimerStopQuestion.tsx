"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { TimerStopState } from "../hooks/use-timer-stop";
import {
	clockLabel,
	describeActivityAction,
	pickedStopAt,
} from "../lib/timer-model";
import { wallClockInZone } from "../lib/zoned-time";

type TimerQuestion = Extract<TimerStopState, { phase: "question" }>;

/**
 * The forgotten-timer question: the timer ran long past the caller's last
 * action in Fabric, so Stop asks when work stopped instead of saving all of
 * it. The proposed time comes with where it came from; Stop now and a picked
 * time (from the running segment's start to now) stay one click away.
 */
export function TimerStopQuestion({
	question,
	openStartAt,
	timeZone,
	busy,
	onStop,
	onCancel,
}: {
	question: TimerQuestion;
	/** The running segment's start, the earliest stop a pick may name. */
	openStartAt: string;
	timeZone: string;
	busy: boolean;
	/** Stop at this instant; `undefined` is now. */
	onStop: (stopAt: string | undefined) => void;
	onCancel: () => void;
}) {
	const t = useTranslations("timeTracking.timer.question");
	const tAction = useTranslations("timeTracking.timer");
	const id = useId();
	const [picking, setPicking] = useState(false);
	const [picked, setPicked] = useState("");
	const [invalid, setInvalid] = useState(false);

	const proposedTime = clockLabel(question.proposedStopAt, timeZone);
	const startTime = clockLabel(openStartAt, timeZone);
	const now = new Date().toISOString();
	// A segment within one day can bound the input; across midnight the
	// browser's min/max cannot say "yesterday 18:00 to now", so the pick is
	// checked on submit instead.
	const sameDay =
		wallClockInZone(openStartAt, timeZone).date ===
		wallClockInZone(now, timeZone).date;

	const reading = question.source
		? describeActivityAction(question.source.action)
		: null;
	const action = reading
		? tAction(`actions.${reading.verb}`, {
				object: tAction(`objects.${reading.object}`),
			})
		: t("yourLastAction");

	const submitPick = () => {
		const stopAt = pickedStopAt({
			time: picked,
			openStartAt,
			nowMs: Date.now(),
			timeZone,
		});
		if (!stopAt) {
			setInvalid(true);
			return;
		}
		onStop(stopAt);
	};

	return (
		<fieldset
			aria-labelledby={`${id}-title`}
			className="space-y-2 rounded-md border border-highlight/40 bg-highlight/10 p-3 text-sm"
		>
			{question.source ? (
				<>
					<p id={`${id}-title`} className="font-semibold">
						{t("title", { time: proposedTime })}
					</p>
					<p className="text-muted-foreground text-xs">
						{t("lastAction", {
							action,
							time: clockLabel(question.source.at, timeZone),
						})}
					</p>
				</>
			) : (
				<p id={`${id}-title`} className="font-semibold">
					{t("noActivity")}
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				{question.source ? (
					<Button
						type="button"
						size="sm"
						disabled={busy}
						onClick={() => onStop(question.proposedStopAt)}
					>
						{t("stopAt", { time: proposedTime })}
					</Button>
				) : null}
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={busy}
					onClick={() => onStop(undefined)}
				>
					{t("stopNow")}
				</Button>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					aria-expanded={picking}
					aria-controls={`${id}-pick`}
					onClick={() => setPicking((open) => !open)}
				>
					{t("pickTime")}
				</Button>
			</div>
			{picking ? (
				<form
					id={`${id}-pick`}
					className="flex flex-wrap items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						submitPick();
					}}
				>
					<Input
						type="time"
						aria-label={t("pickLabel")}
						aria-invalid={invalid}
						aria-describedby={invalid ? `${id}-invalid` : undefined}
						value={picked}
						min={sameDay ? startTime : undefined}
						max={sameDay ? clockLabel(now, timeZone) : undefined}
						onChange={(event) => {
							setPicked(event.target.value);
							setInvalid(false);
						}}
						className="w-28 tabular-nums"
					/>
					<Button
						type="submit"
						size="sm"
						variant="outline"
						disabled={busy || !picked}
					>
						{t("pickSave")}
					</Button>
					{invalid ? (
						<p
							id={`${id}-invalid`}
							role="alert"
							className="w-full text-destructive text-xs"
						>
							{t("pickInvalid", { start: startTime })}
						</p>
					) : null}
				</form>
			) : null}
			<Button
				type="button"
				size="xs"
				variant="ghost"
				disabled={busy}
				onClick={onCancel}
			>
				{t("cancel")}
			</Button>
		</fieldset>
	);
}
