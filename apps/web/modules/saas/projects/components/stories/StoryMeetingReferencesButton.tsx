"use client";

import { buildDigestDeepLink } from "@saas/meeting-digest/lib/digest-deep-link";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { CalendarClockIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { IconCountBadge } from "./IconCountBadge";

type MeetingReference = {
	linkId: string;
	itemKey: string;
	itemText: string;
	origin: "AUTO" | "MANUAL" | "CREATED";
	meetingSubject: string | null;
	meetingDate: string | Date | null;
	transcriptRef: string;
	projectId: string;
};

function formatMeetingDate(value: string | Date | null): string | null {
	if (!value) {
		return null;
	}
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime())
		? null
		: date.toLocaleDateString(undefined, {
				year: "numeric",
				month: "short",
				day: "numeric",
			});
}

/**
 * "Referenced in meetings" — the meeting action items that point at this work
 * item (#1902 FR5/FR6, AC4/AC5).
 *
 * Follows StoryAttachmentsButton: an action-bar icon with a live count badge
 * opening a right-side Sheet. The count is the point — it is what makes a link
 * created in the digest discoverable from the work item without anyone going
 * looking.
 *
 * The button hides itself entirely when there are no references, so a project
 * not using the feature (or running with the flag off, where the procedure
 * returns an empty list) gains no dead chrome.
 */
export function StoryMeetingReferencesButton({
	storyId,
	storyIdentifier,
	projectId,
	organizationId,
}: {
	storyId: string;
	storyIdentifier: string | null;
	projectId: string;
	organizationId: string | null;
}) {
	const [open, setOpen] = useState(false);
	const { basePath } = useOrganizationContext();

	const query = useQuery({
		queryKey: [
			"story-meeting-references",
			projectId,
			storyId,
			organizationId,
		],
		queryFn: () =>
			orpcClient.projects.stories.listMeetingReferences({
				projectId,
				storyId,
				organizationId,
			}),
		// Back-reference state must be LIVE, not the global 60s-stale cache —
		// the same reason getMeeting reads its linked tickets this way (#1823).
		// Links are added and removed from the meeting digest, a different
		// surface entirely, so this component never sees the mutation that
		// invalidates it. Without this, opening a work item you had already
		// visited shows a stale count (or no button at all) until a hard reload.
		staleTime: 0,
		refetchOnMount: "always",
	});

	const references = (query.data?.references ?? []) as MeetingReference[];
	if (references.length === 0) {
		return null;
	}

	const label = `Referenced in ${references.length} meeting${
		references.length === 1 ? "" : "s"
	}`;

	return (
		<>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="relative size-8 text-muted-foreground hover:text-foreground"
							onClick={() => setOpen(true)}
							aria-label={label}
						>
							<CalendarClockIcon className="size-4" />
							<IconCountBadge count={references.length} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Referenced in meetings</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side="right"
					className="flex flex-col gap-4 sm:max-w-[480px]"
				>
					<SheetTitle className="pr-8">
						Referenced in meetings
						{storyIdentifier ? ` — ${storyIdentifier}` : ""}
					</SheetTitle>
					<SheetDescription className="sr-only">
						Meeting action items that reference this work item, with
						links back to the meeting digest.
					</SheetDescription>
					<ul className="min-h-0 flex-1 space-y-3 overflow-y-auto">
						{references.map((reference) => {
							const date = formatMeetingDate(
								reference.meetingDate,
							);
							return (
								<li
									key={reference.linkId}
									className="rounded-md border p-3"
								>
									<p className="text-sm">
										{reference.itemText}
									</p>
									<p className="mt-1 text-xs text-muted-foreground">
										{reference.meetingSubject ??
											"Untitled meeting"}
										{date ? ` · ${date}` : ""}
									</p>
									<Link
										href={buildDigestDeepLink({
											basePath,
											projectId: reference.projectId,
											transcriptRef:
												reference.transcriptRef,
											itemKey: reference.itemKey,
										})}
										className="mt-2 inline-block text-xs text-primary underline-offset-2 hover:underline"
									>
										Open in meeting digest
									</Link>
								</li>
							);
						})}
					</ul>
				</SheetContent>
			</Sheet>
		</>
	);
}
