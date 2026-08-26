/**
 * Tests for `listProviderRegistry` activity — focused on the registry
 * projection (`toSerializable`).
 *
 * Regression coverage for the staging bug where Cloudflare R2 still
 * showed "PayPal Billing Issues" even though the R2 registration set
 * `statusPageComponents: ["R2", "R2 Object Storage"]`. Root cause: the
 * `toSerializable` projection dropped the field on the way from the
 * in-memory registry to the workflow, so `pollStatusPage` was always
 * called with `statusPageComponents=undefined` (i.e., the unfiltered
 * default that surfaces every incident on the page).
 *
 * The fix is one line in `list-provider-registry.ts`. This test locks it
 * in so a future re-organization of the projection cannot silently drop
 * the field again.
 */
import { afterEach, describe, expect, it } from "vitest";

// `@repo/observability`'s index has a side-effect import for
// `integration-providers.ts`, so importing the activity is enough to
// populate the live registry (Cloudflare R2 included).
import {
	getProviderRegistration,
	listProviderRegistry,
} from "../list-provider-registry";

describe("listProviderRegistry — statusPageComponents projection", () => {
	afterEach(() => {
		// Activities are pure functions over the module-scoped registry —
		// nothing to clean up between cases.
	});

	it("forwards statusPageComponents on the Cloudflare R2 row so the workflow can filter incidents", async () => {
		const all = await listProviderRegistry({ filter: "polling" });
		const r2 = all.find((row) => row.key === "r2");
		expect(r2).toBeDefined();
		// The literal aliases registered in
		// `packages/observability/lib/integration-providers.ts`. Both must
		// appear in the serialized projection.
		expect(r2?.statusPageComponents).toEqual(["R2", "R2 Object Storage"]);
	});

	it("getProviderRegistration also forwards statusPageComponents (single-row lookup path)", async () => {
		const r2 = await getProviderRegistration({ providerKey: "r2" });
		expect(r2?.statusPageComponents).toEqual(["R2", "R2 Object Storage"]);
	});

	it("returns undefined statusPageComponents for providers without a component filter", async () => {
		const all = await listProviderRegistry({ filter: "polling" });
		const stripe = all.find((row) => row.key === "stripe");
		expect(stripe).toBeDefined();
		// Stripe's statuspage has only one component surface; no filter
		// is registered, so the field should be undefined (not an empty
		// array — the parser treats `[]` the same as `undefined` but
		// keeping the contract precise avoids subtle bugs in the parser).
		expect(stripe?.statusPageComponents).toBeUndefined();
	});

	it("returns a defensive copy — mutating the returned array does not affect the registry", async () => {
		// Same pattern as the registry's own `cloneRegistration` guard.
		// Ensures a buggy workflow body that calls `.push()` on the
		// filter array doesn't leak state across iterations.
		const first = await listProviderRegistry({ filter: "polling" });
		const r2First = first.find((row) => row.key === "r2");
		r2First?.statusPageComponents?.push("Synthetic — Should Not Persist");

		const second = await listProviderRegistry({ filter: "polling" });
		const r2Second = second.find((row) => row.key === "r2");
		expect(r2Second?.statusPageComponents).toEqual([
			"R2",
			"R2 Object Storage",
		]);
	});
});
