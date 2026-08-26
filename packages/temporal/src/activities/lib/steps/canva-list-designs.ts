/**
 * Canva List Designs Step
 * Lists designs from a Canva account
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeCanvaListDesignsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { query } = params.nodeConfig as {
		query?: string;
	};

	const credentials = await fetchCredentialsByProvider(
		"CANVA",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.CANVA_ACCESS_TOKEN) {
		return {
			success: false,
			error: "Canva API token not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedQuery = query
		? interpolateTemplate(query, params.inputs)
		: "";

	try {
		const url = new URL("https://api.canva.com/rest/v1/designs");
		if (interpolatedQuery) {
			url.searchParams.set("query", interpolatedQuery);
		}

		const response = await fetch(url.toString(), {
			headers: {
				Authorization: `Bearer ${credentials.CANVA_ACCESS_TOKEN}`,
			},
		});

		const result = (await response.json()) as {
			items?: Array<{
				id: string;
				title: string;
				thumbnail?: { url: string };
				urls?: { view_url: string };
			}>;
			error?: { code: string; message: string };
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error?.message ||
					`Canva returned status ${response.status}`,
			};
		}

		const designs = (result.items ?? []).map((d) => ({
			id: d.id,
			name: d.title,
			thumbnail: d.thumbnail?.url,
			url: d.urls?.view_url,
		}));

		return {
			success: true,
			output: {
				designs,
				count: designs.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to list Canva designs",
		};
	}
}
