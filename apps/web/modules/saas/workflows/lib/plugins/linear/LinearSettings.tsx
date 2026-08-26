"use client";

import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useEffect, useState } from "react";
import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { LinearIcon } from "./icon";

type AuthMode = "oauth" | "manual";

export function LinearSettings({
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
					provider="LINEAR"
					providerName="Linear"
					providerIcon={LinearIcon}
					description="Connect Linear so Fabric can search issues and use Linear actions in workflows."
					helpText="Use OAuth for the simplest setup, or switch to an access token if you prefer a manual credential."
					helpLink={{
						text: "Learn about Linear OAuth",
						url: "https://developers.linear.app/docs/oauth/authentication",
					}}
					scopes={[
						"read",
						"write",
						"issues:create",
						"comments:create",
					]}
					organizationId={organizationId}
					onConnectionChange={(connected) => {
						onApiKeyChange(connected ? "oauth_connected" : "");
					}}
				/>
			) : (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="linear-api-key">
							Linear Access Token
						</Label>
						<Input
							id="linear-api-key"
							type="password"
							value={apiKey === "oauth_connected" ? "" : apiKey}
							onChange={(event) =>
								onApiKeyChange(event.target.value)
							}
							placeholder="lin_api_..."
							autoComplete="new-password"
							data-lpignore="true"
							data-1p-ignore="true"
						/>
					</div>
					<p className="text-sm text-muted-foreground">
						Get your token from Linear Settings → Security & access
						→ Personal API keys.
					</p>
				</div>
			)}
		</div>
	);
}
