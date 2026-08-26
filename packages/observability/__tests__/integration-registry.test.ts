/**
 * Integration Provider Registry — unit tests
 *
 * Uses the REAL registry (no mocks).
 *
 * The registry is module-scoped and populated as a side effect of
 * importing `integration-providers.ts`. Tests that mutate the registry
 * (Suite 1) sit AFTER the read-only coverage assertions (Suite 2) so a
 * `__resetRegistryForTests()` does not invalidate the live snapshot.
 *
 * Where mutation IS needed (Suite 3), we manually restore the live set
 * inside `afterEach` so subsequent suites are unaffected.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";

// Side-effect import — invokes `registerIntegrationProvider(...)` 32
// times at module-load time. Must run BEFORE we snapshot `live`.
import "../lib/integration-providers";

import {
	__resetRegistryForTests,
	getProvidersForPolling,
	getProvidersForSyntheticProbe,
	getRegistration,
	type IntegrationProviderRegistration,
	listRegistrations,
	registerIntegrationProvider,
} from "../lib/integration-registry";

// Inline copy of the `DataConnectionProvider` enum values from
// `packages/database/prisma/schema.prisma` (line ~7625). We mirror the
// enum verbatim so `@repo/observability` does NOT depend on
// `@repo/database` — even as a devDependency would re-introduce the
// `@repo/observability → @repo/database → @repo/storage → @repo/observability`
// Turbo cycle (Turbo's package-graph validator counts dev deps).
//
// **Contract**: keep this array in lock-step with the Prisma enum. The
// test `every DataConnectionProvider enum value has exactly one
// registration` will fail loudly if anything drifts, which is exactly
// the early-warning signal we want.
const DATA_CONNECTION_PROVIDER_VALUES = [
	"GOOGLE_DRIVE",
	"S3",
	"GOOGLE_STORAGE",
	"R2",
	"DROPBOX",
	"AIRTABLE",
	"CODA",
	"GITBOOK",
	"NOTION",
	"CONFLUENCE",
	"TEAMS",
	"INTERCOM",
	"GITHUB",
	"GITLAB",
	"BITBUCKET",
	"LINEAR",
	"ASANA",
	"CLICKUP",
	"SLACK",
	"SNOWFLAKE",
	"BIGQUERY",
	"ZENDESK",
	"GONG",
	"GMAIL",
	"JIRA",
	"MICROSOFT_365",
	"SALESFORCE",
	"HUBSPOT",
] as const;

/**
 * Snapshot the live registry at file-load time so we can restore it
 * after any test that mutates the module-scoped Map.
 */
const LIVE_SNAPSHOT = listRegistrations();

/** Restore the live registry from the cached snapshot. */
function restoreLiveRegistry(): void {
	__resetRegistryForTests();
	for (const reg of LIVE_SNAPSHOT) {
		registerIntegrationProvider(reg);
	}
}

afterAll(() => {
	// Defensive — keep the live registry intact for any tests that
	// run AFTER this file in the same vitest pool.
	restoreLiveRegistry();
});

/**
 * Suite 1 — live registry coverage. Reads the actual MVP-5 + 27
 * registrations loaded by importing `integration-providers.ts` at the
 * top of this file. Does NOT mutate the registry.
 */
