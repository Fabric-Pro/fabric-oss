/**
 * Unit tests for the AI access decision
 * (`packages/payments/src/lib/ai-credits.ts`) and the resolver split it now
 * depends on (`packages/database/prisma/queries/ai-gateway.ts`).
 *
 * Mounted under `@repo/api/lib/__tests__/payments/` — mirroring the sibling
 * `ai-usage-limits.test.ts` — so they run under the api package's vitest
 * runner without forcing `@repo/payments` to declare its own vitest
 * devDependency.
 *
 * WHAT IS PINNED HERE (Fizzy #1875)
 *
 * A user-facing AI operation runs on a provider the tenant configured — its
 * organization's, or the caller's own personal key used inside it — or it does
 * not run. Neither a credit balance, nor a saved payment method, nor the
 * platform's own gateway key takes part in that decision.
 *
 * Every test below runs on a deployment that DOES set a platform gateway key
 * (`@repo/config` is mocked with the gateway enabled). That is deliberate:
 * before this change the tenant resolver ended in that key, which is a real
 * working credential carrying a null `source`, so a keyless tenant was served
 * silently while every "is this configured?" check read `source` and saw
 * nothing. `getSystemAiProviderApiKey` proves the key is genuinely present, so
 * a refusal here is never the artefact of an unconfigured deployment.
 *
 * Mocks sit at boundaries only:
 * - the Prisma client (deep path, so the REAL `ai-gateway` resolver runs)
 * - `@repo/config` / `@repo/utils` (gateway toggle + key encryption)
 * - `@repo/database`'s barrel, whose provider reads delegate to that real
 *   resolver while the entity reads are stubs
 *
 * The Stripe provider is deliberately NOT mocked: the access helper no longer
 * imports it. There is no saved-payment-method lookup left to stub.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAiBillingCategory } from "../../../../ai/lib/usage-logging";

/** The deployment's own gateway credential — set for every test in this file. */
const PLATFORM_GATEWAY_KEY = "platform-gateway-key";

const { orgFindFirst, userFindFirst } = vi.hoisted(() => ({
	orgFindFirst: vi.fn(),
	userFindFirst: vi.fn(),
}));

// The real `ai-gateway` module reads `db` from this file; mocking it here (and
// not `@repo/database` wholesale) is what lets the resolver under test be the
// production one.
vi.mock("../../../../database/prisma/client", () => ({
	db: {
		cloudProviderConfig: { findFirst: orgFindFirst },
		userCloudProviderConfig: { findFirst: userFindFirst },
	},
}));

vi.mock("@repo/config", () => ({
	config: {
		ai: {
			enableGateway: true,
			gatewayApiKey: PLATFORM_GATEWAY_KEY,
			enabledProviders: ["openai", "anthropic"],
		},
	},
}));

vi.mock("@repo/utils", () => ({
	encryptApiKey: (key: string) => `encrypted:${key}`,
}));

// `@repo/payments` reaches the database through its barrel. Provider reads
// delegate to the real resolver; the entity reads behind
// `getCustomerIdFromEntity` are stubs.
//
// There is deliberately no credit-ledger stub here: `getTenantAiCreditStatus`
// no longer exists, and `getTenantAiCreditAccess` no longer reads a balance.
// Were one reintroduced, this mock would not provide it and the access helper
// would fail loudly rather than pass on a stub.
vi.mock("@repo/database", async () => {
	const gateway = await import(
		"../../../../database/prisma/queries/ai-gateway"
	);
	return {
		getAiProviderApiKey: gateway.getAiProviderApiKey,
		getSystemAiProviderApiKey: gateway.getSystemAiProviderApiKey,
		getOrganizationById: vi.fn().mockResolvedValue(null),
		getUserById: vi.fn().mockResolvedValue(null),
		updateOrganization: vi.fn(),
		updateUser: vi.fn(),
	};
});

async function loadGateway() {
	return await import("../../../../database/prisma/queries/ai-gateway");
}

async function loadCredits() {
	return await import("../../../../payments/src/lib/ai-credits");
}

