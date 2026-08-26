/**
 * Stripe Get Customer Step
 *
 * Looks up by customer id when given one, otherwise by email — the email path
 * uses the list endpoint and takes the first match, which is what Stripe's
 * own dashboard search does.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const STRIPE_API_URL = "https://api.stripe.com/v1";

type StripeCustomer = {
	id: string;
	email: string | null;
	name: string | null;
	created: number;
};

type StripeError = { error?: { message?: string } };

export async function executeStripeGetCustomerStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const { customerId, email } = params.nodeConfig as {
		customerId?: string;
		email?: string;
	};

	if (!(customerId || email)) {
		return {
			success: false,
			error: "Either a customer ID or an email is required",
		};
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

	const headers = {
		Authorization: `Bearer ${credentials.STRIPE_SECRET_KEY}`,
	};

	try {
		const url = customerId
			? `${STRIPE_API_URL}/customers/${encodeURIComponent(interpolateTemplate(customerId, params.inputs))}`
			: `${STRIPE_API_URL}/customers?email=${encodeURIComponent(interpolateTemplate(email as string, params.inputs))}&limit=1`;

		const response = await fetch(url, { headers });

		if (!response.ok) {
			const err = (await response
				.json()
				.catch(() => null)) as StripeError | null;
			return {
				success: false,
				error:
					err?.error?.message ??
					`HTTP ${response.status}: Failed to fetch customer`,
			};
		}

		const payload = (await response.json()) as
			| StripeCustomer
			| { data: StripeCustomer[] };

		const customer =
			"data" in payload ? (payload.data[0] ?? null) : payload;

		if (!customer) {
			return { success: false, error: "No matching customer found" };
		}

		return {
			success: true,
			output: {
				id: customer.id,
				email: customer.email,
				name: customer.name,
				created: customer.created,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch Stripe customer",
		};
	}
}
