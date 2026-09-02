/**
 * Tests for the Publishing Suite daily dispatcher activities (Task 10).
 *
 * Two activities under test:
 *   - `findEligibleProjects` — flag-gated sweep (server context owns the flag).
 *   - `dispatchPublishingSuggestion` — the idempotent, liveness-aware per-project
 *     dispatch: H4 fresh-read + XOR-normalize, cost guard, tri-state reclaim of a
 *     stale GENERATING cycle, createOrGet, deterministic workflow start.
 *
 * The crux is `livenessOf`'s tri-state (M11): a DEFINITE `WorkflowNotFoundError`
 * (execution provably absent) is distinguished from an ambiguous describe throw
 * (transient outage) so a real outage can never steal a live cycle. Mirrors the
 * mock harness of `dispatch-newsletter-send.test.ts` (mock db + mock Temporal
 * client + instanceof-able error classes).
 *
 * The reclaim check runs BEFORE the cost guard (`hasNew`) in the activity —
 * see the "reclaim before cost guard" describe block below, which proves a
 * QUIET project (no new content) still reclaims a stale GENERATING cycle
 * left by a dead worker, while a quiet project with NO existing cycle makes
 * no extra Temporal `describe` call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockCreateOrGet,
	mockCountNew,
	mockStart,
	mockGetHandle,
	mockDescribe,
	mockGetClient,
	mockGetGlobalFlagOverride,
	mockGetEnabledOrgIds,
	mockGetDisabledOrgIds,
	mockGetOrgFlagOverride,
	mockDb,
	mockGetLastCountedPublishingRuns,
	mockLastRunHash,
	mockGetSettings,
	mockHeartbeat,
	mockEnsureJob,
	mockFailJob,
} = vi.hoisted(() => ({
	mockCreateOrGet: vi.fn(),
	mockCountNew: vi.fn(),
	mockStart: vi.fn(),
	mockGetHandle: vi.fn(),
	mockDescribe: vi.fn(),
	mockGetClient: vi.fn(),
	// Sweep-level AND dispatch-level global read (fix round 2 §FIX 2, §E) —
	// the ONE uncached reader both `findEligibleProjects` and the dispatcher's
	// F3 org re-check consume, through the real (unmocked) `resolveFlag` —
	// never through the cached `isFeatureEnabled`, which neither call site
	// uses any more. See the `@repo/database` mock below.
	mockGetGlobalFlagOverride: vi.fn(),
	// The org-scoped lists `findEligibleProjects` consults to build its
	// sweep-wide filter. `findEligibleProjects` is a REAL (unmocked) function
	// from `../find-eligible-projects` — only the `@repo/database` readers it
	// calls internally are mocked, via the barrel mock below.
	mockGetEnabledOrgIds: vi.fn(),
	mockGetDisabledOrgIds: vi.fn(),
	// The single-row org-override read `isPublishingSuiteEnabledForOrganizationUncached`
	// consults for one project's org (Copilot-review follow-up: reshaped from
	// the two list readers above to a single `findUnique`-shaped read).
	// `isPublishingSuiteEnabledForOrganizationUncached` is likewise a REAL
	// (unmocked) function from `../find-eligible-projects`.
	mockGetOrgFlagOverride: vi.fn(),
	mockDb: {
		// findFirst is the F3 eligibility-scoped fresh read; findUnique is retained
		// so the pre-fix source (RED demonstration) still resolves a project row and
		// fails on behavior, not on a crash.
		project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
		publishingSuggestionCycle: { findFirst: vi.fn(), updateMany: vi.fn() },
		publishingSuiteSettings: { findMany: vi.fn() },
	},
	mockGetLastCountedPublishingRuns: vi.fn(),
	mockLastRunHash: vi.fn(),
	mockGetSettings: vi.fn(),
	// A no-op by default, matching the real heartbeat()'s behavior INSIDE a
	// Temporal Worker's activity-execution context. One test below (the
	// "callable outside a Temporal Worker" case) overrides this to throw —
	// heartbeat()'s real failure mode OUTSIDE that context — and restores the
	// no-op afterward so no other test in this file is affected.
	mockHeartbeat: vi.fn(),
	// Job Hub row writer. Spied at the `@repo/database` boundary rather than by
	// replacing the dispatch's own helper, so the arguments asserted below are
	// the ones the writer actually receives.
	mockEnsureJob: vi.fn(),
	mockFailJob: vi.fn(),
}));

vi.mock("@temporalio/activity", () => ({ heartbeat: mockHeartbeat }));

// Real instanceof-able error classes so the activity's
// `err instanceof WorkflowExecutionAlreadyStartedError` / `WorkflowNotFoundError`
// branches work. Defined inside the (hoisted) factory, re-imported below.
vi.mock("@temporalio/client", () => ({
	WorkflowExecutionAlreadyStartedError: class extends Error {},
	WorkflowNotFoundError: class extends Error {},
}));

// Partially mocked: db-touching exports below are replaced, but
// isPublishingCycleDue (Task 2) is a PURE cadence-math function with no db
// access — importActual keeps it (and every other pure export) real so the
// findEligibleProjects cadence cases below exercise actual interval math
// instead of a stub. Mirrors the same idiom used by
// activities/document-refresh/__tests__/find-due-documents.test.ts.
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: mockDb,
		createOrGetPublishingCycle: (...a: unknown[]) => mockCreateOrGet(...a),
		countNewContextSince: (...a: unknown[]) => mockCountNew(...a),
		getLastCountedPublishingRuns: mockGetLastCountedPublishingRuns,
		getLastCountedPublishingRunPreferencesHash: (...a: unknown[]) =>
			mockLastRunHash(...a),
		// getPublishingSuiteSettings (Task 3) reads `db` via its OWN direct import
		// of `../../client`, not through this package barrel — mocking `db` above
		// does not reach it. Mock the function itself, mirroring
		// createOrGetPublishingCycle/countNewContextSince above.
		getPublishingSuiteSettings: (...a: unknown[]) => mockGetSettings(...a),
		ensureRunningBackgroundJob: (...a: unknown[]) => mockEnsureJob(...a),
		failBackgroundJob: (...a: unknown[]) => mockFailJob(...a),
		// The org-scoped-flags slice's Task 8: findEligibleProjects reads both
		// through the package barrel now, replacing the old
		// `@repo/utils/feature-flag` gate mocked here previously. Both touch
		// `db.organizationFeatureFlagOverride` / `db.featureFlagOverride`
		// internally via the package's OWN relative `../client` import (like
		// getPublishingSuiteSettings above), so mocking `db` above does not
		// reach them either — mock the functions themselves.
		//
		// Fix round 2 (§FIX 2, §E): neither the sweep's global read nor the
		// dispatcher's per-project F3 re-check goes through `isFeatureEnabled`
		// any more — both resolve through `getGlobalFlagOverride` (UNCACHED)
		// plus the real, unmocked `resolveFlag` (`@repo/utils/feature-flag-registry`,
		// imported outside this barrel so `importActual` above never touches
		// it). `isFeatureEnabled` is intentionally left UNMOCKED here: nothing
		// under test calls it any more, and a stray call would now fail loudly
		// (a real DB client with no override) instead of silently succeeding
		// against a leftover mock.
		getGlobalFlagOverride: (...a: unknown[]) =>
			mockGetGlobalFlagOverride(...a),
		getEnabledOrganizationIds: (...a: unknown[]) =>
			mockGetEnabledOrgIds(...a),
		getDisabledOrganizationIds: (...a: unknown[]) =>
			mockGetDisabledOrgIds(...a),
		getOrganizationFlagOverrideUncached: (...a: unknown[]) =>
			mockGetOrgFlagOverride(...a),
	};
});

// Relative to src/activities/publishing-suggestion/ → resolves to src/client.
vi.mock("../../../client", () => ({ getTemporalClient: mockGetClient }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	buildPublishingPreferencesSnapshot,
	computePublishingPreferencesHash,
} from "@repo/database";
import {
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import {
	dispatchPublishingSuggestion,
	livenessOf,
	PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS,
	runPublishingSuggestionDispatch,
} from "../dispatch-suggestion";
import { findEligibleProjects } from "../find-eligible-projects";

const NOW = new Date("2026-07-14T06:00:00.000Z");
const MIN = 60 * 1000;

/** A GENERATING cycle whose startedAt is `agoMs` before NOW. Defaults to the
 *  SAME tenant tuple as the default fresh project (org-1, XOR-normalized
 *  userId null) so the tri-state reclaim tests exercise the same-tenant path;
 *  the F2 cross-tenant supersede is tested with an explicit mismatched
 *  tuple. ADR-018: the default fresh project is org-scoped, not personal —
 *  see the `setFresh` default in `beforeEach` above. */
