"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useState } from "react";
import { toast } from "sonner";
import {
	describeAttendeeCheck,
	errorMessage,
	type ParlumeSettings,
	TEAMS_LOGIN_CHOICES,
	type TeamsLoginChoice,
	teamsChoiceFrom,
	teamsModeFrom,
} from "../lib/meeting-assistant-settings";
import { SETTINGS_QUERY_KEY } from "../lib/query-keys";
import { SettingsCheckResult } from "./SettingsCheckResult";

function sourceSentence(
	source: ParlumeSettings["attendee"]["effectiveSource"],
): string {
	switch (source) {
		case "organization":
			return "Invitations use your organization's Attendee key.";
		case "environment":
			return "Invitations use the Attendee project the Fabric operator set up. Add a key to use your own.";
		case null:
			return "No meeting bot is configured. Add an Attendee API key so Parlume can join meetings.";
		default: {
			const unknown: never = source;
			throw new Error(`Unsupported source: ${String(unknown)}`);
		}
	}
}

/**
 * The Attendee project Parlume's meeting bot runs on. The key, URL, Teams
 * sign-in mode and login group belong together: they apply only with the
 * organization's own key, and removing the key removes them all.
 */
export function MeetingBotSettingsCard({
	organizationId,
	settings,
	readOnly,
}: {
	organizationId: string;
	settings: ParlumeSettings;
	readOnly: boolean;
}) {
	const queryClient = useQueryClient();
	const saved = settings.attendee;
	const [apiKey, setApiKey] = useState("");
	const [webhookSecret, setWebhookSecret] = useState("");
	const [baseUrl, setBaseUrl] = useState(saved.baseUrl ?? "");
	const [teamsChoice, setTeamsChoice] = useState<TeamsLoginChoice>(
		teamsChoiceFrom(saved.teamsLoginMode),
	);
	const [loginGroup, setLoginGroup] = useState(saved.teamsLoginGroup ?? "");
	// A login group names the account a signed-in bot uses.
	const signsIn = teamsChoice !== "anonymous";
	const [check, setCheck] = useState<{ ok: boolean; message: string } | null>(
		null,
	);

	const applySaved = (next: ParlumeSettings) => {
		queryClient.setQueryData([SETTINGS_QUERY_KEY, organizationId], next);
		setApiKey("");
		setWebhookSecret("");
		setBaseUrl(next.attendee.baseUrl ?? "");
		setTeamsChoice(teamsChoiceFrom(next.attendee.teamsLoginMode));
		setLoginGroup(next.attendee.teamsLoginGroup ?? "");
	};

	const save = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.update({
				organizationId,
				attendeeApiKey: apiKey,
				attendeeWebhookSecret: webhookSecret,
				attendeeBaseUrl: baseUrl.trim() || null,
				teamsLoginMode: teamsModeFrom(teamsChoice),
				teamsLoginGroup: signsIn ? loginGroup.trim() || null : null,
			}),
		onSuccess: (next) => {
			applySaved(next);
			toast.success("Meeting bot settings saved.");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not save the settings.")),
	});

	const remove = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.update({
				organizationId,
				clearAttendeeApiKey: true,
			}),
		onSuccess: (next) => {
			applySaved(next);
			setCheck(null);
			toast.success("The organization's Attendee key was removed.");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not remove the key.")),
	});

	const test = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.testAttendee({
				organizationId,
				attendeeApiKey: apiKey,
				attendeeBaseUrl: baseUrl.trim() || null,
			}),
		onMutate: () => setCheck(null),
		onSuccess: (result) => setCheck(describeAttendeeCheck(result)),
		onError: (error) =>
			setCheck({
				ok: false,
				message: errorMessage(error, "The connection test failed."),
			}),
	});

	const busy = save.isPending || remove.isPending || test.isPending;
	const hasOwnKey = saved.maskedApiKey !== null;
	// The saved key only goes to the URL it was saved with, so a new URL
	// needs the key typed again (the server refuses it otherwise).
	const keyRequired = hasOwnKey && baseUrl.trim() !== (saved.baseUrl ?? "");
	const missingKey = keyRequired && !apiKey.trim();

	return (
		<SettingsItem
			title="Meeting bot"
			description="Parlume joins Teams meetings through Attendee. Use your organization's own Attendee project, or leave this empty to use the one the Fabric operator set up."
		>
			<div className="space-y-5">
				<p
					className="text-sm text-muted-foreground"
					data-testid="attendee-source"
				>
					{sourceSentence(saved.effectiveSource)}
				</p>

				<div className="space-y-2">
					<Label htmlFor="parlume-attendee-key">
						Attendee API key
					</Label>
					<Input
						id="parlume-attendee-key"
						type="password"
						autoComplete="off"
						value={apiKey}
						onChange={(event) => setApiKey(event.target.value)}
						placeholder={
							hasOwnKey && !keyRequired
								? `Saved key ${saved.maskedApiKey}. Leave empty to keep it.`
								: "Paste the API key from the Attendee dashboard"
						}
						required={keyRequired}
						aria-describedby={
							keyRequired
								? "parlume-attendee-key-hint"
								: undefined
						}
						disabled={readOnly || busy}
					/>
					{keyRequired && (
						<p
							id="parlume-attendee-key-hint"
							className="text-xs text-muted-foreground"
						>
							Enter the key again to use it with a different
							Attendee URL.
						</p>
					)}
					{hasOwnKey && !readOnly && (
						<Button
							type="button"
							variant="link"
							size="sm"
							className="h-auto px-0"
							autoLoading={false}
							onClick={() => remove.mutate()}
							disabled={busy}
						>
							Remove the saved key
						</Button>
					)}
				</div>

				<div className="space-y-2">
					<Label htmlFor="parlume-attendee-webhook-secret">
						Attendee webhook secret
					</Label>
					<Input
						id="parlume-attendee-webhook-secret"
						type="password"
						autoComplete="off"
						value={webhookSecret}
						onChange={(event) =>
							setWebhookSecret(event.target.value)
						}
						placeholder={
							saved.hasWebhookSecret
								? "Saved. Leave empty to keep it."
								: "Paste the secret from Settings → Webhooks in the Attendee dashboard"
						}
						aria-describedby="parlume-attendee-webhook-secret-hint"
						disabled={readOnly || busy}
					/>
					<p
						id="parlume-attendee-webhook-secret-hint"
						className="text-xs text-muted-foreground"
					>
						Attendee signs every event it sends with this secret.
						Once it is saved, Fabric refuses events whose signature
						does not match.
					</p>
				</div>

				<div className="space-y-2">
					<Label htmlFor="parlume-attendee-url">Attendee URL</Label>
					<Input
						id="parlume-attendee-url"
						type="url"
						value={baseUrl}
						onChange={(event) => setBaseUrl(event.target.value)}
						placeholder={settings.defaults.attendeeBaseUrl}
						disabled={readOnly || busy}
						aria-describedby="parlume-attendee-url-hint"
					/>
					<p
						id="parlume-attendee-url-hint"
						className="text-xs text-muted-foreground"
					>
						Only for a self-hosted Attendee. Empty uses{" "}
						{settings.defaults.attendeeBaseUrl}.
					</p>
				</div>

				<fieldset className="space-y-2">
					<legend className="text-sm font-medium">
						Teams sign-in
					</legend>
					<RadioGroup
						value={teamsChoice}
						onValueChange={(value) => {
							const choice = TEAMS_LOGIN_CHOICES.find(
								(option) => option.value === value,
							);
							if (choice) {
								setTeamsChoice(choice.value);
							}
						}}
						disabled={readOnly || busy}
					>
						{TEAMS_LOGIN_CHOICES.map((option) => (
							<div
								key={option.value}
								className="flex items-start gap-2.5"
							>
								<RadioGroupItem
									value={option.value}
									id={`parlume-teams-${option.value}`}
									className="mt-0.5"
								/>
								<Label
									htmlFor={`parlume-teams-${option.value}`}
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
					<p className="text-xs text-muted-foreground">
						The Microsoft 365 account the bot signs in with is set
						up in the Attendee dashboard; Fabric cannot set it.
					</p>
				</fieldset>

				{signsIn && (
					<div className="space-y-2">
						<Label htmlFor="parlume-teams-login-group">
							Teams login group
						</Label>
						<Input
							id="parlume-teams-login-group"
							value={loginGroup}
							onChange={(event) =>
								setLoginGroup(event.target.value)
							}
							placeholder="The project's oldest login group"
							maxLength={120}
							autoComplete="off"
							disabled={readOnly || busy}
							aria-describedby="parlume-teams-login-group-hint"
						/>
						<p
							id="parlume-teams-login-group-hint"
							className="text-xs text-muted-foreground"
						>
							The name of the Teams login group in your Attendee
							project whose account the bot signs in with, so
							meetings see your organization's own Parlume
							account. Empty uses the project's oldest group.
						</p>
					</div>
				)}

				{check && (
					<SettingsCheckResult
						ok={check.ok}
						message={check.message}
					/>
				)}

				{!readOnly && (
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							autoLoading={false}
							onClick={() => save.mutate()}
							disabled={busy || missingKey}
						>
							{save.isPending ? "Saving…" : "Save"}
						</Button>
						<Button
							type="button"
							variant="outline"
							autoLoading={false}
							onClick={() => test.mutate()}
							disabled={busy || missingKey}
						>
							{test.isPending ? "Testing…" : "Test connection"}
						</Button>
					</div>
				)}
			</div>
		</SettingsItem>
	);
}
