"use client";

import { format, isSameMonth } from "date-fns";
import {
	groupAwaitingByDay,
	groupMeetingsByDay,
	groupPersonalMeetingsByDay,
} from "../lib/group-meetings";
import type {
	AwaitingMeeting,
	DigestMeeting,
	PersonalMeeting,
} from "../lib/types";
import { ActionItemList } from "./ActionItemList";
import { AwaitingAgendaRow } from "./AwaitingTranscriptRow";
import { PersonalAgendaRow } from "./PersonalMeetingRow";

function InsightSection({
	title,
	items,
}: {
	title: string;
	items: Array<{ text: string }>;
}) {
	if (items.length === 0) {
		return null;
	}
	return (
		<div>
			<p className="text-xs font-medium text-muted-foreground">{title}</p>
			<ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
				{items.map((d, i) => (
					<li key={i}>{d.text}</li>
				))}
			</ul>
		</div>
	);
}

/**
 * FR3 (#1814): the catch-up view — every meeting of the month as a
 * day-grouped hierarchical bullet list (decisions / actions / questions),
 * newest day first. Clicking a meeting title opens the detail sheet.
 */
export function AgendaView({
	monthDate,
	meetings,
	projectId,
	organizationId,
	onSelect,
	onToggled,
	onGenerate,
	generatingRefs,
	summaryErrors,
	personalMeetings = [],
	onSelectPersonal,
	awaitingMeetings = [],
}: {
	monthDate: Date;
	meetings: DigestMeeting[];
	projectId: string;
	organizationId: string | null;
	onSelect: (transcriptId: string) => void;
	onToggled: () => void;
	onGenerate: (transcriptId: string, transcriptRef: string) => void;
	generatingRefs: Set<string>;
	summaryErrors: Map<string, string>;
	personalMeetings?: PersonalMeeting[];
	onSelectPersonal?: (meeting: PersonalMeeting) => void;
	awaitingMeetings?: AwaitingMeeting[];
}) {
	const inMonth = meetings.filter(
		(m) => m.meetingDate && isSameMonth(new Date(m.meetingDate), monthDate),
	);
	const byDay = groupMeetingsByDay(
		inMonth.map((m) => ({
			...m,
			meetingDate: new Date(m.meetingDate as Date | string),
		})),
	);
	const personalByDay = groupPersonalMeetingsByDay(
		personalMeetings.filter(
			(m) => m.startTime && isSameMonth(new Date(m.startTime), monthDate),
		),
	);
	const awaitingByDay = groupAwaitingByDay(
		awaitingMeetings.filter((m) =>
			isSameMonth(new Date(m.occurrenceStart), monthDate),
		),
	);
	const days = [
		...new Set([
			...byDay.keys(),
			...personalByDay.keys(),
			...awaitingByDay.keys(),
		]),
	]
		.sort()
		.reverse();

	if (days.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No meetings this month.
			</p>
		);
	}

	return (
		<div className="space-y-6">
			{days.map((key) => {
				const dayMeetings = byDay.get(key) ?? [];
				const heading = format(
					new Date(`${key}T00:00:00`),
					"EEEE, MMM d",
				);
				return (
					<section key={key} className="space-y-3">
						<h3 className="text-sm font-semibold">{heading}</h3>
						{dayMeetings.map((m) => (
							<div
								key={m.transcriptRef}
								className="space-y-2 rounded border p-3"
							>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="font-medium underline-offset-2 hover:underline"
										onClick={() => onSelect(m.transcriptId)}
									>
										{m.subject ?? "Untitled meeting"}
									</button>
									<span className="text-xs text-muted-foreground">
										{m.participantCount} participants
									</span>
									{m.createdTaskCount > 0 ? (
										<span className="text-xs text-muted-foreground">
											· {m.createdTaskCount} task
											{m.createdTaskCount === 1
												? ""
												: "s"}{" "}
											created
										</span>
									) : null}
								</div>
								{m.insightsReady ? (
									<div className="space-y-2">
										<InsightSection
											title="Decisions"
											items={m.decisions}
										/>
										{m.actionItems.length > 0 ? (
											<div>
												<p className="text-xs font-medium text-muted-foreground">
													Actions
												</p>
												<ActionItemList
													projectId={projectId}
													organizationId={
														organizationId
													}
													items={m.actionItems}
													onToggled={onToggled}
												/>
											</div>
										) : null}
										<InsightSection
											title="Questions"
											items={m.openQuestions}
										/>
										{m.decisions.length === 0 &&
										m.actionItems.length === 0 &&
										m.openQuestions.length === 0 ? (
											<p className="text-sm text-muted-foreground">
												No decisions, actions, or
												questions extracted.
											</p>
										) : null}
									</div>
								) : m.hasTranscript ? (
									generatingRefs.has(m.transcriptRef) ? (
										<p className="text-sm text-muted-foreground">
											Generating…
										</p>
									) : (
										<div className="space-y-1">
											{summaryErrors.has(
												m.transcriptRef,
											) ? (
												<p className="text-xs text-destructive">
													{summaryErrors.get(
														m.transcriptRef,
													)}
												</p>
											) : null}
											<button
												type="button"
												className="rounded border px-2 py-0.5 text-xs hover:bg-muted"
												onClick={() =>
													onGenerate(
														m.transcriptId,
														m.transcriptRef,
													)
												}
											>
												Generate summary
											</button>
										</div>
									)
								) : (
									<p className="text-sm text-muted-foreground">
										No summary available
									</p>
								)}
							</div>
						))}
						{/*
						 * Same precedence as CalendarCanvas: team content first,
						 * the viewer's personal calendar last. There is no badge
						 * budget here, so this is purely about the two views
						 * agreeing on order (DEF-1, #2051 staging QA).
						 */}
						{(awaitingByDay.get(key) ?? []).map((m) => (
							<AwaitingAgendaRow
								key={`${m.linkedMeetingId}:${new Date(m.occurrenceStart).toISOString()}`}
								meeting={m}
							/>
						))}
						{(personalByDay.get(key) ?? []).map((m) => (
							<PersonalAgendaRow
								key={m.id}
								meeting={m}
								onSelect={onSelectPersonal}
							/>
						))}
					</section>
				);
			})}
		</div>
	);
}
