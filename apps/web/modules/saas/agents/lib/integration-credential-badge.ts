/**
 * The badge the agent builder's integration list puts on an integration that
 * cannot be used right now (`hasCredentials: false`), or none for one that
 * can. A GitLab connection whose grant died is reported with
 * `connectionState: "needs-reconnect"`: it exists and must be reconnected, so
 * it reads "Reconnect" rather than "No creds", matching every other GitLab
 * screen.
 */
export function integrationCredentialBadge(integration: {
	hasCredentials: boolean;
	connectionState?: "connected" | "needs-reconnect" | "not-connected";
}): "Reconnect" | "No creds" | null {
	if (integration.hasCredentials) {
		return null;
	}
	return integration.connectionState === "needs-reconnect"
		? "Reconnect"
		: "No creds";
}
