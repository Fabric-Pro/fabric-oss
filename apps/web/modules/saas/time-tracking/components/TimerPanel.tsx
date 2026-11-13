"use client";

import { TIME_ACTIVITIES } from "@repo/utils/time-tracking";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	MinusIcon,
	PauseIcon,
	PlayIcon,
	SquareIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { TimerPatch, useTimerActions } from "../hooks/use-timer";
import type { useTimerStop } from "../hooks/use-timer-stop";
import {
	clockLabel,
	formatElapsed,
	openSegmentStart,
	type TimerDotState,
	type TimerPreference,
	type TimerView,
} from "../lib/timer-model";
import { todayInZone } from "../lib/zoned-time";
import { EntryWarningQuestion } from "./EntryWarningQuestion";
import { TimerDot } from "./TimerDot";
import { TimerStopQuestion } from "./TimerStopQuestion";
import { WorkItemPicker } from "./WorkItemPicker";

/** The API's limit on an entry's description, which a timer's note becomes. */
const NOTE_MAX_LENGTH = 10_000;

/**
 * The open widget of a running or paused timer: its state and time, what it
 * is timing (editable in place), and Pause or Resume, Stop and save, and
 * Discard. Stop asks its questions here, in place of the buttons.
 */
export function TimerPanel({
	organizationId,
	timer,
	dot,
	elapsedSeconds,
	timeZone,
	actions,
	stopper,
	onMinimize,
	onClose,
}: {
	organizationId: string;
	timer: TimerView;
	dot: Exclude<TimerDotState, "saved">;
	elapsedSeconds: number;
	timeZone: string;
	actions: ReturnType<typeof useTimerActions>;
	stopper: ReturnType<typeof useTimerStop>;
	onMinimize: () => void;
	/** Close the widget, until the next timer or for good. */
	onClose: (widget: Exclude<TimerPreference["timerWidget"], "SHOWN">) => void;
}) {
	const t = useTranslations("timeTracking.timer");
	const id = useId();
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);

	const projectsQuery = useQuery(
		orpc.timeTracking.listLoggableProjects.queryOptions({
			input: { organizationId },
		}),
	);
	const projects = projectsQuery.data?.projects ?? [];
	const projectOptions = projects.some(
		(project) => project.id === timer.projectId,
	)
		? projects
		: [...projects, { id: timer.projectId, name: timer.projectName }];

	const update = (patch: TimerPatch) =>
		actions.change({ kind: "update", timer, patch });

	const firstStart = timer.segments[0]?.startAt;
	// A pick cannot be before the running segment started (or, paused, the
	// first start: the server then stops at the pause whatever is picked).
	const pickFrom = openSegmentStart(timer) ?? firstStart;
	const asking = stopper.state.phase === "question";
	const story =
		timer.storyId && timer.storyIdentifier
			? {
					id: timer.storyId,
					identifier: timer.storyIdentifier,
					title: timer.storyTitle ?? "",
				}
			: null;

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between gap-2">
				<p className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					<TimerDot state={dot} />
					{t(`state.${dot}`)}
				</p>
				<div className="flex gap-0.5">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("minimize")}
						onClick={onMinimize}
					>
						<MinusIcon aria-hidden="true" />
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("close")}
							>
								<XIcon aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-72">
							<DropdownMenuItem
								className="flex-col items-start gap-0.5"
								onSelect={() => onClose("HIDDEN_UNTIL_START")}
							>
								<span>{t("closeMenu.hide")}</span>
								<span className="text-muted-foreground text-xs">
									{t("closeMenu.hideHint")}
								</span>
							</DropdownMenuItem>
							<DropdownMenuItem
								className="flex-col items-start gap-0.5"
								onSelect={() => onClose("OFF")}
							>
								<span>{t("closeMenu.off")}</span>
								<span className="text-muted-foreground text-xs">
									{t("closeMenu.offHint")}
								</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>

			<p className="flex flex-wrap items-baseline gap-x-2">
				<span className="font-semibold text-3xl tabular-nums tracking-tight">
					{formatElapsed(elapsedSeconds)}
				</span>
				{firstStart ? (
					<span className="text-muted-foreground text-sm">
						{t("since", { time: clockLabel(firstStart, timeZone) })}
					</span>
				) : null}
			</p>

			<div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
				<Label
					htmlFor={`${id}-project`}
					className="text-muted-foreground"
				>
					{t("fields.project")}
				</Label>
				<Select
					value={timer.projectId}
					disabled={actions.isChanging}
					onValueChange={(projectId) => update({ projectId })}
				>
					<SelectTrigger id={`${id}-project`} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{projectOptions.map((project) => (
							<SelectItem key={project.id} value={project.id}>
								{project.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Label
					htmlFor={`${id}-activity`}
					className="text-muted-foreground"
				>
					{t("fields.activity")}
				</Label>
				<Select
					value={timer.activity}
					disabled={actions.isChanging}
					onValueChange={(value) => {
						const activity = TIME_ACTIVITIES.find(
							(option) => option.value === value,
						);
						if (activity) {
							update({ activity: activity.value });
						}
					}}
				>
					<SelectTrigger id={`${id}-activity`} className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TIME_ACTIVITIES.map((activity) => (
							<SelectItem
								key={activity.value}
								value={activity.value}
							>
								{activity.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>

				<Label
					htmlFor={`${id}-story`}
					className="text-muted-foreground"
				>
					{t("fields.workItem")}
				</Label>
				<WorkItemPicker
					key={timer.projectId}
					id={`${id}-story`}
					projectId={timer.projectId}
					organizationId={organizationId}
					value={story}
					onChange={(next) => update({ storyId: next?.id ?? null })}
				/>

				<Label htmlFor={`${id}-note`} className="text-muted-foreground">
					{t("fields.note")}
				</Label>
				<TimerNote
					key={`${timer.id}:${timer.description ?? ""}`}
					id={`${id}-note`}
					initial={timer.description ?? ""}
					placeholder={t("fields.notePlaceholder")}
					onCommit={(description) =>
						update({ description: description || null })
					}
				/>
			</div>

			{stopper.state.phase === "question" && pickFrom ? (
				<TimerStopQuestion
					question={stopper.state}
					openStartAt={pickFrom}
					timeZone={timeZone}
					busy={stopper.busy}
					onStop={stopper.stopAt}
					onCancel={stopper.cancel}
				/>
			) : null}

			{stopper.warning ? (
				<EntryWarningQuestion
					warning={stopper.warning}
					knownEntries={[]}
					proposed={{
						workDate: todayInZone(timeZone),
						durationMinutes: Math.round(elapsedSeconds / 60),
						activity: timer.activity,
						target: story
							? `${story.identifier} ${story.title}`.trim()
							: timer.projectName,
					}}
					isSaving={stopper.busy}
					onConfirm={stopper.confirmWarning}
					onDismiss={stopper.cancel}
				/>
			) : null}

			{asking || stopper.warning ? null : (
				<div className="flex flex-wrap items-center gap-2">
					{timer.status === "RUNNING" ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={actions.isChanging || stopper.busy}
							onClick={() =>
								actions.change({ kind: "pause", timer })
							}
						>
							<PauseIcon aria-hidden="true" />
							{t("pause")}
						</Button>
					) : (
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={actions.isChanging || stopper.busy}
							onClick={() =>
								actions.change({ kind: "resume", timer })
							}
						>
							<PlayIcon aria-hidden="true" />
							{t("resume")}
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						loading={stopper.busy}
						disabled={actions.isChanging}
						onClick={stopper.begin}
					>
						<SquareIcon aria-hidden="true" />
						{t("stopAndSave")}
					</Button>
					{confirmingDiscard ? (
						<fieldset
							aria-labelledby={`${id}-discard`}
							className="ml-auto flex items-center gap-1"
						>
							<span id={`${id}-discard`} className="text-xs">
								{t("discardQuestion")}
							</span>
							<Button
								type="button"
								size="xs"
								variant="ghost"
								onClick={() => setConfirmingDiscard(false)}
							>
								{t("discardCancel")}
							</Button>
							<Button
								type="button"
								size="xs"
								variant="destructive"
								disabled={actions.isChanging}
								onClick={() => {
									setConfirmingDiscard(false);
									actions.change({ kind: "discard", timer });
								}}
							>
								{t("discardConfirm")}
							</Button>
						</fieldset>
					) : (
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="ml-auto"
							disabled={stopper.busy}
							onClick={() => setConfirmingDiscard(true)}
						>
							{t("discard")}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

/** The timer's note, saved when it loses focus or on Enter. */
function TimerNote({
	id,
	initial,
	placeholder,
	onCommit,
}: {
	id: string;
	initial: string;
	placeholder: string;
	onCommit: (description: string) => void;
}) {
	const [value, setValue] = useState(initial);
	const commit = () => {
		const trimmed = value.trim();
		if (trimmed !== initial.trim()) {
			onCommit(trimmed);
		}
	};
	return (
		<Input
			id={id}
			value={value}
			placeholder={placeholder}
			maxLength={NOTE_MAX_LENGTH}
			onChange={(event) => setValue(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					commit();
				}
			}}
		/>
	);
}
