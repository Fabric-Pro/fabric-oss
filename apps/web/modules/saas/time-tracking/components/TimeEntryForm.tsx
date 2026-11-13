"use client";

import {
	addDays,
	formatDurationMinutes,
	parseDurationInput,
	TIME_ACTIVITIES,
} from "@repo/utils/time-tracking";
import { TIME_ZONES } from "@saas/shared/lib/time-zones";
import { Button } from "@ui/components/button";
import { DatePicker } from "@ui/components/date-picker";
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
import { ChevronDownIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useEntrySave } from "../hooks/use-entry-save";
import {
	pickerDateToWorkDate,
	shortDateLabel,
	workDateToPickerDate,
} from "../lib/date-labels";
import {
	buildEntryFields,
	DRAFT_PROBLEM_KEYS,
	type DraftProblem,
	draftTimedMinutes,
	type EntryDraft,
	type EntrySelection,
} from "../lib/entry-draft";
import type { LoggableProject, TimeEntry } from "../lib/time-entry-model";
import { DurationShortcuts } from "./DurationShortcuts";
import { EntryWarningQuestion } from "./EntryWarningQuestion";
import { InfoHint } from "./InfoHint";
import { WorkItemPicker } from "./WorkItemPicker";

/** The API's limit on an entry's description. */
const NOTE_MAX_LENGTH = 10_000;

/**
 * The one-line entry form, for a new entry and for editing one in place.
 *
 * Duration first; project and activity follow, then an optional work item
 * and the save button. A project (or an entry) that requires start and stop
 * swaps the duration for two times, a stop date (the work date or the next
 * day, for work past midnight) and the calculated duration. Note, billable and
 * time zone wait behind "More".
 */
