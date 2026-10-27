"use client";

import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import {
	errorMessage,
	type ParlumeRealtimeCheck,
	type ParlumeSettings,
	realtimeHostLabel,
} from "../lib/meeting-assistant-settings";
import { SETTINGS_QUERY_KEY } from "../lib/query-keys";
import { SettingsCheckResult } from "./SettingsCheckResult";

function hostResult(host: ParlumeRealtimeCheck): {
	ok: boolean;
	message: string;
} {
	const name = `${realtimeHostLabel(host.provider)} (${host.model})`;
	if (host.ok) {
		return { ok: true, message: `${name}: ready for realtime voice.` };
	}
	const reason = [host.status ? `HTTP ${host.status}` : null, host.message]
		.filter(Boolean)
		.join(": ");
	return {
		ok: false,
		message: `${name} refused${reason ? ` (${reason})` : ""}.`,
	};
}

/**
 * Parlume's realtime voice runs on the organization's Azure AI Foundry
 * resource or OpenAI key, which live on the AI providers page. Only the Azure
 * deployment name is set here.
 */
export function VoiceSettingsCard({
	organizationId,
	settings,
	aiProvidersHref,
	readOnly,
}: {
	organizationId: string;
	settings: ParlumeSettings;
	aiProvidersHref: string;
	readOnly: boolean;
}) {
	const queryClient = useQueryClient();
	const saved = settings.voice.realtimeDeployment ?? "";
	const [deployment, setDeployment] = useState(saved);
	const [results, setResults] = useState<Array<{
		ok: boolean;
		message: string;
	}> | null>(null);

	const save = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.update({
				organizationId,
				realtimeDeployment: deployment.trim() || null,
			}),
		onSuccess: (next) => {
			queryClient.setQueryData(
				[SETTINGS_QUERY_KEY, organizationId],
				next,
			);
			setDeployment(next.voice.realtimeDeployment ?? "");
			toast.success("Voice settings saved.");
		},
		onError: (error) =>
			toast.error(errorMessage(error, "Could not save the settings.")),
	});

	const test = useMutation({
		mutationFn: () =>
			orpcClient.parlumeSettings.testRealtimeVoice({ organizationId }),
		onMutate: () => setResults(null),
		onSuccess: ({ hosts }) =>
			setResults(
				hosts.length
					? hosts.map(hostResult)
					: [
							{
								ok: false,
								message:
									"No Azure AI Foundry resource or OpenAI key is configured for realtime voice.",
							},
						],
			),
		onError: (error) =>
			setResults([
				{
					ok: false,
					message: errorMessage(error, "The voice test failed."),
				},
			]),
	});

	const busy = save.isPending || test.isPending;
	const unsaved = deployment.trim() !== saved;

	return (
		<SettingsItem
			title="Voice"
			description="Parlume answers aloud with a realtime voice model on your organization's Azure AI Foundry resource or OpenAI key."
		>
			<div className="space-y-5">
				<p className="text-sm text-muted-foreground">
					The keys are set in{" "}
					<Link
						href={aiProvidersHref}
						className="text-foreground underline underline-offset-4"
					>
						AI providers
					</Link>
					. Azure AI Foundry is tried first, then OpenAI.
				</p>

				<div className="space-y-2">
					<Label htmlFor="parlume-realtime-deployment">
						Azure realtime deployment
					</Label>
					<Input
						id="parlume-realtime-deployment"
						value={deployment}
						onChange={(event) => setDeployment(event.target.value)}
						placeholder={settings.defaults.realtimeDeployment}
						disabled={readOnly || busy}
						aria-describedby="parlume-realtime-deployment-hint"
					/>
					<p
						id="parlume-realtime-deployment-hint"
						className="text-xs text-muted-foreground"
					>
						The name of the deployment in your Azure resource that
						serves {settings.defaults.realtimeDeployment}. Empty
						uses a deployment named{" "}
						{settings.defaults.realtimeDeployment}. The deployment
						must exist in Azure; Fabric cannot create it.
					</p>
				</div>

				{results && (
					<div className="space-y-1.5">
						{results.map((result) => (
							<SettingsCheckResult
								key={result.message}
								ok={result.ok}
								message={result.message}
							/>
						))}
					</div>
				)}

				{!readOnly && (
					<div className="flex flex-wrap items-center gap-2">
						<Button
							type="button"
							autoLoading={false}
							onClick={() => save.mutate()}
							disabled={busy}
						>
							{save.isPending ? "Saving…" : "Save"}
						</Button>
						<Button
							type="button"
							variant="outline"
							autoLoading={false}
							onClick={() => test.mutate()}
							disabled={busy || unsaved}
						>
							{test.isPending
								? "Testing…"
								: "Test realtime voice"}
						</Button>
						{unsaved && (
							<span className="text-xs text-muted-foreground">
								Save the deployment name to test it.
							</span>
						)}
					</div>
				)}
			</div>
		</SettingsItem>
	);
}
