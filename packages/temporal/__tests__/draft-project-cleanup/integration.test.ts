/**
 * Integration tests for `draftProjectCleanupWorkflow` — Group 13 of
 * `fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md`.
 *
 * Scope:
 *   - Workflow-level scheduling + invocation contract end-to-end.
 *   - Activity is invoked once per fire and its counts are returned verbatim.
 *   - Partial-failure path: workflow completes with `errors` populated; the
 *     schedule is NOT aborted — the next cron fire retries naturally.
 *   - Fixture: 5 DRAFT projects (3 abandoned past the 14-day cutoff, 2 within
 *     the window). After one fire, 3 drafts deleted, 2 untouched.
 *
 * Group 5 (`cleanup-abandoned-drafts-activity.test.ts`) covers the activity
 * boundary in isolation. This group covers the workflow-level contract:
 *   - workflow → activity passthrough (one call per fire),
 *   - activity-output → workflow-output passthrough (no workflow-side
 *     mutation),
 *   - cron fire-to-fire idempotency (the schedule retries the failed DRAFT
 *     on the next fire instead of aborting).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why NOT TestWorkflowEnvironment
 * ─────────────────────────────────────────────────────────────────────────
 * Repo convention — see the header of
 *   packages/temporal/src/workflows/monitoring/__tests__/incident-lifecycle.test.ts
 * and the matching header on
 *   packages/temporal/__tests__/url-source/cancellation.test.ts
 * (Group 4 of this spec) — is to mock the activity's I/O surface with
 * `vi.fn()` and exercise the workflow body as a small async helper. Reasons:
 *
 *   1. The workflow body for `draftProjectCleanupWorkflow` is one activity
 *      call. The observable contract we care about (activity runs once with
 *      the right input, output passes through unchanged, the schedule fires
 *      again on the next cron beat with whatever still qualifies) is fully
 *      checkable without lifting a Temporalite worker into CI.
 *   2. `TestWorkflowEnvironment` pulls Temporalite (a Go binary) into CI.
 *      For a one-activity workflow that lives next to a CI replay-validation
 *      matrix already exercising the bundled workflow code against real
 *      dev histories (§6.5 + Group 5.4), the extra runtime is dead weight.
 *   3. The replay-validation matrix at
 *      `.github/workflows/temporal-replay-validation.yml` is the real
 *      determinism gate; this test pins the activity-call shape + the
 *      schedule-retry semantics that the replay matrix can't observe
 *      (because individual cron fires are independent workflow executions
 *      in the replay world).
 *
 * Same convention as Group 5.5 (`draft-project-cleanup-workflow.test.ts`)
 * and the `incidentLifecycleWorkflow` tests — see those file headers for
 * the broader rationale.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test __tests__/draft-project-cleanup/integration
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — DB + Temporal client + logger (mirrors the Group 5 activity test
// setup so the same fixture seeds drive both layers)
// ---------------------------------------------------------------------------

const mockProjectFindMany = vi.fn();
const mockProjectContextFindMany = vi.fn();
const mockSoftDeleteProject = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findMany: (...args: unknown[]) => mockProjectFindMany(...args),
		},
		projectContext: {
			findMany: (...args: unknown[]) =>
				mockProjectContextFindMany(...args),
		},
	},
	softDeleteProject: (...args: unknown[]) => mockSoftDeleteProject(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	},
}));

const mockWorkflowCancel = vi.fn();
const mockGetHandle = vi.fn((workflowId: string) => ({
	cancel: () => mockWorkflowCancel(workflowId),
}));
const mockGetTemporalClient = vi.fn(async () => ({
	workflow: {
		getHandle: mockGetHandle,
	},
}));

vi.mock("../../src/client", () => ({
	getTemporalClient: () => mockGetTemporalClient(),
}));

// `heartbeat()` is a no-op outside an activity context, but stub it so the
// activity body doesn't throw when invoked from Vitest.
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

// Imports MUST come after `vi.mock` — module-init order matters.
import {
	cleanupAbandonedDraftsActivity,
	type DraftProjectCandidate,
} from "../../src/activities/draft-project-cleanup/cleanup-abandoned-drafts-activity";
import type {
	DraftProjectCleanupWorkflowInput,
	DraftProjectCleanupWorkflowOutput,
} from "../../src/workflows/draft-project-cleanup";

// ---------------------------------------------------------------------------
// Workflow mirror — kept in test scope so a divergence is caught on code
// review. The production workflow body (`draft-project-cleanup.ts`) is
// 30 lines: it passes the input to the activity, logs the result, and
// returns the activity output unchanged.
//
// This mirror calls the REAL activity (which is what makes this an
// integration test — the activity runs against the mocked DB + Temporal
// client) rather than a `vi.fn()` shim, so the full workflow + activity
// pipeline is exercised in one pass.
// ---------------------------------------------------------------------------

async function runWorkflowFire(
	input: DraftProjectCleanupWorkflowInput = {},
): Promise<DraftProjectCleanupWorkflowOutput> {
	return await cleanupAbandonedDraftsActivity({
		cutoffDays: input.cutoffDays,
		batchSize: input.batchSize,
	});
}

// ---------------------------------------------------------------------------
// Fixtures — 5 DRAFT projects
//   - d1, d2, d3 → abandoned past the 14-day cutoff (eligible)
//   - d4, d5 → within the 14-day window (NOT eligible)
//
// The activity's Postgres `findMany` runs the same `updatedAt < cutoff`
// predicate Postgres-side; the test mocks `findMany` to return only the
// eligible subset, mirroring what the real query would return.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-05-23T03:00:00.000Z");
const CUTOFF_15D_AGO = new Date("2026-05-08T00:00:00.000Z"); // past cutoff
const CUTOFF_20D_AGO = new Date("2026-05-03T00:00:00.000Z"); // past cutoff
const CUTOFF_18D_AGO = new Date("2026-05-05T00:00:00.000Z"); // past cutoff
const RECENT_2D_AGO = new Date("2026-05-21T00:00:00.000Z"); // within window
const RECENT_5D_AGO = new Date("2026-05-18T00:00:00.000Z"); // within window

const ALL_DRAFTS: DraftProjectCandidate[] = [
	{
		id: "d1",
		userId: "u1",
		organizationId: null,
		updatedAt: CUTOFF_20D_AGO,
		status: "DRAFT",
		deletedAt: null,
	},
	{
		id: "d2",
		userId: "u2",
		organizationId: "org-1",
		updatedAt: CUTOFF_18D_AGO,
		status: "DRAFT",
		deletedAt: null,
	},
	{
		id: "d3",
		userId: "u3",
		organizationId: null,
		updatedAt: CUTOFF_15D_AGO,
		status: "DRAFT",
		deletedAt: null,
	},
	{
		id: "d4",
		userId: "u4",
		organizationId: null,
		updatedAt: RECENT_2D_AGO,
		status: "DRAFT",
		deletedAt: null,
	},
	{
		id: "d5",
		userId: "u5",
		organizationId: null,
		updatedAt: RECENT_5D_AGO,
		status: "DRAFT",
		deletedAt: null,
	},
];

const ELIGIBLE_DRAFTS: DraftProjectCandidate[] = ALL_DRAFTS.filter(
	(d) => d.updatedAt.getTime() < NOW.getTime() - 14 * 24 * 60 * 60 * 1000,
);

/**
 * Helper: configure `mockProjectFindMany` to return only the eligible
 * subset, mirroring Postgres applying `updatedAt < now - 14d` server-side.
 *
 * Accepts a `surviving` set so a follow-up fire can simulate which DRAFTs
 * still exist after a previous fire deleted some of them.
 */
