/**
 * Webflow: publish a site.
 *
 * A write with an externally visible effect — it makes content live — so it
 * belongs in EXTERNAL_WRITE_NODE_TYPES and must not be auto-retried.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const WEBFLOW_API_URL = "https://api.webflow.com/v2";

type PublishResponse = {
	customDomains?: { url: string }[];
	publishToWebflowSubdomain?: boolean;
};

export async function executeWebflowPublishSiteStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { siteId, publishToWebflowSubdomain, customDomainIds } =
		params.nodeConfig as {
			siteId?: string;
			publishToWebflowSubdomain?: string;
			customDomainIds?: string;
		};

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

	const domains = (customDomainIds ?? "")
		.split(",")
		.map((d) => interpolateTemplate(d, params.inputs).trim())
		.filter(Boolean);

	const body: Record<string, unknown> = {};
	if (domains.length > 0) {
		body.customDomains = domains;
	}
	// Default to the Webflow subdomain when no custom domain was named,
	// otherwise a publish with only custom domains would silently no-op.
	body.publishToWebflowSubdomain =
		publishToWebflowSubdomain === "false" ? domains.length === 0 : true;

	try {
		const id = interpolateTemplate(siteId, params.inputs);
		const response = await fetch(
			`${WEBFLOW_API_URL}/sites/${encodeURIComponent(id)}/publish`,
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${credentials.WEBFLOW_API_KEY}`,
				},
				body: JSON.stringify(body),
			},
		);

		if (!response.ok) {
			const errBody = (await response.json().catch(() => null)) as {
				message?: string;
			} | null;
			return {
				success: false,
				error: errBody?.message ?? `HTTP ${response.status}`,
			};
		}

		const result = (await response.json()) as PublishResponse;
		return {
			success: true,
			output: {
				publishedDomains: result.customDomains?.map((d) => d.url) ?? [],
				publishedToSubdomain: result.publishToWebflowSubdomain ?? false,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to publish Webflow site",
		};
	}
}
