"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { LoaderIcon, LockIcon } from "lucide-react";
import { SETTINGS_QUERY_KEY } from "../lib/query-keys";
import { MeetingBotSettingsCard } from "./MeetingBotSettingsCard";
import { VoiceSettingsCard } from "./VoiceSettingsCard";

/**
 * Everything Parlume needs that an organization configures for itself: its
 * meeting bot and its voice. The media bridge is the Fabric operator's and is
 * not shown here.
 */
export function MeetingAssistantSettings({
	organizationId,
	aiProvidersHref,
	readOnly,
}: {
	organizationId: string;
	aiProvidersHref: string;
	readOnly: boolean;
}) {
	const query = useQuery({
		queryKey: [SETTINGS_QUERY_KEY, organizationId],
		queryFn: () => orpcClient.parlumeSettings.get({ organizationId }),
		retry: false,
	});

	if (query.isLoading) {
		return (
			<div className="flex justify-center py-8">
				<LoaderIcon
					className="size-6 motion-safe:animate-spin text-muted-foreground"
					aria-label="Loading"
				/>
			</div>
		);
	}
	if (!query.data) {
		return (
			<div className="space-y-2" role="alert">
				<p className="text-sm text-destructive">
					Could not load the meeting assistant settings.
				</p>
				<Button
					type="button"
					variant="outline"
					size="sm"
					autoLoading={false}
					onClick={() => query.refetch()}
				>
					Retry
				</Button>
			</div>
		);
	}

	return (
		<>
			{readOnly && (
				<p className="flex items-center gap-2 rounded-md border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
					<LockIcon className="size-4 shrink-0" aria-hidden="true" />
					Only organization owners and admins can change these
					settings.
				</p>
			)}
			<MeetingBotSettingsCard
				organizationId={organizationId}
				settings={query.data}
				readOnly={readOnly}
			/>
			<VoiceSettingsCard
				organizationId={organizationId}
				settings={query.data}
				aiProvidersHref={aiProvidersHref}
				readOnly={readOnly}
			/>
		</>
	);
}
