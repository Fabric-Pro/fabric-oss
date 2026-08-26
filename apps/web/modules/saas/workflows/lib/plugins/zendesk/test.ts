import type { TestConnectionResult } from "../types";

export async function testZendeskConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const subdomain =
		credentials.ZENDESK_SUBDOMAIN || credentials.subdomain || "";
	const email = credentials.ZENDESK_EMAIL || credentials.email || "";
	const token = credentials.ZENDESK_TOKEN || credentials.token || "";

	if (!subdomain || !email || !token) {
		return {
			success: false,
			error: "Zendesk subdomain, email, and token are required",
		};
	}

	const auth = Buffer.from(`${email}/token:${token}`).toString("base64");

	try {
		const response = await fetch(
			`https://${subdomain}.zendesk.com/api/v2/users/me.json`,
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
				error: `Zendesk returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			user?: { name?: string; email?: string };
		};
		return {
			success: true,
			message: `Connected as ${data.user?.name || data.user?.email || email}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
