"use client";

/**
 * Correct a meeting's title and date (Fizzy #3507, FR13).
 *
 * A meeting imported from a folder is named after its file and dated from it,
 * or not dated at all, and both can be wrong. Giving an undated meeting a date
 * moves it from "Unknown date" to its day on the calendar.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { format } from "date-fns";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { meetingCalendarDay } from "../lib/group-meetings";

export interface MeetingDetailsTarget {
	transcriptId: string;
	subject: string | null;
	meetingDate: Date | string | null;
}

/** A calendar day, as the date input speaks it. */
function dayOf(date: Date | string | null): string {
	return date ? format(meetingCalendarDay(date), "yyyy-MM-dd") : "";
}

/**
 * Noon UTC, as the folder import stores a date it read: the digest groups by
 * the viewer's local day, and noon is that same day from UTC-11 to UTC+11.
 */
function storedDate(day: string): Date | null {
	return day ? new Date(`${day}T12:00:00.000Z`) : null;
}

export function MeetingDetailsDialog({
	projectId,
	organizationId,
	target,
	onClose,
	onSaved,
}: {
	projectId: string;
	organizationId: string | null;
	target: MeetingDetailsTarget | null;
	onClose: () => void;
	onSaved: () => void | Promise<void>;
}) {
	const titleId = useId();
	const dateId = useId();
	const [subject, setSubject] = useState("");
	const [day, setDay] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		setSubject(target?.subject ?? "");
		setDay(dayOf(target?.meetingDate ?? null));
	}, [target]);

	const save = async () => {
		if (!target) {
			return;
		}
		setSaving(true);
		try {
			// The date is sent only when it changed: a title-only edit must keep a
			// Teams meeting's real start time, not round it to a day.
			const dateChanged = day !== dayOf(target.meetingDate);
			await orpcClient.projects.meetingDigest.updateMeetingDetails({
				projectId,
				organizationId,
				transcriptId: target.transcriptId,
				meetingSubject: subject.trim(),
				...(dateChanged ? { meetingDate: storedDate(day) } : {}),
			});
			await onSaved();
			onClose();
		} catch (error) {
			toast.error(
				error instanceof Error && error.message
					? error.message
					: "The meeting could not be updated.",
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog
			open={target !== null}
			onOpenChange={(open) => {
				if (!open) {
					onClose();
				}
			}}
		>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>Meeting details</DialogTitle>
					<DialogDescription>
						Correct the title and the day the meeting was held.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor={titleId}>Title</Label>
						<Input
							id={titleId}
							value={subject}
							maxLength={255}
							onChange={(event) => setSubject(event.target.value)}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor={dateId}>Date</Label>
						<Input
							id={dateId}
							type="date"
							value={day}
							onChange={(event) => setDay(event.target.value)}
						/>
						<p className="text-muted-foreground text-xs">
							Leave empty if the date is not known. The meeting
							then stays under Unknown date.
						</p>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={save}
						disabled={saving || subject.trim().length === 0}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
