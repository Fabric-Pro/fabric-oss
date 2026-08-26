/**
 * Freshservice Integration Test Functions
 */

import type { TestConnectionResult } from "../types";

export async function testFreshserviceConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	try {
		const apiKey = credentials.FRESHSERVICE_API_KEY;
		const domain = credentials.FRESHSERVICE_DOMAIN;

		if (!apiKey || !domain) {
			return {
				success: false,
				error: "FRESHSERVICE_API_KEY and FRESHSERVICE_DOMAIN are required",
			};
		}

		const cleanDomain = domain
			.replace(/^https?:\/\//, "")
			.replace(/\/$/, "");
		const encoded = btoa(`${apiKey}:X`);

		const response = await fetch(
			`https://${cleanDomain}/api/v2/agents/me`,
			{
				headers: {
					Authorization: `Basic ${encoded}`,
					"Content-Type": "application/json",
				},
			},
		);

		if (response.ok) {
			const data = (await response.json()) as {
				agent?: { email?: string; first_name?: string };
			};
			const name = data.agent?.first_name || "agent";
			return {
				success: true,
				message: `Freshservice connection successful. Connected as ${name}`,
			};
		}

		if (response.status === 401) {
			return {
				success: false,
				error: "Invalid API key or domain. Please check your Freshservice credentials.",
			};
		}

		const errorText = await response.text();
		return {
			success: false,
			error: `Freshservice returned status ${response.status}: ${errorText}`,
		};
	} catch (error) {
		return {
			success: false,
			error: error instanceof Error ? error.message : "Unknown error",
		};
	}
}
