import type { TestConnectionResult } from "../types";

export async function testJiraConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const domain = credentials.JIRA_DOMAIN || credentials.domain || "";
	const email = credentials.JIRA_EMAIL || credentials.email || "";
	const apiToken = credentials.JIRA_API_TOKEN || credentials.apiToken || "";

	if (!domain || !email || !apiToken) {
		return {
			success: false,
			error: "Jira domain, email, and API token are required",
		};
	}

	const normalizedDomain = domain
		.replace(/^https?:\/\//, "")
		.replace(/\/$/, "");
	const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

	try {
		const response = await fetch(
			`https://${normalizedDomain}/rest/api/3/myself`,
			{
				headers: {
					Authorization: `Basic ${auth}`,
					Accept: "application/json",
				},
			},
		);

		if (!response.ok) {
			return {
				success: false,
				error: `Jira returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			displayName?: string;
			emailAddress?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.displayName || data.emailAddress || email}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
