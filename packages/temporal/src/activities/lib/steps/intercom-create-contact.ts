import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeIntercomCreateContactStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { email, name, phone } = params.nodeConfig as Record<
		string,
		string | undefined
	>;

	if (!email) {
		return { success: false, error: "Email is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"INTERCOM",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.INTERCOM_ACCESS_TOKEN) {
		return {
			success: false,
			error: "Intercom access token is required in Settings > Integrations.",
		};
	}

	try {
		const response = await fetch("https://api.intercom.io/contacts", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.INTERCOM_ACCESS_TOKEN}`,
				"Content-Type": "application/json",
				Accept: "application/json",
				"Intercom-Version": "2.11",
			},
			body: JSON.stringify({
				role: "user",
				email: interpolateTemplate(email, params.inputs),
				name: name
					? interpolateTemplate(name, params.inputs)
					: undefined,
				phone: phone
					? interpolateTemplate(phone, params.inputs)
					: undefined,
			}),
		});

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.errors?.[0]?.message ||
					`Intercom returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				contactId: result.id,
				contact: result,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Intercom contact",
		};
	}
}
