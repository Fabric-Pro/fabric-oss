"use client";

import { Badge } from "@ui/components/badge";
import { InboxIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import {
	buildProposalInboxHref,
	type PendingProposalMeeting,
} from "../lib/todo-proposals-api";

const T = "todos.list";

/**
 * "This meeting has proposals waiting for review" (Fizzy #2340).
 *
 * ONCE PER MEETING, ON THE GROUP HEADING. The Feature Proposals inbox is a
 * queue per meeting and a person reviews it per meeting, so this is a
 * statement about the meeting rather than about any row under it. Carried on
 * the rows, the same fact would repeat on all eight lines of one meeting —
 * eight badges that mean one thing, which reads as eight things to do.
 *
 * IT IS A LINK, not an ornament. A count nobody can act on is a nag; this one
 * opens the inbox it is counting, in the project that owns the meeting.
 *
 * ABSENT MEANS NOTHING IS WAITING. The read answers only about meetings that
 * have something pending, so a heading with no badge is the ordinary case and
 * must not carry an empty placeholder saying so.
 */
export function TodoMeetingProposalsBadge({
	pending,
	basePath,
}: {
	pending: PendingProposalMeeting;
	/** `/app/<slug>` — where the inbox deep link is rooted. */
	basePath: string;
}) {
	const t = useTranslations();

	if (pending.pendingCount <= 0) {
		return null;
	}

	return (
		<Badge asChild variant="warning" className="gap-1">
			<a
				href={buildProposalInboxHref({
					basePath,
					projectId: pending.projectId,
				})}
				data-testid="todo-meeting-proposals-pending"
				data-pending-count={pending.pendingCount}
				/*
				 * OPENS WITH THE VISIBLE TEXT, then says where it goes. A name
				 * that replaced the label rather than extending it would leave
				 * a voice-control user saying the words they can see and
				 * hitting nothing (WCAG 2.5.3).
				 */
				aria-label={t(`${T}.proposals.pendingLabel`, {
					count: pending.pendingCount,
				})}
			>
				<InboxIcon aria-hidden="true" className="size-3 shrink-0" />
				{t(`${T}.proposals.pending`, {
					count: pending.pendingCount,
				})}
			</a>
		</Badge>
	);
}
