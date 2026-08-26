/**
 * Attio Search Records Step
 * Searches for records in Attio CRM
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeAttioSearchRecordsStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { objectType, query, limit } = params.nodeConfig as {
		objectType?: string;
		query?: string;
		limit?: string | number;
	};

	if (!objectType) {
		return { success: false, error: "Object type is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"ATTIO",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.ATTIO_API_KEY) {
		return {
			success: false,
			error: "Attio API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedQuery = query
		? interpolateTemplate(query, params.inputs)
		: "";
	const maxResults = Number(limit) || 10;

	try {
		const response = await fetch(
			`https://api.attio.com/v2/objects/${objectType}/records/query`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.ATTIO_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					limit: maxResults,
					...(interpolatedQuery
						? {
								filter: {
									name: {
										$contains: interpolatedQuery,
									},
								},
							}
						: {}),
				}),
			},
		);

		const result = (await response.json()) as {
			data?: Array<Record<string, unknown>>;
			error?: string;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error || `Attio returned status ${response.status}`,
			};
		}

		const records = result.data ?? [];
		return {
			success: true,
			output: {
				records,
				count: records.length,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to search Attio records",
		};
	}
}
