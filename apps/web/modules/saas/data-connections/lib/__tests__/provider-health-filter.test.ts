/**
 * Tests for the Settings -> Integrations status-filter helpers.
 *
 *
 * Coverage
 * --------
 * - `all` keeps every provider.
 * - `operational`, `degraded`, `outage`, `unknown` narrow the grid
 *   correctly given a populated lookup.
 * - `outage` matches both `MAJOR_OUTAGE` and `PARTIAL_OUTAGE`.
 * - `MAINTENANCE` is filtered out by every named filter (it is only
 *   visible under `all`).
 * - Missing rows fall back to `UNKNOWN` so the grid never empties to
 *   zero when the registry seed has not yet hydrated.
 */

import { describe, expect, it } from "vitest";
import {
	type HealthLookupRow,
	matchesStatusFilter,
	resolveProviderHealth,
} from "../provider-health-filter";

const buildLookup = (
	entries: Array<{
		providerKey: string;
		dataConnectionProvider: string | null;
		currentHealth: HealthLookupRow["currentHealth"];
	}>,
): Record<string, HealthLookupRow> => {
	const lookup: Record<string, HealthLookupRow> = {};
	for (const entry of entries) {
		lookup[entry.providerKey] = entry;
	}
	return lookup;
};

const SAMPLE_LOOKUP = buildLookup([
	{
		providerKey: "GOOGLE_DRIVE",
		dataConnectionProvider: "GOOGLE_DRIVE",
		currentHealth: "OPERATIONAL",
	},
	{
		providerKey: "NOTION",
		dataConnectionProvider: "NOTION",
		currentHealth: "DEGRADED",
	},
	{
		providerKey: "JIRA",
		dataConnectionProvider: "JIRA",
		currentHealth: "MAJOR_OUTAGE",
	},
	{
		providerKey: "CONFLUENCE",
		dataConnectionProvider: "CONFLUENCE",
		currentHealth: "PARTIAL_OUTAGE",
	},
	{
		providerKey: "SLACK",
		dataConnectionProvider: "SLACK",
		currentHealth: "MAINTENANCE",
	},
]);

describe("matchesStatusFilter", () => {
	it("returns true for every provider when the filter is `all`", () => {
		expect(matchesStatusFilter("GOOGLE_DRIVE", "all", SAMPLE_LOOKUP)).toBe(
			true,
		);
		expect(matchesStatusFilter("JIRA", "all", SAMPLE_LOOKUP)).toBe(true);
		expect(matchesStatusFilter("UNREGISTERED" as never, "all", {})).toBe(
			true,
		);
	});

	it("`operational` only matches OPERATIONAL providers", () => {
		expect(
			matchesStatusFilter("GOOGLE_DRIVE", "operational", SAMPLE_LOOKUP),
		).toBe(true);
		expect(
			matchesStatusFilter("NOTION", "operational", SAMPLE_LOOKUP),
		).toBe(false);
		expect(matchesStatusFilter("JIRA", "operational", SAMPLE_LOOKUP)).toBe(
			false,
		);
	});

	it("`degraded` only matches DEGRADED providers", () => {
		expect(matchesStatusFilter("NOTION", "degraded", SAMPLE_LOOKUP)).toBe(
			true,
		);
		expect(
			matchesStatusFilter("GOOGLE_DRIVE", "degraded", SAMPLE_LOOKUP),
		).toBe(false);
	});

	it("`outage` matches BOTH MAJOR_OUTAGE and PARTIAL_OUTAGE", () => {
		expect(matchesStatusFilter("JIRA", "outage", SAMPLE_LOOKUP)).toBe(true);
		expect(matchesStatusFilter("CONFLUENCE", "outage", SAMPLE_LOOKUP)).toBe(
			true,
		);
		expect(
			matchesStatusFilter("GOOGLE_DRIVE", "outage", SAMPLE_LOOKUP),
		).toBe(false);
		expect(matchesStatusFilter("SLACK", "outage", SAMPLE_LOOKUP)).toBe(
			false,
		);
	});

	it("`unknown` matches providers absent from the lookup", () => {
		expect(matchesStatusFilter("DROPBOX", "unknown", SAMPLE_LOOKUP)).toBe(
			true,
		);
		expect(
			matchesStatusFilter("GOOGLE_DRIVE", "unknown", SAMPLE_LOOKUP),
		).toBe(false);
	});

	it("never matches MAINTENANCE under any named filter (only `all`)", () => {
		expect(matchesStatusFilter("SLACK", "operational", SAMPLE_LOOKUP)).toBe(
			false,
		);
		expect(matchesStatusFilter("SLACK", "degraded", SAMPLE_LOOKUP)).toBe(
			false,
		);
		expect(matchesStatusFilter("SLACK", "outage", SAMPLE_LOOKUP)).toBe(
			false,
		);
		expect(matchesStatusFilter("SLACK", "unknown", SAMPLE_LOOKUP)).toBe(
			false,
		);
		expect(matchesStatusFilter("SLACK", "all", SAMPLE_LOOKUP)).toBe(true);
	});
});

describe("resolveProviderHealth", () => {
	it("returns the health stored under the matching dataConnectionProvider", () => {
		expect(resolveProviderHealth("GOOGLE_DRIVE", SAMPLE_LOOKUP)).toBe(
			"OPERATIONAL",
		);
		expect(resolveProviderHealth("JIRA", SAMPLE_LOOKUP)).toBe(
			"MAJOR_OUTAGE",
		);
	});

	it("falls back to UNKNOWN when the provider has no row", () => {
		expect(resolveProviderHealth("DROPBOX", {})).toBe("UNKNOWN");
		expect(resolveProviderHealth("DROPBOX", SAMPLE_LOOKUP)).toBe("UNKNOWN");
	});

	it("falls back to the lowercase registry key form", () => {
		const lookup = buildLookup([
			{
				providerKey: "github",
				dataConnectionProvider: null,
				currentHealth: "MAJOR_OUTAGE",
			},
		]);
		expect(resolveProviderHealth("GITHUB", lookup)).toBe("MAJOR_OUTAGE");
	});
});
