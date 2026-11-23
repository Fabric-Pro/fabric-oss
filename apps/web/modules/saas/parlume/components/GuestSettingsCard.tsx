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
	GUEST_POLICY_CHOICES,
	type GuestPolicy,
	type ParlumeSettings,
} from "../lib/meeting-assistant-settings";
import { SETTINGS_QUERY_KEY } from "../lib/query-keys";

/**
 * What Parlume does about an external guest the invitation names, from
 * another email domain. Someone who joins and cannot be confirmed as able to
 * read the project makes Parlume leave, whatever this says.
 */
export function GuestSettingsCard({
	organizationId,
	settings,
	readOnly,
}: {
	organizationId: string;
	settings: ParlumeSettings;
	readOnly: boolean;
}) {
	const queryClient = useQueryClient();
	const [policy, setPolicy] = useState<GuestPolicy>(settings.guests.policy);

	const save = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.update({
				organizationId,
				guestPolicy: policy,
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(
				[SETTINGS_QUERY_KEY, organizationId],
				next,
			);
			setPolicy(next.guests.policy);
			toast.success("Guest settings saved.");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not save the settings.")),
	});

	return (
		<SettingsItem
			title="External guests"
			description="What Parlume does when a meeting's invitation names someone from outside your organization. If anyone joins whom Parlume cannot confirm can see the project, it says why in the chat and leaves."
		>
			<div className="space-y-5">
				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">
						When the invitation names a guest
					</legend>
					<RadioGroup
						value={policy}
						onValueChange={(value) => {
							const choice = GUEST_POLICY_CHOICES.find(
								(option) => option.value === value,
							);
							if (choice) {
								setPolicy(choice.value);
							}
						}}
						disabled={readOnly || save.isPending}
					>
						{GUEST_POLICY_CHOICES.map((option) => (
							<div
								key={option.value}
								className="flex items-start gap-2.5"
							>
								<RadioGroupItem
									value={option.value}
									id={`parlume-guests-${option.value}`}
									className="mt-0.5"
								/>
								<Label
									htmlFor={`parlume-guests-${option.value}`}
									className="grid gap-0.5 font-normal"
								>
									<span>{option.label}</span>
									<span className="text-xs text-muted-foreground">
										{option.description}
									</span>
								</Label>
							</div>
						))}
					</RadioGroup>
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
