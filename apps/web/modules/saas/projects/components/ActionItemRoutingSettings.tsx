"use client";

/**
 * Project setting: route extracted action items to Create or Enrich.
 *
 * Sits with the other ingestion-source cards because it governs all of them —
 * meeting transcripts, Teams channels, Teams chats and Slack channels all feed
 * the same analyzer, and this flag decides whether what that analyzer captures
 * is checked against the project's existing tickets before being proposed.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Card } from "@ui/components/card";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { GitMergeIcon, InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	organizationId: string | null;
	project: { actionItemRoutingEnabled?: boolean };
	canEdit: boolean;
};

export function ActionItemRoutingSettings({
	projectId,
	organizationId,
	project,
	canEdit,
}: Props) {
	const [enabled, setEnabled] = useState(
		project.actionItemRoutingEnabled === true,
	);

	// Keep in step with a refetched project (another tab, another member).
	useEffect(() => {
		setEnabled(project.actionItemRoutingEnabled === true);
	}, [project.actionItemRoutingEnabled]);

	const mutation = useMutation({
		mutationFn: async (next: boolean) =>
			await orpcClient.projects.setActionItemRouting({
				projectId,
				organizationId,
				enabled: next,
			}),
		onSuccess: (_result, next) => {
			setEnabled(next);
			toast.success(
				next
					? "Action items will be checked against existing tickets"
					: "Action items will always be proposed as new tickets",
			);
		},
		onError: () => {
			toast.error("Could not change the routing setting");
		},
	});

	return (
		<Card className="rounded-2xl p-5">
			<div className="flex items-start justify-between gap-3">
				<div className="flex items-start gap-3">
					<GitMergeIcon
						aria-hidden="true"
						className="mt-0.5 size-4 shrink-0 text-muted-foreground"
					/>
					<div>
						<Label
							htmlFor="action-item-routing-toggle"
							className="font-semibold text-sm"
						>
							Match action items to existing tickets
						</Label>
						<p className="mt-1 max-w-prose text-muted-foreground text-xs">
							Before a proposal reaches your review inbox, check
							each action item captured from a meeting or
							monitored chat against this project's open tickets.
							A close match is proposed as an addition to that
							ticket, with a preview of what would change, instead
							of a near-duplicate new one. Nothing is applied
							until you approve it, and you can change any of
							these decisions while reviewing.
						</p>
					</div>
				</div>
				<Switch
					id="action-item-routing-toggle"
					checked={enabled}
					onCheckedChange={(next) => mutation.mutate(next)}
					disabled={!canEdit || mutation.isPending}
					aria-label="Match action items to existing tickets"
				/>
			</div>
			<p className="mt-3 flex items-center gap-1.5 text-muted-foreground/80 text-xs">
				<InfoIcon aria-hidden="true" className="size-3.5 shrink-0" />
				Applies to meeting transcripts and monitored Teams and Slack
				conversations analyzed from now on
			</p>
		</Card>
	);
}
