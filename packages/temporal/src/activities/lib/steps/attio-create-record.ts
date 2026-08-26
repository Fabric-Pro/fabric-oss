/**
 * Attio Create Record Step
 * Creates a new record in Attio CRM
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";

export async function executeAttioCreateRecordStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { objectType, attributes } = params.nodeConfig as {
		objectType?: string;
		attributes?: string | Record<string, unknown>;
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

	let parsedAttributes: Record<string, unknown> = {};
	if (typeof attributes === "string") {
		try {
			parsedAttributes = JSON.parse(attributes);
		} catch {
			return { success: false, error: "Invalid attributes JSON" };
		}
	} else if (attributes) {
		parsedAttributes = attributes;
	}

	try {
		const response = await fetch(
			`https://api.attio.com/v2/objects/${objectType}/records`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${credentials.ATTIO_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ data: { values: parsedAttributes } }),
			},
		);

		const result = (await response.json()) as {
			data?: { id: { record_id: string } };
			error?: string;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.error || `Attio returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				recordId: result.data?.id?.record_id,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Attio record",
		};
	}
}