export function TimeEntryForm({
	organizationId,
	projects,
	initialDraft,
	entry,
	lockProjectAndItem = false,
	showWorkDate = false,
	knownEntries,
	focusToken,
	onSaved,
	onCancel,
	extraActions,
	onSelectionChange,
}: {
	organizationId: string;
	projects: readonly LoggableProject[];
	initialDraft: EntryDraft;
	/** The entry being edited; absent for a new one. */
	entry?: TimeEntry;
	/** Project and work item are fixed (logging from a work item's page). */
	lockProjectAndItem?: boolean;
	/** Show a date picker; the day view supplies the date otherwise. */
	showWorkDate?: boolean;
	/** Entries the duplicate question can name. */
	knownEntries: readonly TimeEntry[];
	/** Changes whenever the first field should take focus. */
	focusToken?: number;
	onSaved?: (entry: TimeEntry) => void;
	onCancel?: () => void;
	/** Rendered after Save and Cancel when editing (Delete). */
	extraActions?: ReactNode;
	/** Told the project, activity and work item whenever they change. */
	onSelectionChange?: (selection: EntrySelection) => void;
}) {
	const t = useTranslations("timeTracking.form");
	const locale = useLocale();
	const id = useId();
	const editing = entry !== undefined;
	const [draft, setDraft] = useState(initialDraft);
	const [moreOpen, setMoreOpen] = useState(editing);
	const [problem, setProblem] = useState<DraftProblem | null>(null);
	const firstFieldRef = useRef<HTMLInputElement>(null);

	/**
	 * Empty the time and note of a new entry, keeping project, activity and
	 * date for the next one; `patch` says what else goes.
	 */
	const clearTypedEntry = (patch: Partial<EntryDraft>) => {
		setDraft((current) => ({
			...current,
			durationText: "",
			startTime: "",
			stopTime: "",
			stopsNextDay: false,
			description: "",
			...patch,
		}));
	};

	const saver = useEntrySave({
		entryId: entry?.id,
		onSaved: (saved) => {
			if (!editing) {
				clearTypedEntry({ billable: null });
			}
			onSaved?.(saved);
		},
	});

	/**
	 * "No, skip" means do not add this. A new entry loses what was typed for
	 * it, keeping its billable choice; an edit is abandoned as Cancel does.
	 */
	const skip = () => {
		saver.dismiss();
		setProblem(null);
		if (!editing) {
			clearTypedEntry(lockProjectAndItem ? {} : { story: null });
			return;
		}
		if (onCancel) {
			onCancel();
			return;
		}
		setDraft(initialDraft);
	};

	useEffect(() => {
		if (focusToken) {
			firstFieldRef.current?.focus();
		}
	}, [focusToken]);

	const reportSelection = useRef(onSelectionChange);
	reportSelection.current = onSelectionChange;
	useEffect(() => {
		reportSelection.current?.({
			projectId: draft.projectId,
			activity: draft.activity,
			story: draft.story,
		});
	}, [draft.projectId, draft.activity, draft.story]);

	const project = projects.find(
		(candidate) => candidate.id === draft.projectId,
	);
	// An entry kept on its own project is held to the rule it was saved under,
	// as the server does; moved, it takes the destination's current policy.
	const entryInPlace =
		entry && draft.projectId === entry.projectId ? entry : null;
	const timed = entryInPlace
		? entryInPlace.startStopRequired || entryInPlace.startAt !== null
		: (project?.startStopRequired ?? false);
	const billable =
		draft.billable ??
		entryInPlace?.billable ??
		project?.defaultBillable ??
		true;

	const projectOptions =
		entry && !projects.some((candidate) => candidate.id === entry.projectId)
			? [...projects, { id: entry.projectId, name: entry.projectName }]
			: projects;

	const update = (patch: Partial<EntryDraft>) => {
		setDraft((current) => ({ ...current, ...patch }));
		setProblem(null);
		saver.dismiss();
	};

	const submit = () => {
		const result = buildEntryFields(draft, {
			timed,
			acknowledgedWarnings: [],
		});
		if (!result.ok) {
			setProblem(result.problem);
			return;
		}
		saver.save(result.fields);
	};

	const timedMinutes = timed ? draftTimedMinutes(draft) : null;
	const projectName =
		projectOptions.find((candidate) => candidate.id === draft.projectId)
			?.name ?? "";

	return (
		<form
			className="space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-wrap items-center gap-2">
				{showWorkDate ? (
					<DatePicker
						id={`${id}-date`}
						aria-label={t("date")}
						value={workDateToPickerDate(draft.workDate)}
						onChange={(date) => {
							if (date) {
								update({
									workDate: pickerDateToWorkDate(date),
								});
							}
						}}
						className="w-auto"
					/>
				) : null}

				{timed ? (
					<>
						<Input
							ref={firstFieldRef}
							type="time"
							aria-label={t("startTime")}
							value={draft.startTime}
							onChange={(event) =>
								update({ startTime: event.target.value })
							}
							aria-invalid={
								problem === "times" && !draft.startTime
							}
							className="w-28 tabular-nums"
						/>
						<span className="text-muted-foreground text-sm">
							{t("to")}
						</span>
						<Input
							type="time"
							aria-label={t("stopTime")}
							value={draft.stopTime}
							onChange={(event) =>
								update({ stopTime: event.target.value })
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
								update({ stopsNextDay: value === "next" })
							}
						>
							<SelectTrigger
								aria-label={t("stopDate")}
								className="w-auto min-w-32"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="same">
									{shortDateLabel(draft.workDate, locale)}
								</SelectItem>
								<SelectItem value="next">
									{shortDateLabel(
										addDays(draft.workDate, 1),
										locale,
									)}
								</SelectItem>
							</SelectContent>
						</Select>
						<output
							aria-label={t("calculatedDuration")}
							className="font-semibold text-sm tabular-nums"
						>
							={" "}
							{timedMinutes === null
								? "–"
								: formatDurationMinutes(timedMinutes)}
						</output>
					</>
				) : (
					<>
						<Input
							ref={firstFieldRef}
							aria-label={t("duration")}
							placeholder={t("durationPlaceholder")}
							value={draft.durationText}
							onChange={(event) =>
								update({ durationText: event.target.value })
							}
							aria-invalid={
								problem === "duration" || problem === "tooLong"
							}
							className="w-28 tabular-nums"
							autoComplete="off"
							list={`${id}-duration-shortcuts`}
						/>
						<DurationShortcuts id={`${id}-duration-shortcuts`} />
					</>
				)}

				<span className="text-muted-foreground text-sm">{t("on")}</span>

				{lockProjectAndItem ? (
					<span className="text-sm">{projectName}</span>
				) : (
					<Select
						value={draft.projectId ?? undefined}
						onValueChange={(projectId) =>
							update({
								projectId,
								story: null,
								...(editing ? {} : { billable: null }),
							})
						}
					>
						<SelectTrigger
							aria-label={t("project")}
							aria-invalid={problem === "project"}
							className="w-auto min-w-40 max-w-60"
						>
							<SelectValue
								placeholder={t("projectPlaceholder")}
							/>
						</SelectTrigger>
						<SelectContent>
							{projectOptions.map((option) => (
								<SelectItem key={option.id} value={option.id}>
									{option.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				)}

				<Select
					value={draft.activity}
					onValueChange={(value) => {
						const activity = TIME_ACTIVITIES.find(
							(option) => option.value === value,
						);
						if (activity) {
							update({ activity: activity.value });
						}
					}}
				>
					<SelectTrigger
						aria-label={t("activity")}
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

				{lockProjectAndItem ? null : draft.projectId ? (
					<WorkItemPicker
						key={draft.projectId}
						projectId={draft.projectId}
						organizationId={organizationId}
						value={draft.story}
						onChange={(story) => update({ story })}
					/>
				) : null}

				<div className="flex gap-2">
					<Button type="submit" loading={saver.isSaving}>
						{editing ? t("save") : t("add")}
					</Button>
					{onCancel ? (
						<Button
							type="button"
							variant="ghost"
							onClick={onCancel}
							disabled={saver.isSaving}
						>
							{t("cancel")}
						</Button>
					) : null}
					{extraActions}
				</div>
			</div>

			{problem ? (
				<p role="alert" className="text-destructive text-xs">
					{t(DRAFT_PROBLEM_KEYS[problem])}
				</p>
			) : null}

			{saver.question ? (
				<EntryWarningQuestion
					warning={saver.question}
					knownEntries={knownEntries}
					proposed={{
						workDate: draft.workDate,
						durationMinutes: timed
							? timedMinutes
							: parseDurationInput(draft.durationText),
						activity: draft.activity,
						target: draft.story
							? `${draft.story.identifier} ${draft.story.title}`
							: projectName,
					}}
					isSaving={saver.isSaving}
					onConfirm={saver.confirm}
					onDismiss={skip}
				/>
			) : null}

			<div className="flex items-center gap-1">
				<Button
					type="button"
					variant="ghost"
					size="xs"
					aria-expanded={moreOpen}
					aria-controls={`${id}-more`}
					onClick={() => setMoreOpen((open) => !open)}
					className="text-muted-foreground"
				>
					{t("more")}
					<ChevronDownIcon
						aria-hidden="true"
						className={cn(
							"motion-safe:transition-transform",
							moreOpen && "rotate-180",
						)}
					/>
				</Button>
				<InfoHint label={t("aboutQuickEntry")}>
					{timed ? t("aboutStartStop") : t("aboutDuration")}
				</InfoHint>
			</div>

			{moreOpen ? (
				<div
					id={`${id}-more`}
					className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
				>
					<div className="flex min-w-0 items-center gap-2">
						<Label htmlFor={`${id}-note`} className="shrink-0">
							{t("note")}
						</Label>
						<Input
							id={`${id}-note`}
							value={draft.description}
							onChange={(event) =>
								update({ description: event.target.value })
							}
							maxLength={NOTE_MAX_LENGTH}
						/>
					</div>
					<div className="flex items-center gap-2">
						<Switch
							id={`${id}-billable`}
							checked={billable}
							onCheckedChange={(checked) =>
								update({ billable: checked })
							}
						/>
						<Label htmlFor={`${id}-billable`}>
							{t("billable")}
						</Label>
					</div>
					<div className="flex min-w-0 items-center gap-2 sm:col-span-3">
						<Label htmlFor={`${id}-timezone`} className="shrink-0">
							{t("timeZone")}
						</Label>
						<Select
							value={draft.timezone}
							onValueChange={(timezone) => update({ timezone })}
						>
							<SelectTrigger
								id={`${id}-timezone`}
								className="w-full sm:w-72"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{Array.from(
									new Set([draft.timezone, ...TIME_ZONES]),
								).map((zone) => (
									<SelectItem key={zone} value={zone}>
										{zone}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				</div>
			) : null}
		</form>
	);
}