function generating(
	agoMs: number,
	overrides: Partial<{
		id: string;
		executionTimeoutAt: Date | null;
		organizationId: string | null;
		userId: string | null;
	}> = {},
) {
	return {
		id: overrides.id ?? "cycle-old",
		startedAt: new Date(NOW.getTime() - agoMs),
		executionTimeoutAt:
			overrides.executionTimeoutAt === undefined
				? new Date(NOW.getTime() + 2 * 60 * MIN)
				: overrides.executionTimeoutAt,
		organizationId:
			overrides.organizationId === undefined
				? "org-1"
				: overrides.organizationId,
		userId: overrides.userId === undefined ? null : overrides.userId,
	};
}

/** Wire the H4 fresh read. F3 made it `db.project.findFirst` (eligibility-scoped);
 *  findUnique is set too so the pre-fix source still reads a row (clean RED). */
function setFresh(
	row: { id: string; userId: string; organizationId: string | null } | null,
) {
	mockDb.project.findFirst.mockResolvedValue(row);
	mockDb.project.findUnique.mockResolvedValue(row);
}

/** Wire findFirst so the priorCoverage (status IN) and existing-GENERATING
 *  (status GENERATING) reads resolve independently. */
function wireFindFirst(opts: {
	prior?: { sourceCoverage: unknown } | null;
	existing?: {
		id: string;
		startedAt: Date;
		executionTimeoutAt: Date | null;
		organizationId?: string | null;
		userId?: string | null;
	} | null;
}) {
	mockDb.publishingSuggestionCycle.findFirst.mockImplementation(
		(args: { where: { status: unknown } }) => {
			const status = args.where.status as
				| string
				| { in?: string[] }
				| undefined;
			if (status && typeof status === "object" && "in" in status) {
				return Promise.resolve(opts.prior ?? null);
			}
			if (status === "GENERATING") {
				return Promise.resolve(opts.existing ?? null);
			}
			return Promise.resolve(null);
		},
	);
}

/**
 * The fingerprint of the settings the dispatch under test will actually read,
 * built from the REAL helpers rather than a hardcoded digest. A hardcoded one
 * would still pass if dispatch built its snapshot from the wrong fields.
 */
