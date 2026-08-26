"use client";

/**
 * Google Drive Settings Component
 *
 * Uses the reusable OAuth settings component for Google Drive integration.
 */

import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { GoogleDriveIcon } from "./icon";

export function GoogleDriveSettings({
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	return (
		<OAuthSettings
			provider="GOOGLE_DRIVE"
			providerName="Google Drive"
			providerIcon={GoogleDriveIcon}
			providerColor="text-highlight"
			description="Access documents and folders from Google Drive as knowledge sources for your workflows, and pick Google Docs directly into a project's context."
			helpText="Connect your Google account to enable Drive knowledge sync and the Google Docs project-context picker."
			helpLink={{
				text: "Learn about Google Drive permissions",
				url: "https://developers.google.com/drive/api/guides/about-auth",
			}}
			scopes={[
				"drive.readonly",
				"drive.file",
				"userinfo.profile",
				"userinfo.email",
			]}
			organizationId={organizationId}
			onConnectionChange={(connected) => {
				// Notify parent that connection state changed
				// The actual credentials are stored server-side
				if (connected) {
					onApiKeyChange("oauth_connected");
				} else {
					onApiKeyChange("");
				}
			}}
		/>
	);
}
