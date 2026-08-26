/** Superagent: remove personal data from text. */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

type RedactResponse = {
	redacted_text?: string;
	reasoning?: string;
};

export async function executeSuperagentRedactStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { text, entities } = params.nodeConfig as {
		text?: string;
		entities?: string;
	};

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

	const entityList = (entities ?? "")
		.split(",")
		.map((e) => e.trim())
		.filter(Boolean);

	try {
		const response = await fetch("https://app.superagent.sh/api/redact", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.SUPERAGENT_API_KEY}`,
			},
			body: JSON.stringify({
				text: interpolateTemplate(text, params.inputs),
				...(entityList.length > 0 ? { entities: entityList } : {}),
			}),
		});

		if (!response.ok) {
			return {
				success: false,
				error: `Superagent redact failed (HTTP ${response.status})`,
			};
		}

		const data = (await response.json()) as RedactResponse;
		return {
			success: true,
			output: {
				redactedText: data.redacted_text ?? "",
				reasoning: data.reasoning ?? "",
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Superagent redact request failed",
		};
	}
}