const currentHash = (lookbackDays: number | null = null) =>
	computePublishingPreferencesHash(
		buildPublishingPreferencesSnapshot({ lookbackDays }),
	);

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	// vi.clearAllMocks() clears calls/results but NOT a custom
	// mockImplementation — reset explicitly so the throwing implementation
	// installed by the "callable outside a Temporal Worker" test below can
	// never leak into another test even if that test's own restore is skipped.
	mockHeartbeat.mockImplementation(() => undefined);
	// Same hazard, same fix, different mock: the "job writer that never
	// settles" case below installs a NEVER-RESOLVING implementation, and
	// vi.clearAllMocks() does not remove it. It was harmless only while that
	// case was the last full dispatch in the file; any case added after it
	// inherits a bounded write that can only complete by advancing fake
	// timers, and times out instead.
	mockEnsureJob.mockImplementation(() => undefined);
	// Globally enabled by default (today's dev/staging path — with nothing
	// explicitly disabled here, no organization filter is applied). The
	// OFF+org-scoped path is exercised by its own test below. The
	// globally-enabled-but-disabled-organization path is NOT exercised in
	// this file — it is owned by the sibling
	// find-eligible-projects.org-filter.test.ts, which asserts the exact
	// where-clause shape for all three branches; duplicating it here with
	// this file's heavier end-to-end mocks would be redundant and could
	// drift out of sync with that authoritative version.
	mockGetGlobalFlagOverride.mockResolvedValue(true);
	mockGetEnabledOrgIds.mockResolvedValue([]);
	mockGetDisabledOrgIds.mockResolvedValue([]);
	// No org override row by default — the F3 re-check falls through to the
	// global value above, matching the "nothing overridden" default the list
	// readers express for the sweep.
	mockGetOrgFlagOverride.mockResolvedValue(undefined);
	mockCountNew.mockResolvedValue({ hasNew: true });
	mockStart.mockResolvedValue({
		workflowId: "publishing-suggestion-cycle-1",
	});
	mockGetHandle.mockReturnValue({ describe: mockDescribe });
	mockGetClient.mockResolvedValue({
		workflow: { start: mockStart, getHandle: mockGetHandle },
	});
	// ADR-018 ("An organization is the only tenant context"): the default
	// fixture is an organization-owned project, not personal. A personal
	// project is refused outright by the F3 re-check (see
	// isPublishingSuiteEnabledForOrganizationUncached), so it can no longer
	// stand in as this file's generic "happy path" tenant for exercising
	// reclaim/cost-guard/job-hub/preferences mechanics unrelated to tenant
	// routing itself — those get their own dedicated tests below (H4 fresh
	// read / F2 tenant-tuple scoping).
	setFresh({ id: "proj-1", userId: "user-1", organizationId: "org-1" });
	mockDb.publishingSuggestionCycle.updateMany.mockResolvedValue({ count: 1 });
	wireFindFirst({ prior: null, existing: null });
	// No settings rows, no prior runs. `DEFAULT_PUBLISHING_CADENCE` is MANUAL
	// (1C-1 follow-up), so a project with no settings row is now EXCLUDED from
	// the sweep, not "due" — the findEligibleProjects cases below that want a
	// project to actually be scheduled wire an explicit non-MANUAL settings row
	// rather than relying on this default.
	mockDb.publishingSuiteSettings.findMany.mockResolvedValue([]);
	mockGetLastCountedPublishingRuns.mockResolvedValue(new Map());
	// 1C-1: no configured lookback by default — matches
	// `publishingSuiteSettingsDefaults` (lookbackDays: null) so the payload the
	// happy-path tests assert stays byte-identical to pre-1C.
	mockGetSettings.mockResolvedValue({ lookbackDays: null });
	// 1C-1b: by default the last counted run used exactly these preferences,
	// so the fingerprint comparison is a no-op and every pre-existing case
	// keeps the cost-guard behaviour it was written against. A case that wants
	// a mismatch opts in by overriding this.
	mockLastRunHash.mockResolvedValue(currentHash());
	mockCreateOrGet.mockResolvedValue({
		cycle: {
			id: "cycle-1",
			status: "GENERATING",
			temporalWorkflowId: null,
			// F4: createOrGet now returns the stored collection boundary; the
			// created path returns `now` (== NOW here).
			coveredThrough: NOW,
			executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
		},
		created: true,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// findEligibleProjects — flag gate
// ---------------------------------------------------------------------------
describe("findEligibleProjects", () => {
	it("returns no projects and never queries the db when the flag is OFF everywhere", async () => {
		mockGetGlobalFlagOverride.mockResolvedValue(false);
		mockGetEnabledOrgIds.mockResolvedValue([]);
		const out = await findEligibleProjects();
		expect(out).toEqual({ projects: [] });
		expect(mockDb.project.findMany).not.toHaveBeenCalled();
	});

	it("returns minimal { projectId } identifiers (no tenant fields) when the flag is ON", async () => {
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-a" },
			{ id: "p-b" },
		]);
		// Both scheduled (non-MANUAL) so they reach the output — the default
		// cadence for a project with NO settings row is MANUAL (1C-1 follow-up),
		// which this test is not about; see the dedicated no-settings-row case.
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([
			{ projectId: "p-a", cadence: "WEEKLY" },
			{ projectId: "p-b", cadence: "WEEKLY" },
		]);
		const out = await findEligibleProjects();
		expect(out).toEqual({
			projects: [{ projectId: "p-a" }, { projectId: "p-b" }],
		});
		// Only id is selected — dispatch re-derives tenant/owner from a fresh read.
		expect(mockDb.project.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ select: { id: true } }),
		);
	});

	it("skips a project whose cadence is MANUAL", async () => {
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-manual", organizationId: null, userId: "u-1" },
		]);
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([
			{ projectId: "p-manual", cadence: "MANUAL" },
		]);

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [] });
		// MANUAL is decided without a cycle read at all.
		expect(mockGetLastCountedPublishingRuns).not.toHaveBeenCalled();
	});

	it("excludes a project with no settings row from the sweep — the default cadence is MANUAL", async () => {
		// This is the behavioural heart of the 1C-1 default-flip follow-up: a
		// project that has never had its Publishing Suite settings touched must
		// stay out of the daily sweep entirely, not merely "not yet due". Prove
		// that by making it look maximally overdue (never run) — under the OLD
		// "WEEKLY" literal fallback this project would come back due
		// immediately, so this assertion (and the one below) would both fail if
		// that literal were ever reintroduced in place of
		// `DEFAULT_PUBLISHING_CADENCE`.
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-unconfigured", organizationId: null, userId: "u-1" },
		]);
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([]);
		mockGetLastCountedPublishingRuns.mockResolvedValue(new Map());

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [] });
		// MANUAL — including MANUAL reached via the no-row fallback — is decided
		// before the batched cycle read, so it must never be issued for this
		// project either.
		expect(mockGetLastCountedPublishingRuns).not.toHaveBeenCalled();
	});

	it("includes a project whose weekly interval has elapsed", async () => {
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-due", organizationId: null, userId: "u-1" },
		]);
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([
			{ projectId: "p-due", cadence: "WEEKLY" },
		]);
		mockGetLastCountedPublishingRuns.mockResolvedValue(
			new Map([
				["p-due", new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000)],
			]),
		);

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [{ projectId: "p-due" }] });
	});

	it("treats a project absent from the last-run map as never run, so it is due", async () => {
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-never", organizationId: null, userId: "u-1" },
		]);
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([
			{ projectId: "p-never", cadence: "WEEKLY" },
		]);
		// A project whose only cycles were FAILED, or whose cycles predate a
		// transfer, comes back absent — and must not be deferred.
		mockGetLastCountedPublishingRuns.mockResolvedValue(new Map());

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [{ projectId: "p-never" }] });
	});

	it("asks for the last run of every project on the page in ONE call", async () => {
		mockDb.project.findMany.mockResolvedValue([
			{ id: "p-a", organizationId: null, userId: "u-1" },
			{ id: "p-b", organizationId: "org-1", userId: "u-2" },
		]);
		mockDb.publishingSuiteSettings.findMany.mockResolvedValue([
			{ projectId: "p-a", cadence: "WEEKLY" },
			{ projectId: "p-b", cadence: "MONTHLY" },
		]);
		mockGetLastCountedPublishingRuns.mockResolvedValue(new Map());

		await findEligibleProjects();

		expect(mockGetLastCountedPublishingRuns).toHaveBeenCalledTimes(1);
		expect(mockGetLastCountedPublishingRuns).toHaveBeenCalledWith([
			"p-a",
			"p-b",
		]);
	});

	it("bounds the number of pages SCANNED even when nothing is ever due — the sweep must not page through the whole table on a quiet day", async () => {
		// Mirrors the implementation's own PAGE_SIZE (500) / MAX_PROJECTS (20_000)
		// constants: 20_000 / 500 = 40 full pages is the scan bound. The fake data
		// source below has MORE pages available than that (45) so a fix that only
		// bounds on `projects.length` (which never grows here — every project is
		// MANUAL, so nothing is ever due) would keep paging past 40 and this
		// assertion would fail with 45 calls instead of 40.
		const PAGE_SIZE = 500;
		const MAX_PROJECTS = 20_000;
		const PAGES_AVAILABLE = 45;

		let callCount = 0;
		mockDb.project.findMany.mockImplementation(() => {
			callCount += 1;
			if (callCount > PAGES_AVAILABLE) {
				return Promise.resolve([]);
			}
			const rows = Array.from({ length: PAGE_SIZE }, (_, i) => ({
				id: `p-${callCount}-${i}`,
			}));
			return Promise.resolve(rows);
		});
		// Every project on every page is MANUAL — never due, no cycle read — so
		// `projects` stays empty for the whole sweep and can never trip a
		// projects.length-only bound.
		mockDb.publishingSuiteSettings.findMany.mockImplementation(
			(args: { where: { projectId: { in: string[] } } }) =>
				Promise.resolve(
					args.where.projectId.in.map((id) => ({
						projectId: id,
						cadence: "MANUAL",
					})),
				),
		);

		const out = await findEligibleProjects();

		expect(out).toEqual({ projects: [] });
		// The scan bound (not the empty output) is what stops the loop: exactly
		// MAX_PROJECTS / PAGE_SIZE pages, not the 45 the fake source could serve.
		expect(mockDb.project.findMany).toHaveBeenCalledTimes(
			MAX_PROJECTS / PAGE_SIZE,
		);
		expect(mockGetLastCountedPublishingRuns).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// dispatchPublishingSuggestion — happy path + idempotency
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — happy path", () => {
	it("creates a cycle and starts the workflow with the deterministic id", async () => {
		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-1",
				userId: null, // org context → tenantUserId XOR-normalized to null
				actorUserId: "user-1",
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			}),
		);
		expect(mockStart).toHaveBeenCalledWith(
			"publishingSuggestionWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "publishing-suggestion-cycle-1",
				// Fizzy #2213: one representation. The dispatcher passes the exported
				// constant (milliseconds — @temporalio/common's Duration is
				// `StringValue | number`), so 1C-2d-2a's ABANDONED sweep can import the
				// same value instead of copying "2h" into a third place.
				workflowExecutionTimeout:
					PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS,
			}),
		);
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs).toEqual({
			cycleId: "cycle-1",
			projectId: "proj-1",
			organizationId: "org-1",
			tenantUserId: null,
			actorUserId: "user-1",
			coveredThroughIso: NOW.toISOString(),
			priorCoverage: {},
			// 1C-1b: every dispatch from this slice on carries the snapshot. It is
			// sent unconditionally because an ABSENT field means "an old history",
			// a meaning a live dispatch must never claim.
			preferences: buildPublishingPreferencesSnapshot({
				lookbackDays: null,
			}),
		});
	});

	it("passes the last SUCCESSFUL cycle's coverage as priorCoverage (F3), not the last cycle", async () => {
		wireFindFirst({
			prior: {
				sourceCoverage: { pullRequests: "2026-07-01T00:00:00.000Z" },
			},
			existing: null,
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockCountNew).toHaveBeenCalledWith("proj-1", "org-1", {
			pullRequests: "2026-07-01T00:00:00.000Z",
		});
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.priorCoverage).toEqual({
			pullRequests: "2026-07-01T00:00:00.000Z",
		});
	});

	it("is a no-op on a second dispatch — createOrGet returns the running cycle and start throws AlreadyStarted", async () => {
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-1",
				status: "GENERATING",
				temporalWorkflowId: null,
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			},
			created: false,
		});
		mockStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already running",
				"publishing-suggestion-cycle-1",
				"publishingSuggestionWorkflow",
			),
		);
		await expect(
			dispatchPublishingSuggestion({ projectId: "proj-1" }),
		).resolves.toBeUndefined();
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("re-throws a generic start failure so Temporal retries the activity", async () => {
		mockStart.mockRejectedValue(new Error("temporal down"));
		await expect(
			dispatchPublishingSuggestion({ projectId: "proj-1" }),
		).rejects.toThrow("temporal down");
	});

	it("skips (no createOrGet, no start) when the cost guard reports no new content", async () => {
		mockCountNew.mockResolvedValue({ hasNew: false });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("a quiet project with NO existing GENERATING cycle makes no describe call and no reclaim", async () => {
		mockCountNew.mockResolvedValue({ hasNew: false });
		// beforeEach already wires existing: null — confirm explicitly.
		wireFindFirst({ prior: null, existing: null });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockDescribe).not.toHaveBeenCalled();
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 1C-1 — runPublishingSuggestionDispatch is callable outside a Temporal
// Worker's activity-execution context (review fix)
// ---------------------------------------------------------------------------
describe("runPublishingSuggestionDispatch — callable outside a Temporal Worker", () => {
	// This is the property the dispatch-suggestion.ts split exists to
	// guarantee: `dispatchPublishingSuggestion` (the Temporal activity) calls
	// `heartbeat()`, which reaches `Context.current()` and throws when there is
	// no Worker's activity-execution context — exactly the situation the
	// manual "Generate now" trigger runs in, since it calls
	// `runPublishingSuggestionDispatch` directly from the API process. Every
	// OTHER test in this file uses a no-op `heartbeat` mock, which never
	// exercises this condition — a refactor that merged the wrapper back into
	// the core (moving the `heartbeat()` call inside what is now
	// `runPublishingSuggestionDispatch`) would break the manual trigger in
	// production while every other test here kept passing. This test makes
	// the mock throw the way the real `heartbeat()` does outside a Worker, so
	// it is the one case that would catch that regression.
	it("completes when heartbeat() throws, while the activity wrapper that calls heartbeat() rejects", async () => {
		mockHeartbeat.mockImplementation(() => {
			throw new Error("Context.current() called outside of an activity");
		});
		try {
			// The guarantee: the plain-function core never touches heartbeat(),
			// so it completes normally even when heartbeat() would throw.
			await expect(
				runPublishingSuggestionDispatch({ projectId: "proj-1" }),
			).resolves.toBeUndefined();
			// Proves the throwing mock actually bites (not a vacuous pass): the
			// activity wrapper DOES call heartbeat() first, so it rejects.
			await expect(
				dispatchPublishingSuggestion({ projectId: "proj-1" }),
			).rejects.toThrow(
				"Context.current() called outside of an activity",
			);
		} finally {
			// Restore so no other case in this file is affected.
			mockHeartbeat.mockImplementation(() => undefined);
		}
	});
});

// ---------------------------------------------------------------------------
// 1C-1 — force bypasses the dispatch-side cost guard; force/lookback reach
// the started workflow's input (review fix)
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — 1C-1 force/lookback pass-through", () => {
	it("force: true skips the cost guard — countNewContextSince is not called", async () => {
		// An earlier draft forced past the workflow's freshness gate (F7) but left
		// this dispatch-side spend guard live, which made the manual "Generate
		// now" trigger a no-op on a quiet project. Only the workflow-side gate
		// has a test today (publishing-suggestion-workflow.test.ts); this is the
		// dispatch-side half.
		await dispatchPublishingSuggestion({
			projectId: "proj-1",
			force: true,
		});
		expect(mockCountNew).not.toHaveBeenCalled();
	});

	it("force: true reaches the workflow input", async () => {
		await dispatchPublishingSuggestion({
			projectId: "proj-1",
			force: true,
		});
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs).toEqual({
			cycleId: "cycle-1",
			projectId: "proj-1",
			organizationId: "org-1",
			tenantUserId: null,
			actorUserId: "user-1",
			coveredThroughIso: NOW.toISOString(),
			priorCoverage: {},
			force: true,
			// 1C-1b: every dispatch from this slice on carries the snapshot. It is
			// sent unconditionally because an ABSENT field means "an old history",
			// a meaning a live dispatch must never claim.
			preferences: buildPublishingPreferencesSnapshot({
				lookbackDays: null,
			}),
		});
	});

	it("a configured lookback reaches the workflow input", async () => {
		mockGetSettings.mockResolvedValue({ lookbackDays: 30 });
		// This case is about the lookback reaching the input, so the last run
		// must have used the SAME lookback — otherwise the 1C-1b comparison
		// legitimately adds `force: true` and the payload pin fails for a
		// reason that has nothing to do with what it is pinning.
		mockLastRunHash.mockResolvedValue(currentHash(30));
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs).toEqual({
			cycleId: "cycle-1",
			projectId: "proj-1",
			organizationId: "org-1",
			tenantUserId: null,
			actorUserId: "user-1",
			coveredThroughIso: NOW.toISOString(),
			priorCoverage: {},
			lookbackDays: 30,
			// 1C-1b: every dispatch from this slice on carries the snapshot. It is
			// sent unconditionally because an ABSENT field means "an old history",
			// a meaning a live dispatch must never claim.
			preferences: buildPublishingPreferencesSnapshot({
				lookbackDays: 30,
			}),
		});
	});
});

