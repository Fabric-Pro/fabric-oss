"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useEffect, useState } from "react";
import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { AsanaIcon } from "./icon";

type AuthMode = "oauth" | "manual";

export function AsanaSettings({
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
					provider="ASANA"
					providerName="Asana"
					providerIcon={AsanaIcon}
					description="Connect your Asana workspace so Fabric can search tasks and use Asana actions in workflows."
					helpText="Use OAuth for the simplest setup, or switch to an access token if you prefer a manual credential."
					helpLink={{
						text: "Learn about Asana OAuth",
						url: "https://developers.asana.com/docs/oauth",
					}}
					scopes={["default"]}
					organizationId={organizationId}
					onConnectionChange={(connected) => {
						onApiKeyChange(connected ? "oauth_connected" : "");
					}}
				/>
			) : (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="asana-api-key">
							Asana Personal Access Token
						</Label>
						<Input
							id="asana-api-key"
							type="password"
							value={apiKey === "oauth_connected" ? "" : apiKey}
							onChange={(event) =>
								onApiKeyChange(event.target.value)
							}
							placeholder="0/123456789abcdef"
							autoComplete="new-password"
							data-lpignore="true"
							data-1p-ignore="true"
						/>
					</div>
					<p className="text-sm text-muted-foreground">
						Get your token from Asana Settings → Apps → Developer
						Apps → Personal Access Token.
					</p>
					<a
						href="https://developers.asana.com/docs/personal-access-token"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
					>
						How to get Asana token
					</a>
				</div>
			)}
		</div>
	);
}
