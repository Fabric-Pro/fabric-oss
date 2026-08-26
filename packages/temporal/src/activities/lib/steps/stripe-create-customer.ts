/**
 * Stripe Create Customer Step
 *
 * Ported from vercel-labs/workflow-builder-template. Stripe's API is
 * form-encoded, not JSON — including nested metadata as `metadata[key]`.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const STRIPE_API_URL = "https://api.stripe.com/v1";

type StripeCustomer = {
	id: string;
	email: string;
	name: string | null;
	phone: string | null;
	created: number;
};

type StripeError = { error?: { message?: string } };

export async function executeStripeCreateCustomerStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { email, name, phone, description, metadata } = params.nodeConfig as {
		email?: string;
		name?: string;
		phone?: string;
		description?: string;
		metadata?: string;
	};

	if (!email) {
		return { success: false, error: "Email is required" };
	}

	const credentials = await fetchCredentialsByProvider(
		"STRIPE",
		params.userId,
		params.organizationId,
	);

	if (!credentials?.STRIPE_SECRET_KEY) {
		return {
			success: false,
			error: "Stripe secret key not configured. Please configure it in Settings > Integrations.",
		};
	}

	const body = new URLSearchParams();
	body.append("email", interpolateTemplate(email, params.inputs));

	for (const [key, value] of [
		["name", name],
		["phone", phone],
		["description", description],
	] as const) {
		if (value) {
			body.append(key, interpolateTemplate(value, params.inputs));
		}
	}

	if (metadata) {
		try {
			const parsed = JSON.parse(
				interpolateTemplate(metadata, params.inputs),
			) as Record<string, unknown>;
			for (const [key, value] of Object.entries(parsed)) {
				body.append(`metadata[${key}]`, String(value));
			}
		} catch {
			return { success: false, error: "Invalid metadata JSON format" };
		}
	}

	try {
		const response = await fetch(`${STRIPE_API_URL}/customers`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${credentials.STRIPE_SECRET_KEY}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: body.toString(),
		});

		if (!response.ok) {
			const err = (await response
				.json()
				.catch(() => null)) as StripeError | null;
			return {
				success: false,
				error:
					err?.error?.message ??
					`HTTP ${response.status}: Failed to create customer`,
			};
		}

		const customer = (await response.json()) as StripeCustomer;
		return {
			success: true,
			output: { id: customer.id, email: customer.email },
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Stripe customer",
		};
	}
}