// ---------------------------------------------------------------------------
// 1C-1 follow-up — `triggeredByUserId` is a durable audit breadcrumb threaded
// to `createOrGetPublishingCycle`, and is DELIBERATELY excluded from the
// workflow's input payload (no new replay-determinism surface).
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — triggeredByUserId audit breadcrumb", () => {
	it("the scheduled path (no triggeredByUserId on input) forwards undefined to createOrGetPublishingCycle", async () => {
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		const createArgs = mockCreateOrGet.mock.calls[0][0] as {
			triggeredByUserId?: string;
		};
		// A non-vacuous check on the actual call args (not `objectContaining`,
		// which would also pass if the key were dropped entirely): the scheduled
		// sweep's undefined must survive the round trip so `?? null` on the
		// query-layer side persists NULL, not a stale/forged value.
		expect(createArgs.triggeredByUserId).toBeUndefined();
	});

	it("a forced manual run forwards triggeredByUserId to createOrGetPublishingCycle", async () => {
		await dispatchPublishingSuggestion({
			projectId: "proj-1",
			force: true,
			triggeredByUserId: "user-clicked-42",
		});
		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({ triggeredByUserId: "user-clicked-42" }),
		);
	});

	it("triggeredByUserId never reaches the workflow's start input — no new replay-determinism surface", async () => {
		await dispatchPublishingSuggestion({
			projectId: "proj-1",
			force: true,
			triggeredByUserId: "user-clicked-42",
		});
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs).not.toHaveProperty("triggeredByUserId");
	});
});