describe("integration-providers (live registry)", () => {
	const MVP5: readonly { key: string; breakerKey: string }[] = [
		{ key: "openai", breakerKey: "openai_completions" },
		{ key: "anthropic", breakerKey: "anthropic_messages" },
		{ key: "stripe", breakerKey: "stripe_payments" },
		{ key: "resend", breakerKey: "resend_email" },
		{ key: "aws_s3", breakerKey: "aws_s3_put" },
	];

	it("has exactly 33 registrations (5 MVP + 28 DataConnectionProvider)", () => {
		// Note: the legacy "27" enum value count grew to 28 with the
		// MICROSOFT_365 addition. We assert against the schema as the
		// source of truth.
		expect(LIVE_SNAPSHOT.length).toBe(33);
	});

	it("has no duplicate keys", () => {
		const keys = LIVE_SNAPSHOT.map((r) => r.key);
		const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
		expect(dupes).toEqual([]);
	});

	it.each(MVP5)(
		"MVP-5 provider %s has syntheticProbe + breakerKey configured",
		({ key, breakerKey }) => {
			const reg = LIVE_SNAPSHOT.find((r) => r.key === key);
			expect(reg, `provider ${key} not registered`).toBeDefined();
			expect(
				reg?.syntheticProbe,
				`${key} missing syntheticProbe`,
			).toBeDefined();
			expect(reg?.syntheticProbe?.interval).toBe("5m");
			expect(reg?.breakerKey).toBe(breakerKey);
		},
	);

	it("MVP-5 providers do NOT have a dataConnectionProvider mapping", () => {
		for (const { key } of MVP5) {
			const reg = LIVE_SNAPSHOT.find((r) => r.key === key);
			expect(reg?.dataConnectionProvider).toBeUndefined();
		}
	});

	it("aws_s3 has statusPagePolling: false (no public summary.json)", () => {
		const aws = LIVE_SNAPSHOT.find((r) => r.key === "aws_s3");
		expect(aws).toBeDefined();
		expect(aws?.statusPagePolling).toBe(false);
		expect(aws?.statusPageApiUrl).toBeUndefined();
		expect(aws?.statusPageUrl).toBe(
			"https://health.aws.amazon.com/health/status",
		);
	});

	it("getProvidersForSyntheticProbe returns exactly the MVP-5 set", () => {
		const probed = getProvidersForSyntheticProbe();
		expect(probed.map((r) => r.key).sort()).toEqual(
			MVP5.map((m) => m.key).sort(),
		);
	});

	it("getProvidersForPolling includes the MVP-4 (sans aws_s3) and the polling-enabled DataConnectionProviders", () => {
		const polling = getProvidersForPolling();
		const pollingKeys = new Set(polling.map((p) => p.key));

		// MVP-5 minus aws_s3 (no public summary.json) — should all be
		// pollable.
		expect(pollingKeys.has("openai")).toBe(true);
		expect(pollingKeys.has("anthropic")).toBe(true);
		expect(pollingKeys.has("stripe")).toBe(true);
		expect(pollingKeys.has("resend")).toBe(true);
		expect(pollingKeys.has("aws_s3")).toBe(false);

		// Some popular DataConnectionProviders that we expect to be
		// pollable.
		expect(pollingKeys.has("github")).toBe(true);
		expect(pollingKeys.has("notion")).toBe(true);
		expect(pollingKeys.has("slack")).toBe(true);
		// Gmail is now polled via the `google-workspace` custom parser
		// against the Google Workspace incident-list JSON (same feed as
		// Google Drive, narrowed by `service_name`).
		expect(pollingKeys.has("gmail")).toBe(true);
		// Salesforce is polled via the `salesforce` custom parser against
		// the Salesforce Trust v1 active-incidents endpoint.
		expect(pollingKeys.has("salesforce")).toBe(true);

		// Providers without a public statuspage (auth-gated feeds).
		expect(pollingKeys.has("microsoft_365")).toBe(false);
		expect(pollingKeys.has("teams")).toBe(false);
	});

	it("every DataConnectionProvider enum value has exactly one registration", () => {
		const enumValues = DATA_CONNECTION_PROVIDER_VALUES;
		// Sanity check: the schema currently has 28 enum values.
		// Source of truth is `packages/database/prisma/schema.prisma`;
		// inlined here to avoid the Turbo dep cycle.
		expect(enumValues.length).toBe(28);

		for (const enumValue of enumValues) {
			const matches = LIVE_SNAPSHOT.filter(
				(r) => r.dataConnectionProvider === enumValue,
			);
			expect(
				matches.length,
				`Expected exactly 1 registration for DataConnectionProvider="${enumValue}", got ${matches.length}`,
			).toBe(1);
		}
	});

	it("every dataConnectionProvider value references a real enum value", () => {
		const enumValues = new Set<string>(DATA_CONNECTION_PROVIDER_VALUES);
		const provHits = LIVE_SNAPSHOT.filter(
			(
				r,
			): r is IntegrationProviderRegistration & {
				dataConnectionProvider: string;
			} => typeof r.dataConnectionProvider === "string",
		);

		for (const reg of provHits) {
			expect(
				enumValues.has(reg.dataConnectionProvider),
				`provider ${reg.key} has dataConnectionProvider="${reg.dataConnectionProvider}" which is not a DataConnectionProvider enum value`,
			).toBe(true);
		}
	});

	it("Genuinely unknowable providers are marked statusPagePolling: false with a tooltip-ready reason", () => {
		// Providers whose status feed is auth-gated or non-existent.
		// Gmail, Gong, and Salesforce moved to the polled set after we
		// landed custom parsers for Google Workspace, incident.io-served
		// Atlassian JSON, and the Salesforce Trust v1 API.
		// Microsoft 365 / Teams remain auth-gated. `s3` is a generic
		// placeholder with no single backing feed.
		const optedOut = ["microsoft_365", "teams", "s3"];

		for (const key of optedOut) {
			const reg = LIVE_SNAPSHOT.find((r) => r.key === key);
			expect(reg, `expected registration for ${key}`).toBeDefined();
			expect(reg?.statusPagePolling).toBe(false);
			// Tooltip-ready reason surfaced via `listProviderRegistry` to
			// the admin monitoring UI (see TODO in
			// `integration-registry.ts` re: wiring through the DB row).
			expect(
				reg?.statusUnsupportedReason,
				`provider ${key} should have a statusUnsupportedReason`,
			).toBeTruthy();
		}
	});

	it("Providers with a customParser dispatch to the matching non-Atlassian decoder", () => {
		// The pollStatusPage activity dispatches on `customParser` before
		// falling through to the Atlassian default. Asserting the wiring
		// here catches accidental drift between the registry and the
		// activity's discriminator union.
		const expectations: Array<{
			key: string;
			parser:
				| "google-workspace"
				| "google-cloud"
				| "slack"
				| "status-io"
				| "zendesk-ssp"
				| "salesforce";
		}> = [
			{ key: "google_drive", parser: "google-workspace" },
			{ key: "gmail", parser: "google-workspace" },
			{ key: "google_storage", parser: "google-cloud" },
			{ key: "bigquery", parser: "google-cloud" },
			{ key: "slack", parser: "slack" },
			{ key: "gitlab", parser: "status-io" },
			{ key: "clickup", parser: "status-io" },
			{ key: "zendesk", parser: "zendesk-ssp" },
			{ key: "salesforce", parser: "salesforce" },
		];
		for (const { key, parser } of expectations) {
			const reg = LIVE_SNAPSHOT.find((r) => r.key === key);
			expect(reg, `expected registration for ${key}`).toBeDefined();
			expect(reg?.customParser).toBe(parser);
		}
	});

	it("MVP-5 providers map to FeatureLabel values via affectedFeatures", () => {
		// Drives inhibition wiring — when a provider is OUT,
		// the corresponding feature's error-rate alerts are suppressed.
		const requireFeatures: Record<string, string[]> = {
			openai: ["ai_generation"],
			anthropic: ["ai_generation"],
			stripe: ["payments"],
			resend: ["transactional_email"],
			aws_s3: ["file_storage", "document_processing"],
		};

		for (const [key, expectedFeatures] of Object.entries(requireFeatures)) {
			const reg = LIVE_SNAPSHOT.find((r) => r.key === key);
			expect(reg, `provider ${key} not registered`).toBeDefined();
			expect(reg?.affectedFeatures).toEqual(expectedFeatures);
		}
	});
});

