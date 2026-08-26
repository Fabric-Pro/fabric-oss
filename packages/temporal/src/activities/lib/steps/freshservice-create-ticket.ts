/**
 * Freshservice Create Ticket Step
 * Creates a new IT service ticket in Freshservice
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

export async function executeFreshserviceCreateTicketStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { subject, description, priority, email } = params.nodeConfig as {
		subject?: string;
		description?: string;
		priority?: string;
		email?: string;
	};

	if (!subject) {
		return { success: false, error: "Subject is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"FRESHSERVICE",
		params.userId,
		params.organizationId,
	);

	if (
		!credentials?.FRESHSERVICE_API_KEY ||
		!credentials?.FRESHSERVICE_DOMAIN
	) {
		return {
			success: false,
			error: "Freshservice API key and domain not configured. Please configure them in Settings > Integrations.",
		};
	}

	const interpolatedSubject = interpolateTemplate(subject, params.inputs);
	const interpolatedDescription = description
		? interpolateTemplate(description, params.inputs)
		: "";
	const interpolatedEmail = email
		? interpolateTemplate(email, params.inputs)
		: undefined;

	const domain = credentials.FRESHSERVICE_DOMAIN.replace(
		/^https?:\/\//,
		"",
	).replace(/\/$/, "");

	try {
		const body: Record<string, unknown> = {
			subject: interpolatedSubject,
			description: interpolatedDescription,
			priority: Number(priority) || 2,
			status: 2, // Open
		};
		if (interpolatedEmail) {
			body.email = interpolatedEmail;
		}

		const apiKey = credentials.FRESHSERVICE_API_KEY;
		const encoded = Buffer.from(`${apiKey}:X`).toString("base64");

		const response = await fetch(`https://${domain}/api/v2/tickets`, {
			method: "POST",
			headers: {
				Authorization: `Basic ${encoded}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		const result = (await response.json()) as {
			ticket?: { id: number };
			errors?: Array<{ message: string }>;
		};

		if (!response.ok) {
			return {
				success: false,
				error:
					result.errors?.[0]?.message ||
					`Freshservice returned status ${response.status}`,
			};
		}

		const ticketId = result.ticket?.id;
		return {
			success: true,
			output: {
				ticketId,
				ticketUrl: `https://${domain}/helpdesk/tickets/${ticketId}`,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Freshservice ticket",
		};
	}
}