// ---------------------------------------------------------------------------
// N2 — retry-after-terminalization idempotency (per-dispatch-run occurrenceKey)
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — N2 occurrenceKey retry idempotency", () => {
	it("threads dispatcherRunId as occurrenceKey and reuses the terminalized cycle on retry — no duplicate cycle, no duplicate workflow start", async () => {
		const RUN_ID = "dispatcher-run-R";
		type MockCycle = {
			id: string;
			status: string;
			temporalWorkflowId: string | null;
			coveredThrough: Date;
			executionTimeoutAt: Date;
		};
		// Stateful createOrGet mirroring the REAL (projectId, occurrenceKey) recovery:
		// a second call with the same key returns the SAME cycle (created:false), even
		// after it went terminal. `createdCount` is the mock's "cycle count" — it must
		// stay 1. If dispatch ever stops threading occurrenceKey, inp.occurrenceKey is
		// undefined, the store never matches, and the retry creates a 2nd cycle (RED).
		const store = new Map<string, MockCycle>();
		let createdCount = 0;
		mockCreateOrGet.mockImplementation(
			(inp: { projectId: string; occurrenceKey?: string }) => {
				const key = `${inp.projectId}::${inp.occurrenceKey}`;
				const existing = inp.occurrenceKey ? store.get(key) : undefined;
				if (existing) {
					return Promise.resolve({ cycle: existing, created: false });
				}
				createdCount += 1;
				const cycle: MockCycle = {
					id: `cycle-${createdCount}`,
					status: "GENERATING",
					temporalWorkflowId: null,
					coveredThrough: NOW,
					executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
				};
				if (inp.occurrenceKey) {
					store.set(key, cycle);
				}
				return Promise.resolve({ cycle, created: true });
			},
		);
		// A quiet project with NO existing GENERATING cycle; the default hasNew:true
		// (an ACTIVE integration forces it) makes the retry proceed to createOrGet.
		wireFindFirst({ prior: null, existing: null });

		// First dispatch under RUN_ID → creates + starts cycle-1.
		await dispatchPublishingSuggestion({
			projectId: "proj-1",
			dispatcherRunId: RUN_ID,
		});
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(mockStart.mock.calls[0][1].workflowId).toBe(
			"publishing-suggestion-cycle-1",
		);
		expect(mockCreateOrGet).toHaveBeenLastCalledWith(
			expect.objectContaining({ occurrenceKey: RUN_ID }),
		);

		// The generation workflow completes and terminalizes the cycle (READY) —
		// freeing the active-GENERATING slot. The stored occurrence cycle persists.
		const stored = store.get(`proj-1::${RUN_ID}`);
		if (stored) {
			stored.status = "READY";
		}
		// The retry's same-id start is an AlreadyStarted no-op.
		mockStart.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"already ran",
				"publishing-suggestion-cycle-1",
				"publishingSuggestionWorkflow",
			),
		);

		// Retry with the SAME dispatcherRunId.
		await expect(
			dispatchPublishingSuggestion({
				projectId: "proj-1",
				dispatcherRunId: RUN_ID,
			}),
		).resolves.toBeUndefined();

		// NO duplicate cycle was created — the retry recovered the terminalized cycle.
		expect(createdCount).toBe(1);
		// No NEW workflowId was ever started; the retry's start was an AlreadyStarted no-op.
		const startedIds = mockStart.mock.calls.map(
			(c: unknown[]) => (c[1] as { workflowId: string }).workflowId,
		);
		expect(new Set(startedIds)).toEqual(
			new Set(["publishing-suggestion-cycle-1"]),
		);
	});
});

