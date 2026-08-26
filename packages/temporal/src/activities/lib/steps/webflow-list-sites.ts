/** Webflow: list the sites a token can access. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

type WebflowSite = {
	id: string;
	displayName: string;
	shortName: string;
	previewUrl?: string;
	lastPublished?: string;
	lastUpdated?: string;
	customDomains?: { url: string }[];
};

export async function executeWebflowListSitesStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const credentials = await fetchCredentialsByProvider(
		"WEBFLOW",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.WEBFLOW_API_KEY) {
		return {
			success: false,
			error: "Webflow API token not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		const response = await fetch(`${WEBFLOW_API_URL}/sites`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${credentials.WEBFLOW_API_KEY}`,
			},
		});

		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			return {
				success: false,
				error: body?.message ?? `HTTP ${response.status}`,
			};
		}

		const data = (await response.json()) as { sites: WebflowSite[] };
		const sites = (data.sites ?? []).map((site) => ({
			id: site.id,
			displayName: site.displayName,
			shortName: site.shortName,
			previewUrl: site.previewUrl,
			lastPublished: site.lastPublished,
			customDomains: site.customDomains?.map((d) => d.url) ?? [],
		}));

		return { success: true, output: { sites, count: sites.length } };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list Webflow sites",
		};
	}
}
