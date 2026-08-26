/** Superagent: classify text for prompt injection and policy violations. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

type GuardResponse = {
	classification?: string;
	violation_types?: string[];
	cwe_codes?: string[];
	reasoning?: string;
};

export async function executeSuperagentGuardStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { text } = params.nodeConfig as { text?: string };

	if (!text) {
		return { success: false, error: "Text is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"SUPERAGENT",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.SUPERAGENT_API_KEY) {
		return {
			success: false,
			error: "Superagent API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	try {
		const response = await fetch("https://app.superagent.sh/api/guard", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.SUPERAGENT_API_KEY}`,
			},
			body: JSON.stringify({
				text: interpolateTemplate(text, params.inputs),
			}),
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Superagent guard failed (HTTP ${response.status})`,
			};
		}

		const data = (await response.json()) as GuardResponse;
		return {
			success: true,
			output: {
				classification: data.classification ?? "unknown",
				violationTypes: data.violation_types ?? [],
				cweCodes: data.cwe_codes ?? [],
				reasoning: data.reasoning ?? "",
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Superagent guard request failed",
		};
	}
}
