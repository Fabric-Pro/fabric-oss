"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useEffect, useState } from "react";
import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { HubSpotIcon } from "./icon";

type AuthMode = "oauth" | "manual";

export function HubSpotSettings({
	apiKey,
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	const [authMode, setAuthMode] = useState<AuthMode>("oauth");

	useEffect(() => {
		if (apiKey && apiKey !== "oauth_connected") {
			setAuthMode("manual");
			return;
		}

		setAuthMode("oauth");
	}, [apiKey]);

	return (
		<div className="space-y-4">
			<div className="inline-flex rounded-lg border p-1">
				<Button
					type="button"
					size="sm"
					variant={authMode === "oauth" ? "secondary" : "ghost"}
					onClick={() => {
						setAuthMode("oauth");
						onApiKeyChange("oauth_connected");
					}}
				>
					Use OAuth
				</Button>
				<Button
					type="button"
					size="sm"
					variant={authMode === "manual" ? "secondary" : "ghost"}
					onClick={() => {
						setAuthMode("manual");
						if (apiKey === "oauth_connected") {
							onApiKeyChange("");
						}
					}}
				>
					Use Access Token
				</Button>
			</div>

			{authMode === "oauth" ? (
				<OAuthSettings
					provider="HUBSPOT"
					providerName="HubSpot"
					providerIcon={HubSpotIcon}
					description="Connect HubSpot so Fabric can search CRM data and run HubSpot actions in workflows."
					helpText="Use OAuth for the simplest setup, or switch to an access token if you prefer a manual credential."
					helpLink={{
						text: "Learn about HubSpot OAuth",
						url: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth",
					}}
					scopes={[
						"crm.objects.contacts.read",
						"crm.objects.contacts.write",
					]}
					organizationId={organizationId}
					onConnectionChange={(connected) => {
						onApiKeyChange(connected ? "oauth_connected" : "");
					}}
				/>
			) : (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="hubspot-access-token">
							HubSpot Access Token
						</Label>
						<Input
							id="hubspot-access-token"
							type="password"
							value={apiKey === "oauth_connected" ? "" : apiKey}
							onChange={(event) =>
								onApiKeyChange(event.target.value)
							}
							placeholder="pat-na1-..."
							autoComplete="new-password"
							data-lpignore="true"
							data-1p-ignore="true"
						/>
					</div>
					<p className="text-sm text-muted-foreground">
						Get your token from HubSpot Settings → Integrations →
						Private Apps.
					</p>
				</div>
			)}
		</div>
	);
}
