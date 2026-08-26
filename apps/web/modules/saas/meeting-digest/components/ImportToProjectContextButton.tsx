"use client";

/**
 * Add a personal meeting to a project as context (#2170).
 *
 * The confirmation dialog is the point of this component, not a formality.
 * Everywhere else in the personal lane the copy promises the meeting "is
 * visible only to you" and its transcript "is never stored in Fabric"; this
 * action makes both false for the meeting it acts on. A bare button would let a
 * user publish a private conversation into an org-visible project on one click,
 * still holding the mental model the rest of the surface gave them.
 *
 * So the dialog states the three things that actually change — stored, visible
 * to the project, read by Fabric's AI features — and the confirm button repeats
 * the action rather than saying "OK", because "OK" is what people click without
 * reading.
 *
 * Nothing here is optimistic. The result line reports what the server did,
 * including the cases where it deliberately did nothing (no transcript yet,
 * admin consent needed, someone else's meeting), so the user is never told a
 * meeting was added when it was not.
 */
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { CheckIcon, FolderPlusIcon } from "lucide-react";
import { useState } from "react";
import type { PersonalMeeting } from "../lib/types";

type ImportResult =
	| { status: "imported"; contextId: string }
	| { status: "duplicate"; contextId: string }
	| { status: "unavailable"; reason?: string }
	| { status: "too-large"; limit: number };

/**
 * The reason copy deliberately matches `PersonalMeetingSheet`'s wording for the
 * same Graph states. A user who has just been told "ask your IT admin" in one
 * panel should not meet a differently-phrased version of the same fact here and
 * wonder whether it is a different problem.
 */
function unavailableMessage(reason?: string): string {
	switch (reason) {
		case "admin-consent-required":
			return "Fabric needs your IT admin to approve transcript access before this meeting can be added.";
		case "transcript-access-disabled":
			return "Your Teams administrator needs to turn on transcript API access (Teams admin center → Meetings → Meeting settings) before this meeting can be added.";
		case "not-connected":
			return "Connect your Microsoft account in Settings → Integrations to add this meeting.";
		case "no-access":
			return "Microsoft won't release this meeting's transcript to you because someone else organised it, so there's nothing to add.";
		case "meeting-not-found":
			// Kept apart from the default below on purpose. "No transcript yet"
			// invites the user to come back after the recording lands; this
			// meeting has no Teams record to produce one, so waiting is futile.
			return "Fabric couldn't find this meeting in Teams, so there's nothing to add. It may not have been a Teams meeting, or Microsoft no longer has a record of it.";
		default:
			return "There's no transcript for this meeting yet, so there's nothing to add.";
	}
}

function resultMessage(result: ImportResult): string {
	switch (result.status) {
		case "imported":
			return "Added — this meeting is now in project context.";
		case "duplicate":
			return "This meeting is already in project context.";
		case "too-large":
			return "This transcript is too large to add to project context. Nothing was stored — adding part of it would leave the project with a fragment nothing could tell was incomplete.";
		default:
			return unavailableMessage(result.reason);
	}
}

export function ImportToProjectContextButton({
	projectId,
	organizationId,
	projectName,
	meeting,
	onImported,
}: {
	projectId: string;
	organizationId: string | null;
	/** Named in the dialog so "this project" is never ambiguous. */
	projectName: string;
	meeting: PersonalMeeting;
	/**
	 * Fired once this meeting is in the project — for a fresh import and for a
	 * duplicate alike, since both leave it stored and shared. The sheet uses it
	 * to stop telling the user the meeting is visible only to them.
	 */
	onImported?: () => void;
}) {
	const [confirming, setConfirming] = useState(false);

	const importMeeting = useMutation({
		mutationFn: async (): Promise<ImportResult> =>
			(await orpcClient.projects.meetingDigest.importPersonalMeeting({
				projectId,
				organizationId,
				joinUrl: meeting.joinUrl,
				startTime: meeting.startTime ?? undefined,
				meetingSubject: meeting.subject,
			})) as ImportResult,
		onSuccess: (result) => {
			if (result.status === "imported" || result.status === "duplicate") {
				onImported?.();
			}
		},
		onSettled: () => setConfirming(false),
	});

	const result = importMeeting.data;
	// `alreadyImported` comes from the server, so a meeting imported before this
	// page load lands here in the settled state too — without it the button
	// offers an action whose only possible outcome is the duplicate branch.
	const settled =
		result?.status === "imported" ||
		result?.status === "duplicate" ||
		meeting.alreadyImported === true;

	return (
		<>
			{settled ? (
				// Replaces the button rather than sitting beside it: the meeting
				// is in the project, and offering the action again would invite a
				// click whose only possible outcome is the duplicate branch.
				<span className="inline-flex items-center gap-1.5 text-muted-foreground text-sm">
					<CheckIcon className="size-4" aria-hidden="true" />
					{result?.status === "imported"
						? "In project context"
						: "Already in project context"}
				</span>
			) : (
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={() => setConfirming(true)}
					disabled={importMeeting.isPending}
				>
					<FolderPlusIcon
						className="mr-1.5 size-4"
						aria-hidden="true"
					/>
					{importMeeting.isPending
						? "Adding…"
						: "Add to project context"}
				</Button>
			)}

			{result && !settled && (
				<p
					className="w-full rounded border bg-muted/40 px-3 py-2 text-muted-foreground text-xs"
					aria-live="polite"
				>
					{resultMessage(result)}
				</p>
			)}

			{importMeeting.isError && (
				<p
					className="w-full rounded border bg-muted/40 px-3 py-2 text-muted-foreground text-xs"
					aria-live="polite"
				>
					Couldn't add this meeting to project context. Nothing was
					stored. Try again.
				</p>
			)}

			<Dialog open={confirming} onOpenChange={setConfirming}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							Add this meeting to {projectName}?
						</DialogTitle>
						<DialogDescription>
							“{meeting.subject}” is private to you today. Adding
							it changes that.
						</DialogDescription>
					</DialogHeader>

					<ul className="list-disc space-y-1.5 pl-5 text-muted-foreground text-sm">
						<li>
							The transcript will be{" "}
							<strong className="text-foreground">
								stored in Fabric
							</strong>{" "}
							as project context, instead of being fetched fresh
							each time you ask for it.
						</li>
						<li>
							It becomes{" "}
							<strong className="text-foreground">
								visible to everyone with access to this project
							</strong>
							, like any other context source.
						</li>
						<li>
							Fabric's{" "}
							<strong className="text-foreground">
								AI features
							</strong>{" "}
							will read it — including the feature proposals flow,
							which can turn what was discussed into work items.
						</li>
					</ul>

					<p className="text-muted-foreground text-xs">
						Only this occurrence is added. Future meetings in this
						series stay private unless you add them too, and you can
						remove it later from the project's Context tab.
					</p>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setConfirming(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							onClick={() => importMeeting.mutate()}
							disabled={importMeeting.isPending}
						>
							Add to project context
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
