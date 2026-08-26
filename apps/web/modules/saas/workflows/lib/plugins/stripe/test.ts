import type { TestConnectionResult } from "../types";

/**
 * Validate a Stripe secret key.
 *
 * `GET /v1/balance` is the cheapest authenticated read: it touches no
 * customer data and needs no scope beyond the key being live.
 */
export async function testStripeConnection(
	credentials: Record<string, string>,
): Promise<TestConnectionResult> {
	const apiKey = credentials.STRIPE_SECRET_KEY ?? credentials.apiKey;

	if (!apiKey) {
		return { success: false, error: "Secret key is required" };
	}

	try {
		const response = await fetch("https://api.stripe.com/v1/balance", {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { message?: string };
			} | null;
			return {
				success: false,
				error:
					body?.error?.message ??
					`Stripe rejected the key (HTTP ${response.status})`,
			};
		}

		return { success: true, message: "Connected to Stripe" };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Could not reach Stripe",
		};
	}
}
