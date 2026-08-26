/** Webflow: fetch a single site. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

type WebflowSite = {
	id: string;
	displayName: string;
	shortName: string;
	previewUrl?: string;
	lastPublished?: string;
	customDomains?: { url: string }[];
};

export async function executeWebflowGetSiteStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { siteId } = params.nodeConfig as { siteId?: string };

	if (!siteId) {
		return { success: false, error: "Site ID is required" };
	}

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
		const id = interpolateTemplate(siteId, params.inputs);
		const response = await fetch(
			`${WEBFLOW_API_URL}/sites/${encodeURIComponent(id)}`,
			{
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${credentials.WEBFLOW_API_KEY}`,
				},
			},
		);

		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			return {
				success: false,
				error: body?.message ?? `HTTP ${response.status}`,
			};
		}

		const site = (await response.json()) as WebflowSite;
		return {
			success: true,
			output: {
				id: site.id,
				displayName: site.displayName,
				shortName: site.shortName,
				previewUrl: site.previewUrl,
				lastPublished: site.lastPublished,
				customDomains: site.customDomains?.map((d) => d.url) ?? [],
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch Webflow site",
		};
	}
}
