"use client";

import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { NotionIcon } from "./icon";

export function NotionSettings({
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	return (
		<OAuthSettings
			provider="NOTION"
			providerName="Notion"
			providerIcon={NotionIcon}
			description="Connect your Notion workspace so Fabric can search pages and use Notion actions in workflows."
			helpText="Connect a Notion account to authorize Fabric using OAuth. Fabric can then reuse that connection for searchable sync and runtime actions."
			helpLink={{
				text: "Learn about Notion integrations",
				url: "https://developers.notion.com/docs/create-a-notion-integration",
			}}
			scopes={["read content", "update content", "read user information"]}
			organizationId={organizationId}
			onConnectionChange={(connected) => {
				onApiKeyChange(connected ? "oauth_connected" : "");
			}}
		/>
	);
}
