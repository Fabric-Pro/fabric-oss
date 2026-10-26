/**
 * Whether a link is a Microsoft Teams meeting Parlume can be invited to. Kept
 * apart from the Attendee client, whose outbound guard is server-only, so the
 * invite form can check a link as it is typed.
 */
export function isTeamsMeetingUrl(value: string): boolean {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:") {
			return false;
		}
		const host = url.hostname.toLowerCase();
		return [
			"teams.microsoft.com",
			"teams.live.com",
			"teams.microsoft.us",
			"teams.microsoft.de",
			"teams.cloud.microsoft",
		].includes(host);
	} catch {
		return false;
	}
}
