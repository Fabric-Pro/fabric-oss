import type { TestConnectionResult } from "../types";

export async function testBitbucketConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const email = credentials.BITBUCKET_EMAIL || credentials.email || "";
	const apiToken =
		credentials.BITBUCKET_API_TOKEN || credentials.apiToken || "";

	if (!email || !apiToken) {
		return {
			success: false,
			error: "Bitbucket account email and API token are required",
		};
	}

	const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");

	try {
		const response = await fetch("https://api.bitbucket.org/2.0/user", {
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: "application/json",
			},
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Bitbucket returned status ${response.status}`,
			};
		}

		const data = (await response.json()) as {
			username?: string;
			display_name?: string;
			account_id?: string;
		};
		return {
			success: true,
			message: `Connected as ${data.display_name || data.username || data.account_id || "your Bitbucket account"}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Connection failed",
		};
	}
}
