import { describe, expect, it } from "vitest";
import { describeFreshness } from "../freshness";

const SYNCED = new Date("2026-07-25T10:00:00Z");

describe("describeFreshness (FR7)", () => {
	it("reports the last successful fetch when nothing failed", () => {
		const v = describeFreshness({
			failedSources: [],
			sourceCount: 2,
			lastFetchedAt: SYNCED,
		});
		expect(v.failure).toBeUndefined();
		expect(v.lastFetchedAt).toEqual(SYNCED);
		expect(v.neverSynced).toBe(false);
	});

	it("says never-synced only when nothing has ever succeeded or failed", () => {
		const v = describeFreshness({ failedSources: [], sourceCount: 1 });
		expect(v.neverSynced).toBe(true);
	});

	it("KEEPS the last-successful timestamp when a source fails", () => {
		// Regression: the panel rendered the failure INSTEAD of the freshness
		// line, so a user looking at stale runs could not tell whether they were
		// twenty minutes or twenty days old — which is the whole of FR7.
		const v = describeFreshness({
			failedSources: [{ lastError: "403 from GitHub" }],
			sourceCount: 4,
			lastFetchedAt: SYNCED,
		});
		expect(v.failure?.error).toBe("403 from GitHub");
		expect(v.lastFetchedAt).toEqual(SYNCED);
	});

	it("distinguishes a partial failure from a total one", () => {
		const partial = describeFreshness({
			failedSources: [{ lastError: "boom" }],
			sourceCount: 4,
			lastFetchedAt: SYNCED,
		});
		expect(partial.failure).toMatchObject({
			tone: "warning",
			total: false,
			failedCount: 1,
			sourceCount: 4,
		});

		const totalFailure = describeFreshness({
			failedSources: [{ lastError: "boom" }, { lastError: "bang" }],
			sourceCount: 2,
			lastFetchedAt: SYNCED,
		});
		expect(totalFailure.failure).toMatchObject({
			tone: "error",
			total: true,
		});
	});

	it("does not claim never-synced while a failure is showing", () => {
		// A failed attempt IS an attempt; "Never synced" beside an error reads
		// as a second, contradictory fact.
		const v = describeFreshness({
			failedSources: [{ lastError: "boom" }],
			sourceCount: 1,
		});
		expect(v.neverSynced).toBe(false);
		expect(v.lastFetchedAt).toBeUndefined();
	});

	it("tolerates a missing error string", () => {
		const v = describeFreshness({
			failedSources: [{ lastError: null }],
			sourceCount: 1,
		});
		expect(v.failure?.error).toBe("");
	});
});

// ----------------------------------------------------------------------------
// reconnectFixes — two independent conditions, both required
//
// The banner turns this into a "Reconnect" call-to-action, so it must be true
// only when reconnecting BOTH fixes the failure kind AND exists for the
// provider. Azure DevOps is PAT-based and has no reconnect flow anywhere, so a
// CTA there links to a settings page that cannot honour it.
// ----------------------------------------------------------------------------

describe("describeFreshness — reconnectFixes", () => {
	const failure = (lastErrorKind: string | null, provider: string | null) =>
		describeFreshness({
			failedSources: [
				{
					lastError: "the provider said no",
					lastErrorKind,
					provider,
					pipelineKey: "example-org/example-repo",
				},
			],
			sourceCount: 1,
		}).failure;

	it("is true for a rejected credential on GitHub", () => {
		expect(
			failure("CREDENTIAL_REJECTED", "github-actions")?.reconnectFixes,
		).toBe(true);
	});

	it("is true for a missing credential on GitLab", () => {
		expect(failure("CREDENTIAL_MISSING", "gitlab-ci")?.reconnectFixes).toBe(
			true,
		);
	});

	it("is FALSE for a rejected credential on Azure DevOps — no reconnect flow exists there", () => {
		expect(
			failure("CREDENTIAL_REJECTED", "azure-devops")?.reconnectFixes,
		).toBe(false);
	});

	it("is false for a missing permission even on GitHub — reconnecting grants nothing", () => {
		expect(
			failure("PERMISSION_MISSING", "github-actions")?.reconnectFixes,
		).toBe(false);
	});

	it("is false for an unknown kind, an unknown provider, or neither", () => {
		expect(
			failure("SOME_STALE_VALUE", "github-actions")?.reconnectFixes,
		).toBe(false);
		expect(
			failure("CREDENTIAL_REJECTED", "some-new-provider")?.reconnectFixes,
		).toBe(false);
		expect(failure(null, null)?.reconnectFixes).toBe(false);
	});
});
