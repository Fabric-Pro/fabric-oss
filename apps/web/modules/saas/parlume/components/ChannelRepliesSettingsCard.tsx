"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useState } from "react";
import { toast } from "sonner";
import {
	errorMessage,
	type ParlumeSettings,
} from "../lib/meeting-assistant-settings";
import { SETTINGS_QUERY_KEY } from "../lib/query-keys";

/** The radio value for "no shared account": the inviter's own connection. */
const INVITER = "inviter";

/**
 * The Microsoft account Parlume replies with in a Teams channel meeting's
 * thread. Channel replies go through Microsoft Graph as a person, so without
 * a choice here they appear as the person who invited Parlume.
 */
export function ChannelRepliesSettingsCard({
	organizationId,
	settings,
	readOnly,
}: {
	organizationId: string;
	settings: ParlumeSettings;
	readOnly: boolean;
}) {
	const queryClient = useQueryClient();
	const { connections } = settings.channel;
	const [choice, setChoice] = useState(
		settings.channel.integrationId ?? INVITER,
	);

	const save = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.update({
				organizationId,
				channelIntegrationId: choice === INVITER ? null : choice,
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(
				[SETTINGS_QUERY_KEY, organizationId],
				next,
			);
			setChoice(next.channel.integrationId ?? INVITER);
			toast.success("Channel reply settings saved.");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not save the settings.")),
	});

	return (
		<SettingsItem
			title="Channel replies"
			description="In a meeting held in a Teams channel, Parlume answers in the channel's thread through a Microsoft connection. Choose a Parlume account your organization shares, so replies do not appear as the person who invited Parlume."
		>
			<div className="space-y-5">
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">
						Reply in channels as
					</legend>
					<RadioGroup
						value={choice}
						onValueChange={setChoice}
						disabled={readOnly || save.isPending}
					>
						<div className="flex items-start gap-2.5">
							<RadioGroupItem
								value={INVITER}
								id="parlume-channel-inviter"
								className="mt-0.5"
							/>
							<Label
								htmlFor="parlume-channel-inviter"
								className="grid gap-0.5 font-normal"
							>
								<span>
									The inviter's own Microsoft connection
								</span>
								<span className="text-xs text-muted-foreground">
									Replies appear as the person who invited
									Parlume, or who turned on the auto-join.
								</span>
							</Label>
						</div>
						{connections.map((connection) => (
							<div
								key={connection.id}
								className="flex items-start gap-2.5"
							>
								<RadioGroupItem
									value={connection.id}
									id={`parlume-channel-${connection.id}`}
									className="mt-0.5"
								/>
								<Label
									htmlFor={`parlume-channel-${connection.id}`}
									className="grid gap-0.5 font-normal"
								>
									<span>{connection.name}</span>
									{connection.connectedBy && (
										<span className="text-xs text-muted-foreground">
											Connected by{" "}
											{connection.connectedBy}
										</span>
									)}
								</Label>
							</div>
						))}
					</RadioGroup>
					<p className="text-xs text-muted-foreground">
						{connections.length === 0
							? "Your organization shares no Microsoft connection yet. Connect the Parlume account under Integrations and share it with the organization."
							: "The account must be a member of each channel Parlume meets in. Where it is not, channel replies are unavailable and the page says so."}
					</p>
				</fieldset>

				{!readOnly && (
					<Button
						type="button"
						autoLoading={false}
						onClick={() => save.mutate()}
						disabled={save.isPending}
					>
						{save.isPending ? "Saving…" : "Save"}
					</Button>
				)}
			</div>
		</SettingsItem>
	);
}