/**
 * Suite 2 — pure registry mechanics with isolated test fixtures.
 * Uses `__resetRegistryForTests()` per test and restores the live set
 * once the suite finishes.
 */
describe("registerIntegrationProvider — registry mechanics", () => {
	beforeEach(() => {
		__resetRegistryForTests();
	});

	// Restore the live registry after this suite so the file ordering
	// inside vitest's worker doesn't accidentally affect downstream
	// suites in the same process.
	afterAll(() => {
		restoreLiveRegistry();
	});

	it("stores and returns a single registration", () => {
		registerIntegrationProvider({
			key: "test_a",
			displayName: "Test A",
			affectedFeatures: [],
		});

		const entry = getRegistration("test_a");
		expect(entry).toBeDefined();
		expect(entry?.key).toBe("test_a");
		expect(entry?.displayName).toBe("Test A");
	});

	it("returns undefined for unknown keys", () => {
		expect(getRegistration("does_not_exist")).toBeUndefined();
	});

	it("throws on a duplicate key", () => {
		registerIntegrationProvider({
			key: "dup",
			displayName: "First",
			affectedFeatures: [],
		});

		expect(() =>
			registerIntegrationProvider({
				key: "dup",
				displayName: "Second",
				affectedFeatures: [],
			}),
		).toThrow(/duplicate integration provider key/i);
	});

	it("listRegistrations returns a defensive copy (caller mutation is harmless)", () => {
		registerIntegrationProvider({
			key: "snapshot_a",
			displayName: "Snapshot A",
			affectedFeatures: ["pm_sync"],
		});

		const list = listRegistrations();
		expect(list).toHaveLength(1);

		// Mutate the returned array AND the inner object.
		list.push({
			key: "ghost",
			displayName: "Ghost",
			affectedFeatures: [],
		});
		list[0].displayName = "Mutated";
		list[0].affectedFeatures.push("payments");

		// The internal registry is unchanged.
		const fresh = listRegistrations();
		expect(fresh).toHaveLength(1);
		expect(fresh[0].displayName).toBe("Snapshot A");
		expect(fresh[0].affectedFeatures).toEqual(["pm_sync"]);
		expect(getRegistration("ghost")).toBeUndefined();
	});

	it("getRegistration returns a defensive copy", () => {
		registerIntegrationProvider({
			key: "copy_test",
			displayName: "Original",
			affectedFeatures: ["pm_sync"],
		});

		const ref = getRegistration("copy_test");
		expect(ref).toBeDefined();
		if (!ref) {
			return;
		}

		ref.displayName = "Tampered";
		ref.affectedFeatures.push("payments");

		const fresh = getRegistration("copy_test");
		expect(fresh?.displayName).toBe("Original");
		expect(fresh?.affectedFeatures).toEqual(["pm_sync"]);
	});

	it("getProvidersForPolling excludes statusPagePolling: false", () => {
		registerIntegrationProvider({
			key: "polled",
			displayName: "Polled",
			statusPageApiUrl: "https://example.com/api/v2/summary.json",
			statusPagePolling: true,
			affectedFeatures: [],
		});
		registerIntegrationProvider({
			key: "opted_out",
			displayName: "Opted Out",
			statusPageApiUrl: "https://example.com/other/summary.json",
			statusPagePolling: false,
			affectedFeatures: [],
		});

		const polling = getProvidersForPolling();
		const keys = polling.map((p) => p.key);
		expect(keys).toContain("polled");
		expect(keys).not.toContain("opted_out");
	});

	it("getProvidersForPolling excludes entries missing statusPageApiUrl", () => {
		registerIntegrationProvider({
			key: "no_api_url",
			displayName: "No API URL",
			statusPageUrl: "https://example.com",
			// statusPageApiUrl deliberately omitted.
			statusPagePolling: true,
			affectedFeatures: [],
		});

		const polling = getProvidersForPolling();
		expect(polling.map((p) => p.key)).not.toContain("no_api_url");
	});

	it("getProvidersForSyntheticProbe returns only entries with syntheticProbe set", () => {
		registerIntegrationProvider({
			key: "probed",
			displayName: "Probed",
			affectedFeatures: [],
			syntheticProbe: {
				interval: "5m",
				url: "https://example.com/health",
				method: "GET",
				expectedStatus: [200],
			},
		});
		registerIntegrationProvider({
			key: "not_probed",
			displayName: "Not Probed",
			affectedFeatures: [],
		});

		const probed = getProvidersForSyntheticProbe();
		expect(probed.map((p) => p.key)).toEqual(["probed"]);
	});

	it("returns empty arrays when nothing is registered", () => {
		expect(getProvidersForPolling()).toEqual([]);
		expect(getProvidersForSyntheticProbe()).toEqual([]);
		expect(listRegistrations()).toEqual([]);
	});

	it("statusPagePolling defaulting to undefined treats provider as pollable when API URL is present", () => {
		// : `statusPagePolling` is optional and defaults to
		// true. Only an explicit `false` should opt-out.
		registerIntegrationProvider({
			key: "default_pollable",
			displayName: "Default Pollable",
			statusPageApiUrl: "https://example.com/api/v2/summary.json",
			affectedFeatures: [],
		});

		const polling = getProvidersForPolling();
		expect(polling.map((p) => p.key)).toContain("default_pollable");
	});
});
