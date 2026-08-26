"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import { InfoIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { UserStory } from "../../lib/stories/types";
import { ProvenanceSection } from "./editor/ProvenanceSection";

type Props = {
	story: UserStory;
	projectId: string;
	organizationId: string | null;
	pmToolName?: string | null;
};

/**
 * Action-bar entry point for the feature's provenance/details (#1347). An
 * info-icon button opens a popover hosting the existing read-only
 * `ProvenanceSection` (Created / Modified-by / Source / Proposed / PM ticket /
 * Version). Unflagged — it surfaces data the story already carries.
 * The `projects.members.list` query that resolves the creator's name fires
 * lazily (`enabled: open`) and is cached for the session (`staleTime: Infinity`),
 * so it runs once on first open and reopening reads from cache instead of
 * refetching — keeping the page hot-path free of an extra request. Org is read
 * from the caller-supplied
 * `organizationId` (the page passes `project.organizationId`, never ambient).
 */
export function StoryDetailsButton({
	story,
	projectId,
	organizationId,
	pmToolName,
}: Props) {
	const [open, setOpen] = useState(false);

	const { data: membersData, isLoading: isMembersLoading } = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: open,
		// Project membership is stable for the editing session, so cache it
		// permanently: `enabled: open` alone would refetch on every reopen
		// because TanStack re-enables a stale query (default staleTime 0) each
		// time. `staleTime: Infinity` makes the lazy fetch genuinely
		// first-open-only — reopening serves from cache.
		staleTime: Number.POSITIVE_INFINITY,
	});

	const creatorMember = useMemo(
		() =>
			membersData?.members?.find(
				(m: { userId?: string }) => m.userId === story.createdById,
			) as
				| { user?: { name?: string | null; email?: string | null } }
				| undefined,
		[membersData, story.createdById],
	);
	const creatorName = creatorMember?.user?.name ?? null;
	const creatorEmail = creatorMember?.user?.email ?? null;
	// Drive the loading skeleton off the query's own loading flag, not
	// `membersData == null`: on a members fetch error `membersData` stays
	// undefined forever, which would otherwise pin the creator skeleton open
	// indefinitely. `isLoading` settles to false on error, so the creator field
	// falls back to "Unknown user".
	const isMetaLoading = isMembersLoading;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-8 text-muted-foreground hover:text-foreground"
					aria-label="Feature details"
					title="Feature details"
				>
					<InfoIcon className="size-4" />
				</Button>
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="max-h-[70vh] w-80 overflow-y-auto"
			>
				<ProvenanceSection
					story={story}
					creatorName={creatorName}
					creatorEmail={creatorEmail}
					pmToolName={pmToolName}
					isMetaLoading={isMetaLoading}
				/>
			</PopoverContent>
		</Popover>
	);
}