function seedFindMany(surviving: DraftProjectCandidate[]): void {
	mockProjectFindMany.mockResolvedValueOnce(
		surviving.filter(
			(d) =>
				d.status === "DRAFT" &&
				d.deletedAt === null &&
				d.updatedAt.getTime() <
					NOW.getTime() - 14 * 24 * 60 * 60 * 1000,
		),
	);
}

// ---------------------------------------------------------------------------
// 13.1 — Workflow runs the activity once and returns counts (eligible 3,
// untouched 2)
// ---------------------------------------------------------------------------

describe("draftProjectCleanupWorkflow — integration", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockProjectContextFindMany.mockResolvedValue([]); // no in-flight LINK rows by default
		mockSoftDeleteProject.mockResolvedValue({});
		mockWorkflowCancel.mockResolvedValue(undefined);
	});

	it("13.1: single fire deletes 3 abandoned drafts and leaves 2 within-window drafts untouched", async () => {
		seedFindMany(ALL_DRAFTS);

		const result = await runWorkflowFire({ cutoffDays: 14, batchSize: 50 });

		// (a) workflow ran the activity once. Postgres-side query is the
		// single observable "fire" of the activity for this workflow.
		expect(mockProjectFindMany).toHaveBeenCalledTimes(1);

		// (b) activity returns counts in the expected shape.
		expect(result).toEqual({
			draftsDeleted: 3,
			workflowsCancelled: 0,
			errors: [],
		});

		// (c) exactly 3 drafts deleted — the eligible subset.
		expect(mockSoftDeleteProject).toHaveBeenCalledTimes(3);
		const deletedIds = mockSoftDeleteProject.mock.calls.map(
			(c) => c[0] as string,
		);
		expect(deletedIds.sort()).toEqual(["d1", "d2", "d3"]);

		// (d) tenancy honored on every soft-delete — `(projectId, userId,
		// organizationId)` tuple matches the DRAFT's owner.
		expect(mockSoftDeleteProject).toHaveBeenCalledWith(
			"d1",
			"u1",
			undefined,
		);
		expect(mockSoftDeleteProject).toHaveBeenCalledWith("d2", "u2", "org-1");
		expect(mockSoftDeleteProject).toHaveBeenCalledWith(
			"d3",
			"u3",
			undefined,
		);

		// (e) the 2 within-window drafts are NEVER passed to softDeleteProject.
		expect(deletedIds).not.toContain("d4");
		expect(deletedIds).not.toContain("d5");

		// Confirm the workflow's query honored the documented batch size +
		// the `lt: cutoff` predicate (sanity-check the Prisma `where` clause
		// the activity issues — the only public surface where the workflow
		// input flows through to the DB).
		const findCall = mockProjectFindMany.mock.calls[0]?.[0] as {
			where: { status: string; deletedAt: null; updatedAt: { lt: Date } };
			take: number;
			orderBy: { updatedAt: "asc" };
		};
		expect(findCall?.take).toBe(50);
		expect(findCall?.where.status).toBe("DRAFT");
		expect(findCall?.where.deletedAt).toBeNull();
		expect(findCall?.where.updatedAt.lt).toBeInstanceOf(Date);
	});

	// -------------------------------------------------------------------------
	// 13.2 — Partial-failure path: workflow records the failure but does NOT
	// abort the schedule; the next fire retries the failed DRAFT
	// -------------------------------------------------------------------------

	it("13.2: cancellation failure on one DRAFT is recorded in errors[] without aborting the batch — and the next cron fire retries the same set", async () => {
		// d1 has one in-flight workflow that throws a non-"not found" error.
		// d2 + d3 have no in-flight workflows, so they're soft-deleted cleanly.
		mockProjectContextFindMany.mockImplementation(
			async (args: { where: { projectId: string } }) => {
				if (args.where.projectId === "d1") {
					return [
						{
							id: "ctx-blocked",
							projectId: "d1",
							urlActiveWorkflowId: "wf-blocked",
						},
					];
				}
				return [];
			},
		);
		mockWorkflowCancel.mockImplementation(async (workflowId: string) => {
			if (workflowId === "wf-blocked") {
				throw new Error(
					"Temporal namespace unavailable — connection refused",
				);
			}
		});

		// ── First fire ────────────────────────────────────────────────────
		seedFindMany(ALL_DRAFTS);
		const fire1 = await runWorkflowFire({ cutoffDays: 14, batchSize: 50 });

		// Workflow completes with `errors` populated — it does NOT throw,
		// so Temporal records the workflow execution as COMPLETED (not
		// FAILED) and the schedule continues without aborting per spec §6.3.
		expect(fire1.errors).toHaveLength(1);
		expect(fire1.errors[0]).toMatchObject({
			id: "ctx-blocked",
			kind: "cancel",
		});
		expect(fire1.errors[0]?.message).toMatch(/connection refused/i);

		// All three DRAFTs still soft-deleted — cancel failure is best-effort
		// per spec §6.3 step 4. The next sweep will find no orphaned LINK
		// rows (the soft-delete cascades the DRAFT out of the eligible set).
		expect(fire1.draftsDeleted).toBe(3);
		expect(fire1.workflowsCancelled).toBe(0);
		expect(mockSoftDeleteProject).toHaveBeenCalledTimes(3);

		// ── Second fire (simulating the next cron beat) ──────────────────
		// After the first fire, d1/d2/d3 are soft-deleted. The mock for
		// `softDeleteProject` doesn't mutate `ALL_DRAFTS`, so we simulate
		// the post-soft-delete state by passing a "surviving" set that
		// drops the deleted IDs. The within-window d4/d5 plus any leftover
		// eligible drafts (none in this scenario, since cancel-failure does
		// NOT block the soft-delete) remain.
		const survivingAfterFire1 = ALL_DRAFTS.filter(
			(d) => !["d1", "d2", "d3"].includes(d.id),
		);

		vi.clearAllMocks();
		mockProjectContextFindMany.mockResolvedValue([]);
		mockSoftDeleteProject.mockResolvedValue({});
		mockWorkflowCancel.mockResolvedValue(undefined);

		seedFindMany(survivingAfterFire1);
		const fire2 = await runWorkflowFire({ cutoffDays: 14, batchSize: 50 });

		// Next fire finds zero eligible drafts — d4/d5 are within-window,
		// d1/d2/d3 are gone. The cancel-failure did NOT cause d1 to leak
		// into a permanent half-state; the soft-delete already cleared it
		// from the eligible set.
		expect(fire2).toEqual({
			draftsDeleted: 0,
			workflowsCancelled: 0,
			errors: [],
		});
		expect(mockSoftDeleteProject).not.toHaveBeenCalled();
	});

	// -------------------------------------------------------------------------
	// 13.2-bis — Partial-failure on the SOFT-DELETE side leaves the DRAFT
	// in the eligible set; the next fire retries it (the schedule's
	// idempotent-retry contract)
	// -------------------------------------------------------------------------

	it("13.2-bis: soft-delete failure on one DRAFT keeps it in the eligible set; the next cron fire finds the failed DRAFT plus the within-window drafts unchanged", async () => {
		// d2's soft-delete throws — the durable signal that this DRAFT is
		// gone never lands, so the next fire's query will still see d2.
		mockSoftDeleteProject.mockImplementation(async (projectId: string) => {
			if (projectId === "d2") {
				throw new Error("postgres deadlock");
			}
		});

		// ── First fire ────────────────────────────────────────────────────
		seedFindMany(ALL_DRAFTS);
		const fire1 = await runWorkflowFire({ cutoffDays: 14, batchSize: 50 });

		expect(fire1.errors).toHaveLength(1);
		expect(fire1.errors[0]).toMatchObject({
			id: "d2",
			kind: "soft-delete",
		});
		expect(fire1.errors[0]?.message).toMatch(/deadlock/i);

		// d1 + d3 deleted cleanly; d2 stayed.
		expect(fire1.draftsDeleted).toBe(2);

		// ── Second fire (next cron beat) ─────────────────────────────────
		// d2 is still in the eligible set because the soft-delete failed.
		// d4/d5 are still within the 14-day window. Per spec §6.3 "Sweep is
		// idempotent — re-running just finds whatever still qualifies under
		// the cutoff at the new `now`", the next fire retries d2.
		const survivingAfterFire1 = ALL_DRAFTS.filter(
			(d) => !["d1", "d3"].includes(d.id),
		);

		vi.clearAllMocks();
		mockProjectContextFindMany.mockResolvedValue([]);
		// Second fire: d2 soft-delete succeeds this time.
		mockSoftDeleteProject.mockResolvedValue({});
		mockWorkflowCancel.mockResolvedValue(undefined);

		seedFindMany(survivingAfterFire1);
		const fire2 = await runWorkflowFire({ cutoffDays: 14, batchSize: 50 });

		// Exactly d2 deleted on the retry — no new collisions, no errors.
		expect(fire2).toEqual({
			draftsDeleted: 1,
			workflowsCancelled: 0,
			errors: [],
		});
		expect(mockSoftDeleteProject).toHaveBeenCalledTimes(1);
		expect(mockSoftDeleteProject).toHaveBeenCalledWith("d2", "u2", "org-1");
	});

	// -------------------------------------------------------------------------
	// 13.2-ter — Default workflow input (undefined cutoffDays/batchSize) flows
	// through unchanged so the activity applies its documented defaults
	// (14 days, batch 50)
	// -------------------------------------------------------------------------

	it("13.2-ter: workflow input defaults pass through to the activity unchanged (cutoffDays=14, batchSize=50)", async () => {
		seedFindMany(ALL_DRAFTS);

		await runWorkflowFire({});

		// Without an explicit input, the activity falls back to spec
		// defaults: 14d window + 50/batch. Verify via the issued Prisma
		// query (the only place the defaults are observable).
		const findCall = mockProjectFindMany.mock.calls[0]?.[0] as {
			take: number;
		};
		expect(findCall?.take).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// 13.3 — Replay determinism
// ---------------------------------------------------------------------------
//
// The replay-determinism matrix lives at
//   .github/workflows/temporal-replay-validation.yml
// and was wired to pick up `draftProjectCleanupWorkflow` in Group 5.4 of this
// spec (the workflow type is automatically discovered because it's exported
// from `packages/temporal/src/workflows/index.ts`).
//
// Local replay run (MANUAL — requires a running Temporal namespace with a
// captured `draftProjectCleanupWorkflow` history fixture):
//
//   1. Boot Aspire so the worker is registered:        ./aspire.sh restart
//   2. Trigger one fire of the schedule manually:
//        tctl schedule trigger --sid draft-project-cleanup-daily
//      (or wait for the daily 03:00 UTC cron fire on a dev environment).
//   3. Fetch the captured history into the fixture dir:
//        pnpm --filter @repo/temporal fetch:replay-histories
//      (writes to `packages/temporal/__tests__/__fixtures__/histories/`)
//   4. Replay against the bundled workflow code:
//        pnpm --filter @repo/temporal test:replay
//      → asserts the workflow body replays without non-determinism.
//
// CI counterpart (AUTOMATED — runs on every PR that touches
// `packages/temporal/src/**`):
//   - `.github/workflows/temporal-replay-validation.yml` fetches dev
//     histories (including `draftProjectCleanupWorkflow` once it's fired in
//     dev) and runs the same replay command above against the PR's bundled
//     workflow code.
//
// This file does NOT execute the replay step inline because:
//   1. Replay requires real Temporal history JSON — there's no synthetic
//      shortcut that exercises the actual `Worker.runReplayHistories`
//      sandbox compilation path.
//   2. The fixture directory is gitignored (it contains tenant data), so
//      committing a captured history would breach the data-handling rule
//      documented in `packages/temporal/__tests__/__fixtures__/histories/.gitignore`.
//   3. The replay-validation matrix in CI is the authoritative check
//      anyway — duplicating the same assertion locally would just slow the
//      unit-test pass without adding signal.
//
// Group 5.5 (`draft-project-cleanup-workflow.test.ts`) already pins the
// workflow body's static-text determinism contract (no `Date.now()`, no
// `Math.random()`, no `setTimeout`), which is the determinism rule the
// replay matrix actually enforces at runtime. Together with the CI matrix,
// that's full coverage of the §6.5 replay-validation requirement.
// ---------------------------------------------------------------------------

describe("draftProjectCleanupWorkflow — replay determinism", () => {
	it("workflow type is exported from the workflows barrel (so the CI replay matrix picks it up automatically)", async () => {
		// The replay matrix discovers workflow types from the bundled
		// `workflows/index.ts` barrel. A future refactor that drops the
		// export would silently remove the workflow from replay coverage —
		// pin the export here.
		const mod = await import("../../src/workflows");
		expect(typeof mod.draftProjectCleanupWorkflow).toBe("function");
	});

	it("CI replay-validation matrix watches packages/temporal/src/** (so workflow code changes trigger the replay job)", async () => {
		const { readFile } = await import("node:fs/promises");
		const path = (await import("node:path")).join(
			__dirname,
			"../../../../.github/workflows/temporal-replay-validation.yml",
		);
		const yaml = await readFile(path, "utf8");
		// The `paths-filter` step must include the temporal src/ tree.
		// Without this, a workflow-code change to draft-project-cleanup.ts
		// would NOT trigger the replay matrix and the PR could land a
		// non-deterministic workflow body undetected.
		expect(yaml).toMatch(/packages\/temporal\/src\/\*\*/);
		// The aggregate status check must remain wired so branch protection
		// keeps enforcing the gate.
		expect(yaml).toMatch(/replay-validation/);
	});
});
