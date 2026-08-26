"use client";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { buildStoryDetailsRoute } from "@saas/projects/lib/stories/routes";
import { CheckCircle2, Circle } from "lucide-react";
import Link from "next/link";
import type { LinkedTicket } from "../lib/types";

/**
 * #1823 FR7-FR10: tickets created from this meeting, with LIVE completion
 * state (checkmark iff the story's Kanban status is final) and in-app
 * navigation to the story detail. Deleted stories never reach this list
 * (the provenance FK is SetNull), so no broken-link state is needed.
 */
export function LinkedTicketsPanel({
	projectId,
	tickets,
}: {
	projectId: string;
	tickets: LinkedTicket[];
}) {
	const { basePath } = useOrganizationContext();

	if (tickets.length === 0) {
		return (
			<p className="text-muted-foreground">
				No tickets created from this meeting.
			</p>
		);
	}

	return (
		<ul className="space-y-1">
			{tickets.map((t) => (
				<li key={t.storyId} className="flex items-center gap-2">
					{t.isDone ? (
						<CheckCircle2
							role="img"
							aria-label="Completed"
							className="size-4 shrink-0 text-primary"
						/>
					) : (
						<Circle
							role="img"
							aria-label="Not completed"
							className="size-4 shrink-0 text-muted-foreground"
						/>
					)}
					<Link
						href={buildStoryDetailsRoute(
							basePath,
							projectId,
							t.storyId,
						)}
						className="min-w-0 truncate underline-offset-2 hover:underline"
					>
						<span className="font-mono">{t.identifier ?? "—"}</span>{" "}
						{t.title}
					</Link>
					{t.statusName ? (
						<span className="ml-auto shrink-0 text-xs text-muted-foreground">
							{t.statusName}
						</span>
					) : null}
				</li>
			))}
		</ul>
	);
}
