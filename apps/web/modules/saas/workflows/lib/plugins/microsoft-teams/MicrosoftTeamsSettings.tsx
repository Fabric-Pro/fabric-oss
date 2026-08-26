"use client";

/**
 * Microsoft Teams Settings Component
 *
 * Uses the reusable OAuth settings component for Microsoft Teams integration.
 */

import { OAuthSettings } from "../shared/OAuthSettings";
import type { IntegrationSettingsProps } from "../types";
import { MicrosoftTeamsIcon } from "./icon";

export function MicrosoftTeamsSettings({
	onApiKeyChange,
	organizationId,
}: IntegrationSettingsProps) {
	return (
		<OAuthSettings
			provider="MICROSOFT_GRAPH"
			providerName="Microsoft 365"
			providerIcon={MicrosoftTeamsIcon}
			providerColor="text-purple-600"
			description="Access Microsoft Teams messages, channels, and shared files for your AI workflows."
			helpText="Connect your Microsoft account to use Microsoft 365 data in your AI workflows. We request read access to your Teams, channels, messages, files, calendar, meeting transcripts and mailbox, plus permission to post Teams messages, send mail and create calendar events on your behalf."
			helpLink={{
				text: "Learn about Microsoft Graph permissions",
				url: "https://learn.microsoft.com/en-us/graph/permissions-overview",
			}}
			// This list is shown to the user before they connect, so it has to
			// match what the OAuth request actually asks for — see the scopes
			// array in packages/api/modules/integrations/lib/oauth-providers.ts.
			// Understating it means someone consents to more than they were
			// told. offline_access is omitted deliberately: it governs token
			// lifetime rather than access to data.
			scopes={[
				"User.Read",
				"User.ReadBasic.All",
				"Team.ReadBasic.All",
				"Channel.ReadBasic.All",
				"Chat.Read",
				"ChatMessage.Read",
				"ChannelMessage.Read.All",
				// Posting to a connected channel (Fizzy #2013).
				"ChannelMessage.Send",
				// Posting to a 1:1 or group chat.
				"ChatMessage.Send",
				"Files.Read.All",
				"Sites.Read.All",
				"OnlineMeetings.Read",
				"OnlineMeetingTranscript.Read.All",
				"Calendars.Read",
				// Creating calendar events from a workflow action.
				"Calendars.ReadWrite",
				// Reading a mail folder and sending mail from a workflow action.
				"Mail.Read",
				"Mail.Send",
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
