/**
 * The daily sweep's organization filter (org-scoped-flags slice, Task 8 +
 * fix round 1 + fix round 2's uncached global read).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetGlobalFlagOverride = vi.fn();
const mockGetEnabledOrganizationIds = vi.fn();
const mockGetDisabledOrganizationIds = vi.fn();
const mockProjectFindMany = vi.fn();
const mockGetLastCountedPublishingRuns = vi.fn(async () => new Map());

vi.mock("@repo/database", () => ({
	db: {
		project: { findMany: (...a: unknown[]) => mockProjectFindMany(...a) },
		// Every page reads settings for the ids on that page (see
		// find-eligible-projects.ts). Without this, a source change that reads
		// settings before the loop's early-exit conditions turns every test
		// below into a crash (`Cannot read properties of undefined`) instead of
		// a behavioural failure — much harder to diagnose. Resolving `[]`
		// leaves every project on `DEFAULT_PUBLISHING_CADENCE` (mocked below as
		// `7`, never `"MANUAL"`), so it stays in the scheduled set without
		// asserting anything about cadence, which is out of scope here.
		publishingSuiteSettings: { findMany: vi.fn(async () => []) },
	},
	// Fix round 2: the global level is resolved from this UNCACHED row reader
	// plus the real `resolveFlag` (imported unmocked below), not from
	// `isFeatureEnabled` — so this replaces the old `isFeatureEnabled` mock.
	// A `true`/`false` return stands in for an override row's `enabled` value;
	// `resolveFlag` falls through to env/registry when this is `undefined` —
	// exercised by the "falls through to the env var" case below (fix round 2
	// §C), which exists precisely because that fallback is easy to lose (e.g.
	// a `globalOverride === true` shortcut) without any test noticing.
	getGlobalFlagOverride: (...a: unknown[]) => mockGetGlobalFlagOverride(...a),
	getEnabledOrganizationIds: (...a: unknown[]) =>
		mockGetEnabledOrganizationIds(...a),
	getDisabledOrganizationIds: (...a: unknown[]) =>
		mockGetDisabledOrganizationIds(...a),
	DEFAULT_PUBLISHING_CADENCE: 7,
	getLastCountedPublishingRuns: mockGetLastCountedPublishingRuns,
	isPublishingCycleDue: () => false,
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

const { findEligibleProjects } = await import("../find-eligible-projects");

describe("findEligibleProjects organization filter", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockProjectFindMany.mockResolvedValue([]);
		// Default: nothing explicitly disabled. Only the globally-enabled tests
		// below reach this call; giving it a safe default here means a test
		// that forgets to set it explicitly fails on its own assertion, not on
		// an unhandled-mock crash.
		mockGetDisabledOrganizationIds.mockResolvedValue([]);
	});

	// The property that bounds the bill. Asserting an empty RESULT would pass
	// against an implementation that pages the entire project table and filters
	// in memory — same empty list, same cost.
	it("issues no project query when no organization is enabled", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(false);
		mockGetEnabledOrganizationIds.mockResolvedValue([]);

		await expect(findEligibleProjects()).resolves.toEqual({ projects: [] });
		expect(mockProjectFindMany).not.toHaveBeenCalled();
	});

	it("restricts the scan to enabled organizations", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(false);
		mockGetEnabledOrganizationIds.mockResolvedValue(["org_1", "org_2"]);

		await findEligibleProjects();

		expect(mockProjectFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: "ACTIVE",
					deletedAt: null,
					organizationId: { in: ["org_1", "org_2"] },
				}),
			}),
		);
	});

	// Global-on is dev/staging. No organization ALLOW-list at all — but per
	// ADR-018 ("An organization is the only tenant context") a personal
	// project (organizationId null) is EXCLUDED unconditionally, even here in
	// the "nothing disabled" case where the old code applied no organizationId
	// filter at all (and so, pre-ADR-018, swept personal projects by
	// accident). The exclusion must be explicit (`not: null`), not an empty
	// `OR`/`notIn` that happens to do nothing.
	it("excludes personal projects even when the flag is globally enabled and nothing is disabled", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(true);
		mockGetDisabledOrganizationIds.mockResolvedValue([]);

		await findEligibleProjects();

		expect(mockGetEnabledOrganizationIds).not.toHaveBeenCalled();
		const where = mockProjectFindMany.mock.calls[0][0].where;
		expect(where).not.toHaveProperty("OR");
		expect(where.organizationId).toEqual({ not: null });
	});

	// Round 2 (§C): pins the env/registry fallback in `resolveFlag`'s
	// precedence chain (org > global > env > default) for the sweep's global
	// read. A mutation that replaces
	// `resolveFlag(FLAG_KEY, { global: globalOverride }, process.env)` with a
	// bare `globalOverride === true` drops this fallback silently — every
	// case above supplies an explicit `true`/`false` override, so none of
	// them would catch that regression. This one supplies `undefined` (no
	// override row) with the env var set, which only the real fallback path
	// resolves to enabled.
	it("falls through to the env var when there is no global override row", async () => {
		const previousEnv = process.env.FABRIC_FEATURE_PUBLISHING_SUITE;
		process.env.FABRIC_FEATURE_PUBLISHING_SUITE = "true";
		try {
			mockGetGlobalFlagOverride.mockResolvedValue(undefined);
			mockGetDisabledOrganizationIds.mockResolvedValue([]);

			await findEligibleProjects();

			// The globally-enabled branch was taken: the globally-DISABLED
			// path's reader (getEnabledOrganizationIds) must never run, and
			// the globally-ENABLED path's deny-list reader must.
			expect(mockGetEnabledOrganizationIds).not.toHaveBeenCalled();
			expect(mockGetDisabledOrganizationIds).toHaveBeenCalled();
			// ADR-018: even on this fallback path, personal projects stay excluded.
			const where = mockProjectFindMany.mock.calls[0][0].where;
			expect(where.organizationId).toEqual({ not: null });
		} finally {
			if (previousEnv === undefined) {
				delete process.env.FABRIC_FEATURE_PUBLISHING_SUITE;
			} else {
				process.env.FABRIC_FEATURE_PUBLISHING_SUITE = previousEnv;
			}
		}
	});

	// Fix round 1 / F2: the override row is a boolean VALUE, not a bare
	// membership entry, precisely so an organization can opt OUT of a
	// globally-enabled feature — and the daily sweep is the one path where
	// ignoring that opt-out spends money. A globally-enabled sweep must
	// exclude an organization with an explicit `enabled: false` row — AND,
	// per ADR-018, a personal project regardless. No more `OR` with
	// `{ organizationId: null }`: that branch existed to KEEP personal
	// projects in the sweep, which is exactly what ADR-018 forbids.
	it("excludes an organization with an explicit disabled override, and personal projects, when the flag is globally enabled", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(true);
		mockGetDisabledOrganizationIds.mockResolvedValue(["org_bad"]);

		await findEligibleProjects();

		expect(mockProjectFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organizationId: { not: null, notIn: ["org_bad"] },
				}),
			}),
		);
		const where = mockProjectFindMany.mock.calls[0][0].where;
		expect(where).not.toHaveProperty("OR");
	});

	// An organization with NO override row at all is unaffected by the deny
	// list — it inherits the global (enabled) value and stays swept. Proven
	// functionally: its project still reaches the output even while another
	// organization is explicitly disabled in the same sweep.
	it("still sweeps a project whose organization has no override row when the flag is globally enabled", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(true);
		mockGetDisabledOrganizationIds.mockResolvedValue(["org_bad"]);
		mockProjectFindMany.mockResolvedValueOnce([
			{ id: "p-good", organizationId: "org_no_row" },
		]);

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [] });
		// isPublishingCycleDue is stubbed `false` above, so no project is ever
		// "due" — this test only needs the project to have SURVIVED into the
		// scan (i.e. getLastCountedPublishingRuns was consulted for it), not
		// silently dropped by client-side filtering standing in for the DB
		// deny-list.
		expect(mockGetLastCountedPublishingRuns).toHaveBeenCalledWith([
			"p-good",
		]);
	});

	// Nothing above exercises a second page: every other test's mocked query
	// resolves a single (empty, or short) page, so a refactor that hoisted
	// `where` out of the loop or dropped the organization clause once `cursor`
	// is set would go uncaught. Force a second page by returning a FULL first
	// page and assert the filter — and the cursor — on the second call too.
	it("keeps the organization filter on every page, not just the first", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(false);
		mockGetEnabledOrganizationIds.mockResolvedValue(["org_1"]);

		const PAGE_SIZE = 500;
		const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
			id: `p-${i}`,
		}));
		mockProjectFindMany
			.mockResolvedValueOnce(fullPage)
			.mockResolvedValueOnce([]);

		await findEligibleProjects();

		expect(mockProjectFindMany).toHaveBeenCalledTimes(2);
		for (const call of mockProjectFindMany.mock.calls) {
			expect(call[0].where).toEqual(
				expect.objectContaining({ organizationId: { in: ["org_1"] } }),
			);
		}
		// The second call must genuinely be page two — carrying the cursor from
		// the last row of page one — not the same first call inspected twice.
		expect(mockProjectFindMany.mock.calls[1][0]).toEqual(
			expect.objectContaining({ cursor: { id: "p-499" }, skip: 1 }),
		);
	});

	// Fix round 2 (§FIX 2): the global read must be fresh on EVERY sweep, with
	// no TTL wait and no cache-busting call in between — two consecutive
	// `findEligibleProjects()` calls must each see the CURRENT value of
	// `getGlobalFlagOverride`. This is the sweep-level guard against a module
	// (or test-double) accidentally caching that read; the reader's own
	// no-cache contract is pinned directly in
	// `packages/database/__tests__/feature-flags.test.ts`.
	it("sees a changed global value on the very next sweep — no TTL wait", async () => {
		// Sweep 1: globally enabled, nothing disabled — every active project in
		// scope, no organization filter applied.
		mockGetGlobalFlagOverride.mockResolvedValueOnce(true);
		mockGetDisabledOrganizationIds.mockResolvedValueOnce([]);
		mockProjectFindMany.mockResolvedValueOnce([]);
		await findEligibleProjects();
		expect(mockGetGlobalFlagOverride).toHaveBeenCalledTimes(1);
		// ADR-018: personal projects stay excluded even with nothing disabled.
		const where = mockProjectFindMany.mock.calls[0][0].where;
		expect(where.organizationId).toEqual({ not: null });

		// An admin flips the global override to disabled between sweeps — no
		// cache to bust, no wait: sweep 2 must act on the new value on its very
		// next tick.
		mockGetGlobalFlagOverride.mockResolvedValueOnce(false);
		mockGetEnabledOrganizationIds.mockResolvedValueOnce([]);
		await findEligibleProjects();
		expect(mockGetGlobalFlagOverride).toHaveBeenCalledTimes(2);
		// Globally off + nothing enabled: the second sweep must return early —
		// no SECOND project query — rather than scanning the table again.
		expect(mockProjectFindMany).toHaveBeenCalledTimes(1);
	});
});
