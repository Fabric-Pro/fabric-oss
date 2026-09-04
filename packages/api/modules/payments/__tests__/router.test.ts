/**
 * The payments router's public surface (Fizzy #1875, U4).
 *
 * WHAT IS PINNED HERE
 *
 * There is no path left that collects a card for AI usage. The router key that
 * minted a Stripe setup session is gone, the procedure behind it is deleted,
 * and `@repo/payments` no longer exposes either the setup-link creator or the
 * saved-card lookup that fed the old access decision.
 *
 * The other half matters just as much: subscription plans and the customer
 * portal are a DIFFERENT flow that happens to live in the same module. They
 * were never part of the AI credit and must survive the removal intact —
 * checkout still creates a plan session (trial period included, which belongs
 * to plans), and the portal is still the way to review or remove a card
 * somebody already saved.
 *
 * Nothing is mocked. The real router imports cleanly in this suite, so these
 * assertions read the actual oRPC route metadata rather than a stub's record
 * of it — which is what makes "still resolves" mean the shipped contract.
 */

import { describe, expect, it } from "vitest";
import { paymentsRouter } from "../router";

/** The oRPC route descriptor a built procedure carries. */
function routeOf(procedure: unknown) {
	return (
		procedure as {
			"~orpc": { route: Record<string, unknown> };
		}
	)["~orpc"].route;
}

describe("paymentsRouter — no card-collection surface", () => {
	it("exposes no procedure that creates a card-setup session", () => {
		// The key itself. Named explicitly so a reintroduction under the old
		// name fails here rather than passing the shape check below.
		expect(paymentsRouter).not.toHaveProperty(
			"createPaymentMethodSetupLink",
		);

		// And nothing wearing a different name either: no remaining route path
		// collects a payment method.
		const paths = Object.values(paymentsRouter)
			.filter((entry) => entry && "~orpc" in (entry as object))
			.map((entry) => String(routeOf(entry).path));

		expect(paths).not.toContain(
			"/payments/create-payment-method-setup-link",
		);

		const collectsACard = /payment-method|card|setup/i;
		// Control: the pattern does match the path that was removed, so the
		// loop below is checking something.
		expect("/payments/create-payment-method-setup-link").toMatch(
			collectsACard,
		);

		expect(paths.length).toBeGreaterThan(0);
		for (const path of paths) {
			expect(path).not.toMatch(collectsACard);
		}
	});

	it("leaves no provider method behind the removed surface", async () => {
		// The structural contract in `packages/payments/types.ts` demanded both
		// of these while they were declared; the implementations went with the
		// procedure. `hasPaymentMethod` had exactly one consumer — the
		// saved-card branch of the AI access decision — and that branch is gone.
		const payments = await import("@repo/payments");

		// Control for the two negatives below: a module namespace IS
		// introspectable this way, so their absence is a real finding and not
		// an assertion that can never fail.
		expect(payments).toHaveProperty("createCheckoutLink");
		expect(payments).toHaveProperty("createCustomerPortalLink");

		expect(payments).not.toHaveProperty("createPaymentMethodSetupLink");
		expect(payments).not.toHaveProperty("hasPaymentMethod");
	});
});

describe("paymentsRouter — the subscription flow is untouched", () => {
	it("still resolves the customer-portal path", () => {
		expect(paymentsRouter.createCustomerPortalLink).toBeDefined();

		const route = routeOf(paymentsRouter.createCustomerPortalLink);

		expect(route.method).toBe("POST");
		expect(route.path).toBe("/payments/create-customer-portal-link");
	});

	it("still resolves subscription-plan checkout", () => {
		expect(paymentsRouter.createCheckoutLink).toBeDefined();

		const route = routeOf(paymentsRouter.createCheckoutLink);

		expect(route.method).toBe("POST");
		expect(route.path).toBe("/payments/create-checkout-link");
	});

	it("still accepts a subscription purchase, whose trial belongs to plans", () => {
		// The trial period is read from the plan's price config inside the
		// handler, not from input — so the input contract accepting
		// `subscription` is what pins that this flow was not collateral damage.
		const schema = (
			paymentsRouter.createCheckoutLink as unknown as {
				"~orpc": { inputSchema: { parse: (v: unknown) => unknown } };
			}
		)["~orpc"].inputSchema;

		expect(
			schema.parse({ type: "subscription", productId: "price_123" }),
		).toMatchObject({ type: "subscription", productId: "price_123" });
	});
});
