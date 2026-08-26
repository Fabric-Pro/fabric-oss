import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeProjectRow {
	organizationId: string | null;
	userId: string | null;
}

interface FakeCycleRow {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
}

// vi.mock factories are hoisted above all other top-level code, so the mocks'
// backing state/fns must be created via vi.hoisted (mirrors
// collect-stories.test.ts's pattern in this same directory).
const {
	seededProjectsRef,
	seededCyclesRef,
	projectFindUniqueMock,
	cycleFindUniqueMock,
	ensureJobMock,
	setJobStepMock,
} = vi.hoisted(() => {
	const seededProjectsRef: { current: Record<string, FakeProjectRow> } = {
		current: {},
	};
	const seededCyclesRef: { current: Record<string, FakeCycleRow> } = {
		current: {},
	};

	const projectFindUniqueMock = vi.fn((args: { where: { id: string } }) =>
		Promise.resolve(seededProjectsRef.current[args.where.id] ?? null),
	);
	const cycleFindUniqueMock = vi.fn((args: { where: { id: string } }) =>
		Promise.resolve(seededCyclesRef.current[args.where.id] ?? null),
	);

	return {
		seededProjectsRef,
		seededCyclesRef,
		projectFindUniqueMock,
		cycleFindUniqueMock,
		// Job Hub writers, spied at the `@repo/database` boundary so the REAL
		// `job-progress` runs on top of them. Replacing `job-progress`'s own
		// exports would test a fiction: each of them wraps its writer in
		// `safely()` and cannot reject, so a rejecting stand-in would describe a
		// state production never reaches.
		ensureJobMock: vi.fn(),
		setJobStepMock: vi.fn(),
	};
});

vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {
			project: { findUnique: projectFindUniqueMock },
			publishingSuggestionCycle: { findUnique: cycleFindUniqueMock },
		},
		ensureRunningBackgroundJob: ensureJobMock,
		setBackgroundJobStep: setJobStepMock,
	};
});

// REQUIRED, and load-bearing: `job-progress` resolves the workflow id through
// `Context.current()`, and outside an activity context that throws, is
// swallowed, and turns EVERY job write into a silent no-op. Without this mock
// the Job Hub assertions below would be asserting on nothing.
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "publishing-suggestion-cycle-1",
					runId: "run-1",
				},
			},
		}),
	},
	heartbeat: vi.fn(),
}));

import { assertProjectTenantTuple } from "../assert-tenant";

const PROJECT_ID = "proj-a";
const OTHER_PROJECT_ID = "proj-b";
const CYCLE_ID = "cycle-1";
const OWNER_USER_ID = "user-1";

beforeEach(() => {
	seededProjectsRef.current = {
		[PROJECT_ID]: { organizationId: null, userId: OWNER_USER_ID },
	};
	seededCyclesRef.current = {
		// Default: a personal cycle whose stored tuple matches the default input.
		[CYCLE_ID]: {
			projectId: PROJECT_ID,
			organizationId: null,
			userId: OWNER_USER_ID,
		},
	};
	projectFindUniqueMock.mockClear();
	cycleFindUniqueMock.mockClear();
	ensureJobMock.mockReset();
	setJobStepMock.mockReset();
});

