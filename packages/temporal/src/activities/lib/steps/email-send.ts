/**
 * Email Send Step (Resend)
 * Sends emails using the Resend API
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeEmailSendStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { to, subject, body } = params.nodeConfig as {
		to?: string;
		subject?: string;
		body?: string;
	};

	if (!to || !subject || !body) {
		return { success: false, error: "To, subject, and body are required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"RESEND",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.RESEND_API_KEY) {
		return {
			success: false,
			error: "Resend API key not configured. Please configure it in Settings > Integrations.",
		};
	}

	if (!credentials?.RESEND_FROM_EMAIL) {
		return {
			success: false,
			error: "From email not configured. Please configure it in Settings > Integrations.",
		};
	}

	const interpolatedTo = interpolateTemplate(to, params.inputs);
	const interpolatedSubject = interpolateTemplate(subject, params.inputs);
	const interpolatedBody = interpolateTemplate(body, params.inputs);

	try {
		const response = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${credentials.RESEND_API_KEY}`,
			},
			body: JSON.stringify({
				from: credentials.RESEND_FROM_EMAIL,
				to: interpolatedTo,
				subject: interpolatedSubject,
				text: interpolatedBody,
			}),
		});

		const result = await response.json();

		if (!response.ok) {
			return {
				success: false,
				error: result.message || "Failed to send email",
			};
		}

		// `id` is the declared output field the UI offers for autocomplete;
		// `emailId` predates it and is kept so existing workflows keep
		// resolving.
		return { success: true, output: { id: result.id, emailId: result.id } };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "Failed to send email",
		};
	}
}
