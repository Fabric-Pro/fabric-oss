import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeZendeskCreateTicketStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { subject, description, requesterEmail, priority } =
		params.nodeConfig as {
			subject?: string;
			description?: string;
			requesterEmail?: string;
			priority?: string;
		};

	if (!subject || !description) {
		return {
			success: false,
			error: "Subject and description are required",
		};
	}

	const credentials = await fetchCredentialsByProvider(
		"ZENDESK",
		params.userId,
		params.organizationId,
	);

	if (
		!credentials?.ZENDESK_SUBDOMAIN ||
		!credentials?.ZENDESK_EMAIL ||
		!credentials?.ZENDESK_TOKEN
	) {
		return {
			success: false,
			error: "Zendesk subdomain, email, and token are required in Settings > Integrations.",
		};
	}

	const auth = Buffer.from(
		`${credentials.ZENDESK_EMAIL}/token:${credentials.ZENDESK_TOKEN}`,
	).toString("base64");

	try {
		const body: Record<string, unknown> = {
			ticket: {
				subject: interpolateTemplate(subject, params.inputs),
				comment: {
					body: interpolateTemplate(description, params.inputs),
				},
				priority: priority || "normal",
			},
		};
		if (requesterEmail) {
			(body.ticket as Record<string, unknown>).requester = {
				email: interpolateTemplate(requesterEmail, params.inputs),
			};
		}

		const response = await fetch(
			`https://${credentials.ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets.json`,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${auth}`,
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify(body),
			},
		);

		const result = await response.json();
		if (!response.ok) {
			return {
				success: false,
				error:
					result?.error ||
					result?.description ||
					`Zendesk returned status ${response.status}`,
			};
		}

		return {
			success: true,
			output: {
				ticketId: result.ticket?.id,
				ticketUrl: result.ticket?.url,
				subject: result.ticket?.subject,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Zendesk ticket",
		};
	}
}