describe("assertProjectTenantTuple", () => {
	it("resolves when the whole tuple matches (personal project, matching owner)", async () => {
		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).resolves.toBeUndefined();
	});

	it("throws PUBLISHING_TENANT_MISMATCH when tenantUserId does not match Project.userId", async () => {
		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: "someone-else",
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	// F5 cycle-ownership: the cycle looked up by cycleId belongs to a DIFFERENT
	// project than the one the caller claims, even though projectId itself
	// resolves to a perfectly valid, tuple-matching Project row. Never touch
	// another project's cycle.
	it("throws PUBLISHING_TENANT_MISMATCH when cycleId belongs to a different project (F5) despite a valid Project tuple", async () => {
		seededCyclesRef.current[CYCLE_ID] = {
			projectId: OTHER_PROJECT_ID,
			organizationId: null,
			userId: OWNER_USER_ID, // tuple matches input; ONLY projectId differs
		};

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	it("throws PUBLISHING_TENANT_MISMATCH when the Project row is missing (fail-closed on a missing row)", async () => {
		delete seededProjectsRef.current[PROJECT_ID];

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	it("throws PUBLISHING_TENANT_MISMATCH when the cycle row is missing (fail-closed on a missing row)", async () => {
		delete seededCyclesRef.current[CYCLE_ID];

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	it("resolves for an org project when organizationId matches and actorUserId is the canonical owner", async () => {
		seededProjectsRef.current[PROJECT_ID] = {
			organizationId: "org-1",
			userId: OWNER_USER_ID,
		};
		// The cycle's stored tuple is XOR-normalized org context (userId null).
		seededCyclesRef.current[CYCLE_ID] = {
			projectId: PROJECT_ID,
			organizationId: "org-1",
			userId: null,
		};

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: "org-1",
				tenantUserId: null,
				actorUserId: OWNER_USER_ID,
			}),
		).resolves.toBeUndefined();
	});

	// F2 cycle-tuple: the Project row + input are a consistent PERSONAL context,
	// and the cycle shares the projectId — but the cycle's OWN stored org differs
	// (it was stamped pre-transfer under org-stale). A projectId match alone must
	// NOT pass; the cycle's stored tuple must equal the input tuple. RED against
	// the pre-fix assertion, which only selected/checked cycle.projectId.
	it("throws PUBLISHING_TENANT_MISMATCH when the cycle's stored organizationId differs from the input (cross-tenant bleed)", async () => {
		seededProjectsRef.current[PROJECT_ID] = {
			organizationId: null,
			userId: OWNER_USER_ID,
		};
		seededCyclesRef.current[CYCLE_ID] = {
			projectId: PROJECT_ID,
			organizationId: "org-stale",
			userId: null,
		};

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	// F2 cycle-tuple (userId dimension): personal context, projectId + org match,
	// but the cycle's stored userId belongs to a different owner.
	it("throws PUBLISHING_TENANT_MISMATCH when the cycle's stored userId differs from the input tenantUserId", async () => {
		seededCyclesRef.current[CYCLE_ID] = {
			projectId: PROJECT_ID,
			organizationId: null,
			userId: "someone-else",
		};

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	it("throws PUBLISHING_TENANT_MISMATCH when organizationId does not match Project.organizationId", async () => {
		seededProjectsRef.current[PROJECT_ID] = {
			organizationId: "org-1",
			userId: OWNER_USER_ID,
		};

		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: "org-2",
				tenantUserId: null,
				actorUserId: OWNER_USER_ID,
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});

	it("throws PUBLISHING_TENANT_MISMATCH when actorUserId does not match Project.userId", async () => {
		await expect(
			assertProjectTenantTuple({
				cycleId: CYCLE_ID,
				projectId: PROJECT_ID,
				organizationId: null,
				tenantUserId: OWNER_USER_ID,
				actorUserId: "not-the-owner",
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });
	});
});

// ---------------------------------------------------------------------------
// Job Hub (Fizzy #1850)
// ---------------------------------------------------------------------------
const JOB_KEY = {
	workflowId: "publishing-suggestion-cycle-1",
	sourceId: null,
};

describe("assertProjectTenantTuple — Job Hub", () => {
	const VALID_INPUT = {
		cycleId: CYCLE_ID,
		projectId: PROJECT_ID,
		organizationId: null,
		tenantUserId: OWNER_USER_ID,
		actorUserId: OWNER_USER_ID,
	};

	it("ensures the row against THIS workflow's id, so a dispatch whose write was lost still reports, and reopens one the watchdog wrongly failed", async () => {
		await assertProjectTenantTuple(VALID_INPUT);

		expect(ensureJobMock).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "PUBLISHING_TOPIC_GENERATION",
				title: "Topic suggestions",
				projectId: PROJECT_ID,
				userId: OWNER_USER_ID,
				organizationId: null,
				// Resolved from the activity context, never passed in — this is what
				// lets the activity heal a row the dispatch never managed to write.
				workflowId: "publishing-suggestion-cycle-1",
				// The watchdog fails any row quiet for 45 minutes, and nothing in this
				// workflow bounds how long a started execution may sit in a saturated
				// task queue before its first activity runs. Without the reopen the row
				// stays falsely red for the rest of a live run.
				reopenFailedWithClass: "TimedOut",
			}),
		);
		expect(setJobStepMock).toHaveBeenCalledWith(
			JOB_KEY,
			"collect",
			"running",
			undefined,
		);
	});

	it("writes NOTHING when the tenant tuple is rejected — a job row carries a tenancy, and this check is what proves it", async () => {
		await expect(
			assertProjectTenantTuple({
				...VALID_INPUT,
				actorUserId: "someone-else",
			}),
		).rejects.toMatchObject({ type: "PUBLISHING_TENANT_MISMATCH" });

		expect(ensureJobMock).not.toHaveBeenCalled();
		expect(setJobStepMock).not.toHaveBeenCalled();
	});

	it("still asserts when the underlying job writer rejects — this exercises the real safely() wrapper rather than a stand-in for it", async () => {
		ensureJobMock.mockRejectedValueOnce(new Error("db down"));
		setJobStepMock.mockRejectedValueOnce(new Error("db down"));

		await expect(
			assertProjectTenantTuple(VALID_INPUT),
		).resolves.toBeUndefined();
	});
});