const USER_ID = "user-1";
const ORG_ID = "org-1";

/** An organization-level provider row carrying a usable API key. */
const orgProviderRow = {
	id: "cpc_1",
	provider: "OPENAI_DIRECT",
	encryptedApiKey: "encrypted:org-key",
	clientId: null,
	encryptedClientSecret: null,
	config: {},
};

/** A personal provider row carrying a usable API key. */
const personalProviderRow = {
	id: "ucpc_1",
	provider: "ANTHROPIC_DIRECT",
	encryptedApiKey: "encrypted:personal-key",
	clientId: null,
	encryptedClientSecret: null,
	config: {},
};

beforeEach(() => {
	vi.clearAllMocks();
	orgFindFirst.mockResolvedValue(null);
	userFindFirst.mockResolvedValue(null);
});

// ===========================================================================
// The platform gateway key is out of a tenant's reach
// ===========================================================================

describe("getAiProviderApiKey (tenant-facing resolver)", () => {
	it("refuses a tenant with no provider even though the deployment sets a gateway key", async () => {
		// AE1. THE test of this change: before it, the resolver ended in the
		// platform credential and this tenant was served silently.
		const { getAiProviderApiKey, hasProviderCredentials } =
			await loadGateway();

		const resolved = await getAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.apiKey).toBeNull();
		expect(resolved.provider).toBeNull();
		expect(resolved.source).toBeNull();
		// The guard every user-facing caller runs immediately before raising
		// `AIProviderNotConfiguredError`. A false here IS the refusal, and it is
		// a provider-shaped one: nothing in this path can produce a payment error.
		expect(hasProviderCredentials(resolved)).toBe(false);
	});

	it("proves the refusal above is not an artefact of an unset gateway key", async () => {
		const { getSystemAiProviderApiKey, hasProviderCredentials } =
			await loadGateway();

		const resolved = await getSystemAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.provider).toBe("VERCEL_GATEWAY");
		expect(resolved.apiKey).toBe(`encrypted:${PLATFORM_GATEWAY_KEY}`);
		expect(hasProviderCredentials(resolved)).toBe(true);
	});

	it("returns the organization's own provider when it has one", async () => {
		orgFindFirst.mockResolvedValue(orgProviderRow);
		const { getAiProviderApiKey } = await loadGateway();

		const resolved = await getAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.source).toBe("organization");
		expect(resolved.provider).toBe("OPENAI_DIRECT");
	});

	it("honours a member's personal key inside an organization that has none", async () => {
		userFindFirst.mockResolvedValue(personalProviderRow);
		const { getAiProviderApiKey } = await loadGateway();

		const resolved = await getAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.source).toBe("user");
		expect(resolved.provider).toBe("ANTHROPIC_DIRECT");
	});
});

describe("getSystemAiProviderApiKey (background/system resolver)", () => {
	it("still falls back to the platform gateway key for a tenant with nothing configured", async () => {
		// R13. Indexing, embedding and tool ingestion keep their current key
		// resolution — the fallback removal reached the user-facing path only.
		const { getSystemAiProviderApiKey } = await loadGateway();

		const resolved = await getSystemAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.apiKey).toBe(`encrypted:${PLATFORM_GATEWAY_KEY}`);
		expect(resolved.provider).toBe("VERCEL_GATEWAY");
		// The platform branch stamps no source — this is the asymmetry that made
		// the old shared fallback invisible to every "is it configured?" check.
		expect(resolved.source).toBeNull();
	});

	it("prefers the tenant's own provider over the platform key", async () => {
		orgFindFirst.mockResolvedValue(orgProviderRow);
		const { getSystemAiProviderApiKey } = await loadGateway();

		const resolved = await getSystemAiProviderApiKey({
			userId: USER_ID,
			organizationId: ORG_ID,
		});

		expect(resolved.source).toBe("organization");
		expect(resolved.provider).toBe("OPENAI_DIRECT");
	});
});

// ===========================================================================
// The access decision itself
// ===========================================================================

// ===========================================================================
// Billing mode
// ===========================================================================

