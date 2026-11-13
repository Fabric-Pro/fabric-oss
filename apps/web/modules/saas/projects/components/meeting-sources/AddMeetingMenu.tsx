"use client";

/**
 * "Add meeting", the same four ways in wherever meetings are added (Fizzy
 * #3507): the calendar picker, a transcript file, the project's meeting series
 * settings, and a OneDrive transcript folder.
 *
 * Nothing here is a second implementation. The upload dialog renders the
 * uploader from the Knowledge settings, and the series dialog renders the same
 * two settings cards that page shows, so a change made from Meeting Digest or
 * the Context tab is a change to the one project configuration, and the server
 * checks it the same way.
 *
 * The calendar picker stays with the page that opens it, because Meeting Digest
 * already owns one and has to refresh its own caches when a meeting is linked.
 */

import { MeetingTranscriptSyncSettings } from "@saas/projects/components/MeetingTranscriptSyncSettings";
import { SlackChannelMonitorSettings } from "@saas/projects/components/SlackChannelMonitorSettings";
import { TranscriptFileUpload } from "@saas/projects/components/TranscriptFileUpload";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	CalendarPlusIcon,
	ChevronDownIcon,
	FolderInputIcon,
	PlusIcon,
	SettingsIcon,
	UploadIcon,
} from "lucide-react";
import { type ComponentProps, useState } from "react";
import { ConnectTranscriptFolderDialog } from "./ConnectTranscriptFolderDialog";

/** The project fields the two settings cards read. */
export type MeetingSourcesProject = ComponentProps<
	typeof MeetingTranscriptSyncSettings
>["project"] &
	ComponentProps<typeof SlackChannelMonitorSettings>["project"];

interface DialogProps {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

function UploadTranscriptDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: DialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-2xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Upload transcript</DialogTitle>
					<DialogDescription>
						Each file becomes a meeting in the Meeting Digest and a
						source on the Context tab once it is read.
					</DialogDescription>
				</DialogHeader>
				<TranscriptFileUpload
					projectId={projectId}
					organizationId={organizationId}
					className="space-y-3"
				/>
			</DialogContent>
		</Dialog>
	);
}

function MeetingSeriesDialog({
	projectId,
	organizationId,
	project,
	open,
	onOpenChange,
}: DialogProps & { project: MeetingSourcesProject }) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="grid-cols-[minmax(0,1fr)] max-h-[90vh] max-w-4xl overflow-y-auto">
				<DialogHeader>
					<DialogTitle>Configure meeting series</DialogTitle>
					<DialogDescription>
						The same settings as Project Settings → Knowledge. A
						change here is a change there.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<MeetingTranscriptSyncSettings
						projectId={projectId}
						organizationId={organizationId}
						project={project}
						transcriptFolders
					/>
					<SlackChannelMonitorSettings
						projectId={projectId}
						organizationId={organizationId}
						project={project}
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * The upload and series dialogs, owned by the page rather than by any one
 * "Add meeting" button.
 *
 * A page can show its button in more than one place, and the Meeting Digest
 * swaps its empty-state button for the calendar once the first upload lands.
 * A dialog owned by that button would close under the user, taking a
 * partial-read warning with it, so the page mounts the dialogs once and every
 * button only opens them.
 */
export function useMeetingSourceDialogs({
	projectId,
	organizationId,
	project,
	onSourcesChanged,
}: {
	projectId: string;
	organizationId: string | null;
	/** Absent when the viewer may not change meeting sources: no dialogs. */
	project: MeetingSourcesProject | undefined;
	/** Called when a dialog closes, so the page can read its sources again. */
	onSourcesChanged?: () => void;
}) {
	const queryClient = useQueryClient();
	const [dialog, setDialog] = useState<"upload" | "series" | "folder" | null>(
		null,
	);

	const close = (open: boolean) => {
		if (open) {
			return;
		}
		// The series cards seed their toggles from the project, so it has to be
		// read again or reopening the dialog shows the settings from before.
		if (dialog === "series") {
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.get.key(),
			});
		}
		setDialog(null);
		onSourcesChanged?.();
	};

	return {
		openUpload: () => setDialog("upload"),
		openSeries: () => setDialog("series"),
		openFolder: () => setDialog("folder"),
		dialogs: project ? (
			<>
				<UploadTranscriptDialog
					projectId={projectId}
					organizationId={organizationId}
					open={dialog === "upload"}
					onOpenChange={close}
				/>
				<MeetingSeriesDialog
					projectId={projectId}
					organizationId={organizationId}
					project={project}
					open={dialog === "series"}
					onOpenChange={close}
				/>
				<ConnectTranscriptFolderDialog
					projectId={projectId}
					organizationId={organizationId}
					open={dialog === "folder"}
					onOpenChange={close}
				/>
			</>
		) : null,
	};
}

export function AddMeetingMenu({
	onAddFromCalendar,
	onUpload,
	onConfigureSeries,
	onConnectFolder,
	variant = "outline",
}: {
	onAddFromCalendar: () => void;
	onUpload: () => void;
	onConfigureSeries: () => void;
	onConnectFolder: () => void;
	/** `link` matches the text actions in the Meeting Digest header. */
	variant?: "outline" | "link";
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				{variant === "link" ? (
					<button
						type="button"
						className="inline-flex items-center gap-1 text-sm underline"
					>
						Add meeting
						<ChevronDownIcon
							aria-hidden="true"
							className="size-3.5"
						/>
					</button>
				) : (
					<Button type="button" variant="outline" size="sm">
						<PlusIcon
							aria-hidden="true"
							className="mr-1.5 size-4"
						/>
						Add meeting
						<ChevronDownIcon
							aria-hidden="true"
							className="ml-1.5 size-3.5"
						/>
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onAddFromCalendar}>
					<CalendarPlusIcon
						aria-hidden="true"
						className="mr-2 size-4"
					/>
					Add from calendar
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onUpload}>
					<UploadIcon aria-hidden="true" className="mr-2 size-4" />
					Upload transcript
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onConfigureSeries}>
					<SettingsIcon aria-hidden="true" className="mr-2 size-4" />
					Configure meeting series
				</DropdownMenuItem>
				<DropdownMenuItem onSelect={onConnectFolder}>
					<FolderInputIcon
						aria-hidden="true"
						className="mr-2 size-4"
					/>
					Connect transcript folder
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