// ---------------------------------------------------------------------------
// Reorder — reclaim runs BEFORE the cost guard (review fix)
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — reclaim before cost guard", () => {
	it("reclaims a stale GENERATING cycle on a QUIET project (hasNew: false) but still skips createOrGet/start", async () => {
		// Reclaim-eligible via the hard executionTimeoutAt override (deterministic,
		// no describe() mocking needed) — mirrors table case (vi).
		wireFindFirst({
			existing: generating(30 * MIN, {
				executionTimeoutAt: new Date(NOW.getTime() - MIN), // already past
			}),
		});
		mockCountNew.mockResolvedValue({ hasNew: false });

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		// The stale cycle IS reclaimed even though this dispatch has no new content.
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "cycle-old",
					projectId: "proj-1",
					status: "GENERATING",
				}),
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		// But the cost guard still short-circuits: no new cycle, no workflow start.
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// H4 — sweep-to-dispatch mutation / deletion
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — H4 fresh read", () => {
	it("skips a project HARD-deleted between sweep and dispatch (fresh read null)", async () => {
		setFresh(null);
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockCountNew).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	// F3: distinct from the hard-missing-row case above — the row still exists by
	// id (findUnique returns it) but no longer clears the eligibility filter, so
	// the F3 findFirst (status ACTIVE + deletedAt null) resolves null → skip. This
	// is RED against the pre-fix `findUnique({ where: { id } })` read, which would
	// still resolve the row and proceed to createOrGet.
	it("skips a project soft-deleted / non-ACTIVE at dispatch time (F3 eligibility re-check)", async () => {
		mockDb.project.findUnique.mockResolvedValue({
			id: "proj-1",
			userId: "user-1",
			organizationId: null,
		});
		mockDb.project.findFirst.mockResolvedValue(null); // eligibility filter excludes it
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		// The fresh read is eligibility-scoped, not a bare id lookup.
		expect(mockDb.project.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "proj-1",
					status: "ACTIVE",
					deletedAt: null,
				}),
			}),
		);
		expect(mockCountNew).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("derives the cycle tenant tuple from the FRESH read, not the sweep item (org changed)", async () => {
		// The project moved into an org since the sweep snapshot.
		setFresh({ id: "proj-1", userId: "owner-9", organizationId: "org-9" });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-9",
				userId: null, // XOR-normalized: org context → tenantUserId null
				actorUserId: "owner-9",
			}),
		);
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.organizationId).toBe("org-9");
		expect(startArgs.tenantUserId).toBe(null);
		expect(startArgs.actorUserId).toBe("owner-9");
	});

	// Codex fix round 2: Task 8 added the organization dimension to the SWEEP's
	// eligibility filter but the dispatch-time mirror was never extended to
	// match — a project selected while its organization was allowed could still
	// create a cycle and start a (cost-incurring) generation workflow if the
	// organization was disabled, or the project transferred into a disabled
	// organization, in the window between sweep and dispatch. These two cases
	// prove the re-check the fix adds, driven by the FRESH organizationId, not
	// the sweep's.
	//
	// Round 2 (§E): the re-check must be UNCACHED — `isFeatureEnabled` (round
	// 1's choice) shares a 10-second TTL cache with the sweep that ran seconds
	// earlier, which could make this re-check silently answer with the SWEEP's
	// own stale value instead of a fresh one. It drives
	// `getOrganizationFlagOverrideUncached` — a single-row read of this
	// project's own organization, reshaped from the sweep's list readers in
	// the Copilot-review follow-up — via
	// `isPublishingSuiteEnabledForOrganizationUncached`. A present row decides
	// the question on its own; `getGlobalFlagOverride` (the reader
	// `findEligibleProjects` itself uses) is only consulted when the row is
	// absent.
	it("skips a project whose organization is disabled between sweep and dispatch (F3 organization re-check)", async () => {
		setFresh({
			id: "proj-1",
			userId: "owner-1",
			organizationId: "org-1",
		});
		// The organization's PUBLISHING_SUITE override flips to an explicit
		// disabled row after the sweep selected this project but before this
		// dispatch runs. The row alone decides — global stays enabled
		// (beforeEach default) but must not be consulted.
		mockGetOrgFlagOverride.mockResolvedValue(false);

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockGetOrgFlagOverride).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			"org-1",
		);
		expect(mockGetGlobalFlagOverride).not.toHaveBeenCalled();
		expect(mockCountNew).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("skips a project transferred into a disabled organization between sweep and dispatch", async () => {
		// The sweep selected this project under its OLD organization (allowed);
		// by dispatch time the fresh read shows it moved into a DIFFERENT
		// organization that has PUBLISHING_SUITE disabled. The flag re-check
		// must be driven by this fresh organizationId, never anything carried
		// from the sweep item.
		setFresh({
			id: "proj-1",
			userId: "owner-1",
			organizationId: "org-new-disabled",
		});
		mockGetOrgFlagOverride.mockResolvedValue(false);

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockGetOrgFlagOverride).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			"org-new-disabled",
		);
		expect(mockCountNew).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	// ADR-018 ("An organization is the only tenant context"): a project that
	// resolves with no organization at dispatch time — e.g. transferred OUT of
	// its organization between sweep and dispatch — is refused outright, the
	// same as the API gate and the sweep. This INVERTS the pre-ADR-018 pin
	// ("resolves a personal project against the global value alone"), which
	// asserted the opposite: that a personal project fell through to the
	// global answer and dispatched normally. It must not any more — and the
	// refusal must not even read the global flag: no organization to resolve
	// against is a bug upstream, not a value to fall back on.
	it("refuses a personal project outright — no global read, no per-organization lookup, no dispatch", async () => {
		setFresh({
			id: "proj-1",
			userId: "owner-1",
			organizationId: null,
		});
		mockGetGlobalFlagOverride.mockResolvedValue(true);

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockGetGlobalFlagOverride).not.toHaveBeenCalled();
		expect(mockGetEnabledOrgIds).not.toHaveBeenCalled();
		expect(mockGetDisabledOrgIds).not.toHaveBeenCalled();
		expect(mockGetOrgFlagOverride).not.toHaveBeenCalled();
		expect(mockCountNew).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// M11 — liveness table (tri-state reclaim)
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — liveness table (M11)", () => {
	it("(i) within grace + definite WorkflowNotFound → UNKNOWN → NO reclaim", async () => {
		wireFindFirst({ existing: generating(2 * MIN) }); // < 5 min grace
		mockDescribe.mockRejectedValue(
			new WorkflowNotFoundError(
				"gone",
				"publishing-suggestion-cycle-old",
				undefined,
			),
		);
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
	});

	it("(ii) past grace + definite WorkflowNotFound → DEAD → reclaim (before 2h timeout)", async () => {
		wireFindFirst({ existing: generating(10 * MIN) }); // > 5 min, well under 2h
		mockDescribe.mockRejectedValue(
			new WorkflowNotFoundError(
				"gone",
				"publishing-suggestion-cycle-old",
				undefined,
			),
		);
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "cycle-old",
					projectId: "proj-1",
					status: "GENERATING",
				}),
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("(iii) past grace + terminal describe status → DEAD → reclaim", async () => {
		wireFindFirst({ existing: generating(10 * MIN) });
		mockDescribe.mockResolvedValue({ status: { name: "FAILED" } });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledTimes(1);
	});

	it("(iv) ambiguous describe throw (Temporal-unavailable) → UNKNOWN → NO reclaim, even past grace", async () => {
		wireFindFirst({ existing: generating(30 * MIN) });
		mockDescribe.mockRejectedValue(new Error("DEADLINE_EXCEEDED")); // NOT WorkflowNotFoundError
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
	});

	it("(iv-b) getTemporalClient throwing during liveness → UNKNOWN → NO reclaim", async () => {
		wireFindFirst({ existing: generating(30 * MIN) });
		// First getClient call (liveness) throws; but createOrGet/start still need one.
		mockGetClient
			.mockRejectedValueOnce(new Error("connect failed"))
			.mockResolvedValue({
				workflow: { start: mockStart, getHandle: mockGetHandle },
			});
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-1",
				status: "GENERATING",
				temporalWorkflowId: null,
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			},
			created: false,
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
	});

	it("(v) RUNNING → NO reclaim", async () => {
		wireFindFirst({ existing: generating(30 * MIN) });
		mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
	});

	it("(v-b) CONTINUED_AS_NEW → NO reclaim", async () => {
		wireFindFirst({ existing: generating(30 * MIN) });
		mockDescribe.mockResolvedValue({
			status: { name: "CONTINUED_AS_NEW" },
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).not.toHaveBeenCalled();
	});

	it("(vi) now > executionTimeoutAt → reclaim REGARDLESS of liveness (never even describes)", async () => {
		wireFindFirst({
			existing: generating(30 * MIN, {
				executionTimeoutAt: new Date(NOW.getTime() - MIN), // already past
			}),
		});
		mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } }); // would say alive
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledTimes(1);
		expect(mockDescribe).not.toHaveBeenCalled(); // timeout override short-circuits liveness
	});
});

