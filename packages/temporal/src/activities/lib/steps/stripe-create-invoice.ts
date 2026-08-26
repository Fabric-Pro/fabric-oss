/**
 * Stripe Create Invoice Step
 *
 * Three calls, in Stripe's required order: create the draft invoice, attach
 * each line item to it, then finalize if asked. Line items must be created
 * against an existing invoice id, which is why this cannot be a single call.
 */

import { fetchCredentialsByProvider } from "@repo/database";
import type { NodeExecutionResult, StepParams } from "../../types";
import { interpolateTemplate } from "./utils";

const STRIPE_API_URL = "https://api.stripe.com/v1";

type StripeInvoice = {
	id: string;
	number: string | null;
	hosted_invoice_url: string | null;
	status: string;
};

type StripeError = { error?: { message?: string } };

type LineItem = {
	description?: string;
	amount?: number;
	quantity?: number;
	currency?: string;
};

async function stripeError(response: Response, fallback: string) {
	const err = (await response.json().catch(() => null)) as StripeError | null;
	return err?.error?.message ?? `HTTP ${response.status}: ${fallback}`;
}

export async function executeStripeCreateInvoiceStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const {
		customerId,
		description,
		lineItems,
		daysUntilDue,
		autoAdvance,
		collectionMethod,
	} = params.nodeConfig as {
		customerId?: string;
		description?: string;
		lineItems?: string;
		daysUntilDue?: string | number;
		autoAdvance?: string;
		collectionMethod?: string;
	};

	if (!customerId) {
		return { success: false, error: "Customer ID is required" };
	}
	if (!lineItems) {
		return { success: false, error: "Line items are required" };
	}

	let items: LineItem[];
	try {
		items = JSON.parse(
			interpolateTemplate(lineItems, params.inputs),
		) as LineItem[];
	} catch {
		return { success: false, error: "Line items must be a JSON array" };
	}
	if (!(Array.isArray(items) && items.length > 0)) {
		return { success: false, error: "At least one line item is required" };
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
		"Content-Type": "application/x-www-form-urlencoded",
	};
	const customer = interpolateTemplate(customerId, params.inputs);

	try {
		// 1. Draft invoice.
		const draftBody = new URLSearchParams({
			customer,
			collection_method: collectionMethod || "send_invoice",
			// Attach line items before finalizing, so never auto-advance here.
			auto_advance: "false",
		});
		if (description) {
			draftBody.append(
				"description",
				interpolateTemplate(description, params.inputs),
			);
		}
		if (draftBody.get("collection_method") === "send_invoice") {
			draftBody.append("days_until_due", String(daysUntilDue ?? 30));
		}

		const draftResponse = await fetch(`${STRIPE_API_URL}/invoices`, {
			method: "POST",
			headers,
			body: draftBody.toString(),
		});
		if (!draftResponse.ok) {
			return {
				success: false,
				error: await stripeError(
					draftResponse,
					"Failed to create invoice",
				),
			};
		}
		let invoice = (await draftResponse.json()) as StripeInvoice;

		// 2. Line items, attached to the draft.
		for (const item of items) {
			const itemBody = new URLSearchParams({
				customer,
				invoice: invoice.id,
				currency: item.currency ?? "usd",
				// Stripe takes the smallest currency unit (cents).
				unit_amount: String(item.amount ?? 0),
				quantity: String(item.quantity ?? 1),
			});
			if (item.description) {
				itemBody.append("description", item.description);
			}

			const itemResponse = await fetch(`${STRIPE_API_URL}/invoiceitems`, {
				method: "POST",
				headers,
				body: itemBody.toString(),
			});
			if (!itemResponse.ok) {
				return {
					success: false,
					error: await stripeError(
						itemResponse,
						"Failed to add invoice line item",
					),
				};
			}
		}

		// 3. Finalize, unless the caller wants it left as a draft.
		if (autoAdvance !== "false") {
			const finalizeResponse = await fetch(
				`${STRIPE_API_URL}/invoices/${invoice.id}/finalize`,
				{ method: "POST", headers },
			);
			if (!finalizeResponse.ok) {
				return {
					success: false,
					error: await stripeError(
						finalizeResponse,
						"Failed to finalize invoice",
					),
				};
			}
			invoice = (await finalizeResponse.json()) as StripeInvoice;
		}

		return {
			success: true,
			output: {
				id: invoice.id,
				number: invoice.number,
				hostedInvoiceUrl: invoice.hosted_invoice_url,
				status: invoice.status,
			},
		};
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to create Stripe invoice",
		};
	}
}
