"use client";

/**
 * PendingProposalsBanner
 *
 * Editorial banner that sits above the Roadmap hero to give an assertive
 * first-time nudge when backlog proposals are awaiting review. Dismissible
 * for the session via sessionStorage keyed by projectId — no DB write.
 * Never renders when the count is zero.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type Props = {
	projectId: string;
	organizationId: string | null;
	onOpenInbox: () => void;
};

function sessionKey(projectId: string): string {
	return `pending-proposals-dismissed:${projectId}`;
}

export function PendingProposalsBanner({
	projectId,
	organizationId,
	onOpenInbox,
}: Props) {
	const [dismissed, setDismissed] = useState(false);
	const tStories = useTranslations("tooltips.stories");

	// Hydrate dismissed state from sessionStorage on mount.
	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		try {
			setDismissed(
				window.sessionStorage.getItem(sessionKey(projectId)) === "1",
			);
		} catch {
			// Storage may be blocked; fall back to always showing.
			setDismissed(false);
		}
	}, [projectId]);

	const { data } = useQuery({
		queryKey: [
			"teams-channel-monitor-pending-proposals-count",
			projectId,
			organizationId,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChannelMonitor.pendingProposals.count(
					{
						projectId,
						organizationId,
					},
				);
			return result as { count: number };
		},
		refetchInterval: 30_000,
		refetchOnWindowFocus: true,
	});

	const count = data?.count ?? 0;

	if (count === 0 || dismissed) {
		return null;
	}

	const handleDismiss = () => {
		try {
			if (typeof window !== "undefined") {
				window.sessionStorage.setItem(sessionKey(projectId), "1");
			}
		} catch {
			// ignore storage errors
		}
		setDismissed(true);
	};

	return (
		<div className="rounded-lg border border-foreground/10 bg-muted p-4">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<div className="min-w-0 space-y-1.5">
					<span className="editorial-label">Pending Review</span>
					<p className="text-sm text-foreground/85">
						{count} proposal{count === 1 ? "" : "s"} from monitored
						Teams channels awaiting your review.
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<Tooltip>
						<TooltipTrigger asChild>
							<Button size="sm" onClick={onOpenInbox}>
								Review proposals
							</Button>
						</TooltipTrigger>
						<TooltipContent>
							{tStories("pendingProposalsBanner")}
						</TooltipContent>
					</Tooltip>
					<Button size="sm" variant="ghost" onClick={handleDismiss}>
						Dismiss
					</Button>
				</div>
			</div>
		</div>
	);
}