// ---------------------------------------------------------------------------
// M11 — races
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — races (M11)", () => {
	it("create→start race: a cycle created but never started is reclaimed once past grace and re-dispatched", async () => {
		wireFindFirst({ existing: generating(10 * MIN, { id: "orphan" }) });
		mockDescribe.mockRejectedValue(
			new WorkflowNotFoundError(
				"gone",
				"publishing-suggestion-orphan",
				undefined,
			),
		);
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-2",
				status: "GENERATING",
				temporalWorkflowId: null,
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			},
			created: true,
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		// Reclaimed the orphan, then started a FRESH deterministic run.
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "orphan" }),
			}),
		);
		expect(mockStart).toHaveBeenCalledWith(
			"publishingSuggestionWorkflow",
			expect.objectContaining({
				workflowId: "publishing-suggestion-cycle-2",
			}),
		);
	});

	it("start→id race: the workflowId is always recomputed from cycle.id, never the nullable temporalWorkflowId", async () => {
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-7",
				status: "GENERATING",
				temporalWorkflowId: "STALE-DO-NOT-USE",
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			},
			created: false,
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		expect(mockStart).toHaveBeenCalledWith(
			"publishingSuggestionWorkflow",
			expect.objectContaining({
				workflowId: "publishing-suggestion-cycle-7",
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// F2 — tenant-tuple-scoped reads + cross-tenant supersede (org transfer)
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — F2 tenant-tuple scoping", () => {
	it("scopes the priorCoverage read by the FRESH tenant tuple (transferred project doesn't inherit old-tenant watermarks)", async () => {
		setFresh({ id: "proj-1", userId: "owner-9", organizationId: "org-9" });
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		// The status-IN (priorCoverage / last-successful) findFirst must be scoped
		// by the fresh org + XOR-normalized userId, not just projectId.
		const priorCall =
			mockDb.publishingSuggestionCycle.findFirst.mock.calls.find(
				(call: unknown[]) => {
					const args = call[0] as
						| { where?: { status?: unknown } }
						| undefined;
					const status = args?.where?.status;
					return (
						!!status &&
						typeof status === "object" &&
						"in" in (status as object)
					);
				},
			);
		expect((priorCall?.[0] as { where?: unknown })?.where).toEqual(
			expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-9",
				userId: null, // XOR-normalized org context
			}),
		);
	});

	it("supersedes a stale CROSS-TENANT GENERATING cycle (org transfer) and creates a fresh cycle under the new tuple, bypassing liveness", async () => {
		// The project transferred into org-9 since the OLD cycle was stamped
		// (personal, user-1). That leftover GENERATING cycle still holds the
		// projectId-scoped partial-index slot.
		setFresh({ id: "proj-1", userId: "owner-9", organizationId: "org-9" });
		wireFindFirst({
			existing: {
				id: "stale-xtenant",
				startedAt: new Date(NOW.getTime() - MIN), // within grace…
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN), // …and NOT timed out
				organizationId: null, // OLD personal tuple — mismatches fresh org-9
				userId: "user-1",
			},
		});
		// A same-tenant cycle in this state (RUNNING, within grace, not timed out)
		// would NOT be reclaimed. The cross-tenant path must reclaim anyway and
		// must NOT even consult liveness.
		mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-new",
				status: "GENERATING",
				temporalWorkflowId: null,
				coveredThrough: NOW,
				executionTimeoutAt: new Date(NOW.getTime() + 2 * 60 * MIN),
			},
			created: true,
		});

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		// Unconditional supersede of the stale cross-tenant cycle (projectId-scoped CAS).
		expect(
			mockDb.publishingSuggestionCycle.updateMany,
		).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "stale-xtenant",
					projectId: "proj-1",
					status: "GENERATING",
				}),
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		// Liveness was never probed — the tuple mismatch short-circuits it.
		expect(mockDescribe).not.toHaveBeenCalled();
		// A fresh cycle is created under the NEW tenant tuple.
		expect(mockCreateOrGet).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-9",
				userId: null,
				actorUserId: "owner-9",
			}),
		);
		expect(mockStart).toHaveBeenCalledWith(
			"publishingSuggestionWorkflow",
			expect.objectContaining({
				workflowId: "publishing-suggestion-cycle-new",
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// F4 — workflow input built from the cycle's STORED coveredThrough boundary
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — F4 stored boundary", () => {
	it("uses the cycle's STORED coveredThrough on a reused cycle (created:false), not the retry's now", async () => {
		const storedCoveredThrough = new Date("2026-07-14T05:30:00.000Z"); // T0, 30m before retry NOW
		expect(storedCoveredThrough.toISOString()).not.toBe(NOW.toISOString());
		mockCreateOrGet.mockResolvedValue({
			cycle: {
				id: "cycle-reused",
				status: "GENERATING",
				temporalWorkflowId: null,
				coveredThrough: storedCoveredThrough,
				executionTimeoutAt: new Date(
					storedCoveredThrough.getTime() + 2 * 60 * MIN,
				),
			},
			created: false,
		});
		await dispatchPublishingSuggestion({ projectId: "proj-1" });
		const startArgs = mockStart.mock.calls[0][1].args[0];
		expect(startArgs.coveredThroughIso).toBe(
			storedCoveredThrough.toISOString(),
		);
		expect(startArgs.coveredThroughIso).not.toBe(NOW.toISOString());
	});
});

// ---------------------------------------------------------------------------
// livenessOf — direct unit checks of the tri-state
// ---------------------------------------------------------------------------
describe("livenessOf", () => {
	const wfId = "publishing-suggestion-x";

	it("RUNNING → RUNNING", async () => {
		mockDescribe.mockResolvedValue({ status: { name: "RUNNING" } });
		expect(
			await livenessOf(wfId, new Date(NOW.getTime() - 30 * MIN), NOW),
		).toBe("RUNNING");
	});

	it("terminal describe status → DEAD", async () => {
		mockDescribe.mockResolvedValue({ status: { name: "TIMED_OUT" } });
		expect(
			await livenessOf(wfId, new Date(NOW.getTime() - 30 * MIN), NOW),
		).toBe("DEAD");
	});

	it("definite WorkflowNotFound within grace → UNKNOWN", async () => {
		mockDescribe.mockRejectedValue(
			new WorkflowNotFoundError("gone", wfId, undefined),
		);
		expect(
			await livenessOf(wfId, new Date(NOW.getTime() - 2 * MIN), NOW),
		).toBe("UNKNOWN");
	});

	it("definite WorkflowNotFound past grace → DEAD", async () => {
		mockDescribe.mockRejectedValue(
			new WorkflowNotFoundError("gone", wfId, undefined),
		);
		expect(
			await livenessOf(wfId, new Date(NOW.getTime() - 10 * MIN), NOW),
		).toBe("DEAD");
	});

	it("ambiguous describe throw → UNKNOWN (never DEAD)", async () => {
		mockDescribe.mockRejectedValue(new Error("connection reset"));
		expect(
			await livenessOf(wfId, new Date(NOW.getTime() - 10 * MIN), NOW),
		).toBe("UNKNOWN");
	});
});

// ---------------------------------------------------------------------------
// Job Hub row (Fizzy #1850)
// ---------------------------------------------------------------------------
describe("runPublishingSuggestionDispatch — Job Hub row", () => {
	it("opens one row keyed to the workflow it just started", async () => {
		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockEnsureJob).toHaveBeenCalledTimes(1);
		expect(mockEnsureJob).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "PUBLISHING_TOPIC_GENERATION",
				title: "Topic suggestions",
				projectId: "proj-1",
				// The project OWNER, which is what the Job Hub's tenant filter
				// matches on — not whoever triggered the run. A row keyed to a
				// triggering guest would be invisible to the owner.
				userId: "user-1",
				organizationId: "org-1",
				workflowId: "publishing-suggestion-cycle-1",
				sourceId: null,
				steps: [
					{ key: "collect", status: "pending" },
					{ key: "summarize", status: "pending" },
					{ key: "persist", status: "pending" },
				],
			}),
		);
	});

	it("leaves exactly one row on the AlreadyStarted branch, and does not fail it", async () => {
		// Three arguments, even though the runtime double is a bare
		// `class extends Error {}`: `tsc` checks this against the REAL
		// constructor signature imported from `@temporalio/client`, so a
		// message-only call type-checks as an error while passing at runtime.
		mockStart.mockRejectedValueOnce(
			new WorkflowExecutionAlreadyStartedError(
				"already started",
				"publishing-suggestion-cycle-1",
				"publishingSuggestionWorkflow",
			),
		);

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		// Exactly one: the row was opened before the start, and the winner of the
		// race shares it — `ensureRunningBackgroundJob` adopts by
		// (workflowId, sourceId). A second call here would mean a second row.
		expect(mockEnsureJob).toHaveBeenCalledTimes(1);
		expect(mockFailJob).not.toHaveBeenCalled();
	});

	it("closes the row rather than orphaning it when a generic start failure re-throws", async () => {
		mockStart.mockRejectedValueOnce(new Error("connection reset"));

		await expect(
			dispatchPublishingSuggestion({ projectId: "proj-1" }),
		).rejects.toThrow("connection reset");

		// Left RUNNING it would claim a run that does not exist until the watchdog
		// failed it 45 minutes later with "no progress reported" — true and
		// useless. The transport error is more use, and the error class is what
		// lets Temporal's retry reopen THIS row instead of opening a second.
		expect(mockFailJob).toHaveBeenCalledWith(
			{
				workflowId: "publishing-suggestion-cycle-1",
				sourceId: null,
			},
			{
				error: expect.stringContaining("connection reset"),
				errorClass: "PublishingStartFailed",
			},
		);
	});

	it("opens the row BEFORE starting the workflow, so a fast terminal run cannot close it before it exists", async () => {
		const order: string[] = [];
		mockEnsureJob.mockImplementation(async () => {
			order.push("job");
		});
		mockStart.mockImplementation(async () => {
			order.push("start");
			return { workflowId: "publishing-suggestion-cycle-1" };
		});

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		// `start` only confirms the server accepted it; the worker may already be
		// running the workflow. A tenant-mismatch run terminalizes in two activity
		// calls, so a row opened afterwards would be one nothing is left to close.
		expect(order).toEqual(["job", "start"]);
	});

	it("reopens its own failed row on a retry rather than opening a second", async () => {
		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockEnsureJob).toHaveBeenCalledWith(
			expect.objectContaining({
				reopenFailedWithClass: "PublishingStartFailed",
			}),
		);
	});

	it("opens no row when the cost guard skips the cycle — no cycle, no workflow, no job", async () => {
		mockCountNew.mockResolvedValue({ hasNew: false });

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockEnsureJob).not.toHaveBeenCalled();
	});

	it("opens no row for a project archived or deleted between sweep and dispatch — the eligibility read returns first, before any cycle exists", async () => {
		setFresh(null);

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockEnsureJob).not.toHaveBeenCalled();
		expect(mockCreateOrGet).not.toHaveBeenCalled();
		expect(mockStart).not.toHaveBeenCalled();
	});

	it("gives up on a job writer that never settles, rather than hanging the dispatch", async () => {
		// safely() in job-progress swallows a writer that THROWS. Nothing bounds
		// one that HANGS, and on the manual "Generate now" path this code runs
		// inside an HTTP handler — an unbounded write there turns a slow database
		// into a hung request. The generation workflow's first activity re-ensures
		// the row, so abandoning the wait costs only the moment of immediacy.
		mockEnsureJob.mockImplementation(() => new Promise(() => undefined));

		const dispatched = dispatchPublishingSuggestion({
			projectId: "proj-1",
		});
		await vi.advanceTimersByTimeAsync(5_000);

		await expect(dispatched).resolves.toBeUndefined();
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("does not let a failing job writer break the dispatch — the workflow is already running by then", async () => {
		mockEnsureJob.mockRejectedValueOnce(new Error("db down"));

		await expect(
			dispatchPublishingSuggestion({ projectId: "proj-1" }),
		).resolves.toBeUndefined();
		expect(mockStart).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// 1C-1b (§7.1) — the preferences fingerprint: compare, bypass, send.
// ---------------------------------------------------------------------------
describe("dispatchPublishingSuggestion — preferences fingerprint", () => {
	it("skips the cost guard when the preferences hash differs from the last run", async () => {
		mockLastRunHash.mockResolvedValue("stale-hash");
		mockCountNew.mockResolvedValue({ hasNew: false });

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		// Without the bypass, `hasNew: false` returns early and the promised
		// recovery run never happens — for a project with no ACTIVE repo
		// integration and no new local content, dispatch would never reach the
		// workflow at all.
		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("still honours the cost guard when the preferences are unchanged", async () => {
		mockLastRunHash.mockResolvedValue(currentHash());
		mockCountNew.mockResolvedValue({ hasNew: false });

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockStart).not.toHaveBeenCalled();
	});

	it("treats a project that has never recorded a hash as changed", async () => {
		// Every cycle written before this slice has a null hash. That is what
		// gives an already-harmed project its one recovery run.
		mockLastRunHash.mockResolvedValue(null);
		mockCountNew.mockResolvedValue({ hasNew: false });

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockStart).toHaveBeenCalledTimes(1);
	});

	it("bypasses the workflow freshness gate on a mismatch, not only the cost guard", async () => {
		// Skipping the cost guard alone is not enough: the run would reach the
		// workflow and then be stopped by F7, because the watermark has already
		// advanced past the very content the change is meant to resurface.
		mockLastRunHash.mockResolvedValue("stale-hash");

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockStart.mock.calls[0][1].args[0].force).toBe(true);
	});

	it("does not set force when the preferences are unchanged", async () => {
		mockLastRunHash.mockResolvedValue(currentHash());

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockStart.mock.calls[0][1].args[0].force).toBeUndefined();
	});

	it("sends the SNAPSHOT on the workflow input, so the consumer and the fingerprint agree", async () => {
		mockGetSettings.mockResolvedValue({ lookbackDays: 30 });
		mockLastRunHash.mockResolvedValue("stale-hash");

		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		const sent = mockStart.mock.calls[0][1].args[0].preferences;
		// The transport C-2 and C-3 will read. Asserting its HASH rather than its
		// shape is what pins the two together: a dispatch that compared one
		// snapshot and shipped another would pass a shape assertion.
		expect(computePublishingPreferencesHash(sent)).toBe(currentHash(30));
	});

	it("scopes the last-run lookup by the FRESH normalized tenant tuple", async () => {
		// A cycle written before an org transfer must not settle a mismatch for
		// the new tenant — the same reasoning that scopes the priorCoverage read.
		await dispatchPublishingSuggestion({ projectId: "proj-1" });

		expect(mockLastRunHash).toHaveBeenCalledWith("proj-1", {
			organizationId: "org-1",
			userId: null,
		});
	});
});
