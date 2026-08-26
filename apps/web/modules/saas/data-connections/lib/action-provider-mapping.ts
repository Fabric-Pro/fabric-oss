import type { IntegrationType } from "@saas/workflows/lib/plugins";
import type { DataConnectionProvider } from "./providers";

/**
 * Maps a `DataConnectionProvider` (the Search/Sync side of an integration) to
 * the matching workflow `IntegrationType` (the Actions side), or `null` when
 * no Actions plugin exists for the provider yet.
 */
export function mapDataConnectionProviderToActionProvider(
	provider: DataConnectionProvider,
): IntegrationType | null {
	switch (provider) {
		case "ASANA":
			return "ASANA";
		case "CONFLUENCE":
			return "CONFLUENCE";
		case "CLICKUP":
			return "CLICKUP";
		case "BITBUCKET":
			return "BITBUCKET";
		case "GITHUB":
			return "GITHUB";
		case "GITLAB":
			return "GITLAB";
		case "GMAIL":
			return "GMAIL";
		case "GOOGLE_DRIVE":
			return "GOOGLE_DRIVE";
		case "HUBSPOT":
			return "HUBSPOT";
		case "INTERCOM":
			return "INTERCOM";
		case "JIRA":
			return "JIRA";
		case "LINEAR":
			return "LINEAR";
		case "TEAMS":
			return "MICROSOFT_GRAPH";
		case "NOTION":
			return "NOTION";
		case "SALESFORCE":
			return "SALESFORCE";
		case "SLACK":
			return "SLACK";
		case "ZENDESK":
			return "ZENDESK";
		default:
			return null;
	}
}