describe("getTenantAiGatewayBillingState", () => {
	it("categorises a tenant-configured provider as external", async () => {
		const { getTenantAiGatewayBillingState } = await loadCredits();

		expect(
			getTenantAiGatewayBillingState({
				provider: "OPENAI_DIRECT",
				configSource: "organization",
			}),
		).toEqual({ mode: "external_provider", headers: null });
	});

	it("categorises a platform-served call as unbilled and attaches no Stripe headers", async () => {
		// Reachable only from the background/system resolver now.
		const { getTenantAiGatewayBillingState } = await loadCredits();

		expect(
			getTenantAiGatewayBillingState({
				provider: "VERCEL_GATEWAY",
				configSource: null,
			}),
		).toEqual({ mode: "platform_unbilled", headers: null });
	});
});

// ===========================================================================
// Billing mode → the category written on the usage row
// ===========================================================================

/**
 * The half of the pipeline that lives in `@repo/ai`. Composed with the helper
 * above it is the whole journey from "which key served this call" to the
 * `AiUsageBillingCategory` the usage row carries — the two are only correct
 * together, and only one of them is in this package.
 *
 * `usage-logging.ts` has no runtime imports (its two imports are type-only),
 * so pulling it into this file costs nothing and drags in no model machinery.
 */
type BillingMetadata = Parameters<typeof getAiBillingCategory>[0];

function metadataForMode(mode: BillingMetadata["billingMode"]) {
	return {
		modelString: "gpt-4o",
		provider: "OPENAI_DIRECT",
		configId: "cpc_1",
		configSource: "organization",
		selectionSource: "system_default",
		canonicalName: "gpt-4o",
		billingMode: mode,
		billingCustomerId: null,
	} satisfies BillingMetadata;
}

describe("getAiBillingCategory (the category the usage row is written with)", () => {
	it("records a tenant-configured provider as external BYOK", async () => {
		const { getTenantAiGatewayBillingState } = await loadCredits();

		const { mode } = getTenantAiGatewayBillingState({
			provider: "OPENAI_DIRECT",
			configSource: "organization",
		});

		expect(getAiBillingCategory(metadataForMode(mode))).toBe(
			"EXTERNAL_BYOK",
		);
	});

	it("records a platform-served background call as platform-funded", async () => {
		// R13. Background and ingestion work keeps the system resolver, so this
		// category stays reachable — and stays distinguishable in reporting
		// from spend a tenant funded itself.
		const { getTenantAiGatewayBillingState } = await loadCredits();

		const { mode, headers } = getTenantAiGatewayBillingState({
			provider: "VERCEL_GATEWAY",
			configSource: null,
		});

		expect(getAiBillingCategory(metadataForMode(mode))).toBe(
			"PLATFORM_UNBILLED",
		);
		expect(headers).toBeNull();
	});

	it("still maps the two retired modes, which only historical rows carry", async () => {
		// R7 / KTD3. Nothing produces these any more — no branch of
		// `getTenantAiGatewayBillingState` returns them — but the mapping stays
		// total so a usage row can never arrive unclassifiable, including from
		// an out-of-process agent holding a token minted before this change.
		expect(getAiBillingCategory(metadataForMode("included_credit"))).toBe(
			"INCLUDED_CREDIT",
		);
		expect(getAiBillingCategory(metadataForMode("metered_stripe"))).toBe(
			"STRIPE_METERED",
		);

		const { getTenantAiGatewayBillingState } = await loadCredits();
		const producible = [
			getTenantAiGatewayBillingState({
				provider: "OPENAI_DIRECT",
				configSource: "organization",
			}).mode,
			getTenantAiGatewayBillingState({
				provider: "ANTHROPIC_DIRECT",
				configSource: "user",
			}).mode,
			getTenantAiGatewayBillingState({
				provider: "VERCEL_GATEWAY",
				configSource: "organization",
			}).mode,
			getTenantAiGatewayBillingState({
				provider: "VERCEL_GATEWAY",
				configSource: null,
			}).mode,
		];

		expect(producible).not.toContain("included_credit");
		expect(producible).not.toContain("metered_stripe");
	});
});
