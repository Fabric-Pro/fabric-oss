"use client";

import {
	MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH,
	type TimeEvidenceKind,
} from "@repo/utils/time-suggestions";
import {
	addDays,
	formatDurationMinutes,
	parseDurationInput,
	TIME_ACTIVITIES,
	TIME_ACTIVITY_LABELS,
	type TimeEntryWarning,
} from "@repo/utils/time-tracking";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Switch } from "@ui/components/switch";
import { cn } from "@ui/lib";
import { ChevronRightIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { shortDateLabel } from "../lib/date-labels";
import { DRAFT_PROBLEM_KEYS, type DraftProblem } from "../lib/entry-draft";
import {
	draftIntervalMinutes,
	evidenceTimeRange,
	type SuggestionDraft,
	type TimeSuggestion,
} from "../lib/suggestion-model";
import type { TimeEntry } from "../lib/time-entry-model";
import { DurationShortcuts } from "./DurationShortcuts";
import { EntryWarningQuestion } from "./EntryWarningQuestion";
import { WorkItemPicker } from "./WorkItemPicker";

const EVIDENCE_KEYS: Record<TimeEvidenceKind, string> = {
	MEETING_SESSION: "evidence.meetings",
	TEST_RUN: "evidence.testRuns",
	FEATURE_EDIT: "evidence.workItemEdits",
	TEST_RESULT: "evidence.testResults",
	TEST_CASE_ACTIVITY: "evidence.testCaseChanges",
	PULL_REQUEST: "evidence.pullRequestPushes",
};

/**
 * One suggestion on one line: date, project, activity and work item in
 * words, one duration slot, Confirm and "Not work time". A project that
 * requires start and stop swaps the slot for two times. Enter in the slot
 * confirms. The chevron opens the rest (note, billable, activity, work item,
 * and what the suggestion came from); changes there go out with the confirm.
 */
export function SuggestionRow({
	suggestion,
	draft,
	problem,
	question,
	knownEntries,
	organizationId,
	confirming,
	dismissing,
	disabled,
	onChange,
	onConfirm,
	onDismiss,
	onAnswerYes,
	onAnswerNo,
}: {
	suggestion: TimeSuggestion;
	draft: SuggestionDraft;
	problem: DraftProblem | null;
	/** The server's open question about this row's confirm, if any. */
	question: TimeEntryWarning | null;
	/** Entries the duplicate question can name. */
	knownEntries: readonly TimeEntry[];
	organizationId: string;
	confirming: boolean;
	dismissing: boolean;
	/** A confirm is running, on this row, another, or the batch. */
	disabled: boolean;
	onChange: (patch: Partial<SuggestionDraft>) => void;
	onConfirm: () => void;
	onDismiss: () => void;
	onAnswerYes: () => void;
	onAnswerNo: () => void;
}) {
	const t = useTranslations("timeTracking.suggestions");
	const tForm = useTranslations("timeTracking.form");
	const locale = useLocale();
	const id = useId();
	const [expanded, setExpanded] = useState(false);

	const dateLabel = shortDateLabel(suggestion.workDate, locale);
	const timed = suggestion.startStopRequired;
	const intervalMinutes = timed
		? draftIntervalMinutes(suggestion, draft)
		: null;
	const busy = confirming || dismissing || disabled;
	const timeRange = evidenceTimeRange(
		suggestion.evidence,
		suggestion.timezone,
	);
	const evidenceText = [
		...suggestion.evidence.map((item) =>
			t(EVIDENCE_KEYS[item.kind], { count: item.count }),
		),
		...(timeRange ? [timeRange] : []),
	].join(", ");

	return (
		<li className="py-3">
			<form
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					onConfirm();
				}}
			>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-expanded={expanded}
						aria-controls={`${id}-details`}
						aria-label={
							expanded
								? t("hideDetails", {
										project: suggestion.projectName,
										date: dateLabel,
									})
								: t("showDetails", {
										project: suggestion.projectName,
										date: dateLabel,
									})
						}
						onClick={() => setExpanded((open) => !open)}
					>
						<ChevronRightIcon
							aria-hidden="true"
							className={cn(
								"motion-safe:transition-transform",
								expanded && "rotate-90",
							)}
						/>
					</Button>

					<p className="flex min-w-0 flex-1 basis-64 flex-wrap items-baseline gap-x-2 text-sm">
						<span className="text-muted-foreground tabular-nums">
							{dateLabel}
						</span>
						<span className="font-medium">
							{suggestion.projectName}
						</span>
						<span>{TIME_ACTIVITY_LABELS[draft.activity]}</span>
						{draft.story ? (
							<span className="font-mono text-muted-foreground text-xs tabular-nums">
								{draft.story.identifier}
							</span>
						) : null}
					</p>

					{timed ? (
						<>
							<Input
								type="time"
								aria-label={tForm("startTime")}
								value={draft.startTime}
								onChange={(event) =>
									onChange({ startTime: event.target.value })
								}
								aria-invalid={
									problem === "times" && !draft.startTime
								}
								className="w-28 tabular-nums"
							/>
							<span className="text-muted-foreground text-sm">
								{tForm("to")}
							</span>
							<Input
								type="time"
								aria-label={tForm("stopTime")}
								value={draft.stopTime}
								onChange={(event) =>
									onChange({ stopTime: event.target.value })
								}
								aria-invalid={
									problem === "stopBeforeStart" ||
									(problem === "times" && !draft.stopTime)
								}
								className="w-28 tabular-nums"
							/>
							<Select
								value={draft.stopsNextDay ? "next" : "same"}
								onValueChange={(value) =>
									onChange({ stopsNextDay: value === "next" })
								}
							>
								<SelectTrigger
									aria-label={tForm("stopDate")}
									className="w-auto min-w-32"
								>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="same">
										{dateLabel}
									</SelectItem>
									<SelectItem value="next">
										{shortDateLabel(
											addDays(suggestion.workDate, 1),
											locale,
										)}
									</SelectItem>
								</SelectContent>
							</Select>
							<output
								aria-label={tForm("calculatedDuration")}
								className="font-semibold text-sm tabular-nums"
							>
								={" "}
								{intervalMinutes === null
									? "–"
									: formatDurationMinutes(intervalMinutes)}
							</output>
						</>
					) : (
						<>
							<Input
								aria-label={tForm("duration")}
								placeholder={tForm("durationPlaceholder")}
								value={draft.durationText}
								onChange={(event) =>
									onChange({
										durationText: event.target.value,
									})
								}
								aria-invalid={
									problem === "duration" ||
									problem === "tooLong"
								}
								className="w-28 tabular-nums"
								autoComplete="off"
								list={`${id}-duration-shortcuts`}
							/>
							<DurationShortcuts
								id={`${id}-duration-shortcuts`}
							/>
						</>
					)}

					<div className="flex gap-2">
						<Button
							type="submit"
							size="sm"
							loading={confirming}
							disabled={busy && !confirming}
						>
							{t("confirm")}
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={onDismiss}
							loading={dismissing}
							disabled={busy && !dismissing}
						>
							{t("dismiss")}
						</Button>
					</div>
				</div>

				{problem ? (
					<p role="alert" className="pl-10 text-destructive text-xs">
						{tForm(DRAFT_PROBLEM_KEYS[problem])}
					</p>
				) : null}

				{question ? (
					<EntryWarningQuestion
						warning={question}
						knownEntries={knownEntries}
						proposed={{
							workDate: suggestion.workDate,
							durationMinutes: timed
								? intervalMinutes
								: parseDurationInput(draft.durationText),
							activity: draft.activity,
							target: draft.story
								? `${draft.story.identifier} ${draft.story.title}`
								: suggestion.projectName,
						}}
						isSaving={confirming}
						onConfirm={onAnswerYes}
						onDismiss={onAnswerNo}
					/>
				) : null}

				{expanded ? (
					<div
						id={`${id}-details`}
						className="grid gap-3 pl-10 sm:grid-cols-[minmax(0,1fr)_auto]"
					>
						<div className="flex min-w-0 items-center gap-2 sm:col-span-2">
							<Label
								htmlFor={`${id}-description`}
								className="shrink-0"
							>
								{t("description")}
							</Label>
							<Input
								id={`${id}-description`}
								value={draft.description}
								onChange={(event) =>
									onChange({
										description: event.target.value,
									})
								}
								maxLength={
									MAX_TIME_SUGGESTION_DESCRIPTION_LENGTH
								}
							/>
						</div>
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<Select
								value={draft.activity}
								onValueChange={(value) => {
									const activity = TIME_ACTIVITIES.find(
										(option) => option.value === value,
									);
									if (activity) {
										onChange({ activity: activity.value });
									}
								}}
							>
								<SelectTrigger
									aria-label={tForm("activity")}
									className="w-auto min-w-40"
								>
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
							<WorkItemPicker
								projectId={suggestion.projectId}
								organizationId={organizationId}
								value={draft.story}
								onChange={(story) => onChange({ story })}
							/>
						</div>
						<div className="flex items-center gap-2">
							<Switch
								id={`${id}-billable`}
								checked={draft.billable}
								onCheckedChange={(checked) =>
									onChange({ billable: checked })
								}
							/>
							<Label htmlFor={`${id}-billable`}>
								{tForm("billable")}
							</Label>
						</div>
						{evidenceText ? (
							<p className="text-muted-foreground text-sm tabular-nums sm:col-span-2">
								{evidenceText}
							</p>
						) : null}
					</div>
				) : null}
			</form>
		</li>
	);
}
