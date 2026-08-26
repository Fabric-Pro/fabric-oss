"use client";

/**
 * PendingProposalsButton
 *
 * Persistent toolbar pill for the Roadmap that surfaces the count of pending
 * backlog proposals queued up by the Teams Channel Monitor. Renders nothing
 * when the count is zero. Clicking opens the inbox drawer handled by the
 * parent.
 *
 * Design: warm highlight (amber) pill. A one-shot entrance fade plays the
 * first time the count transitions from 0 → n so the user notices new work.
 * No ambient/looping motion — the color plus count are the persistent signal.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InboxIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

type Props = {
	projectId: string;
	organizationId: string | null;
	onOpenInbox: () => void;
};

export function PendingProposalsButton({
	projectId,
	organizationId,
	onOpenInbox,
}: Props) {
	const [playEntrance, setPlayEntrance] = useState(false);
	const hasEntranceFiredRef = useRef(false);
	const tStories = useTranslations("tooltips.stories");

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

	// Fire the entrance fade exactly once, on the first transition from 0 → n.
	useEffect(() => {
		if (count > 0 && !hasEntranceFiredRef.current) {
			hasEntranceFiredRef.current = true;
			setPlayEntrance(true);
		}
	}, [count]);

	if (count === 0) {
		return null;
	}

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					onClick={onOpenInbox}
					className={[
						"gap-2 border-highlight/30 bg-highlight/15 text-highlight hover:bg-highlight/20",
						playEntrance
							? "motion-safe:animate-in motion-safe:fade-in"
							: "",
					]
						.filter(Boolean)
						.join(" ")}
					aria-label={`Review ${count} pending proposal${count === 1 ? "" : "s"}`}
					data-onboarding-target="roadmap-review-proposals"
				>
					<InboxIcon className="size-4" />
					Review {count} proposal{count === 1 ? "" : "s"}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{tStories("reviewProposals")}</TooltipContent>
		</Tooltip>
	);
}
