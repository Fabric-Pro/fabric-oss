/**
 * Procedure-level tests for `scan.grouping.*` (spec
 * `2026-07-01-security-finding-tickets`, Task 4.6). These exercise each
 * handler's ORCHESTRATION (tenant gate, the DB calls it makes, the workflow
 * args it threads) with `@repo/database` and the temporal client mocked — no
 * Prisma / no worker. Pattern mirrors `scan-procedures.test.ts` (the
 * established convention for `scan.review.*`'s own procedure tests).
 *
 * Role enforcement (COMMENTER/VIEWER rejection on start/cancel, allowance on
 * latest) is verified by capturing the exact `Permissions.*` constant each
 * procedure declares to `requireProjectPermission` at module-load time (the
 * `orpc/procedures` chainable is stubbed so `.handler(fn)` hands back
 * `{ _handler: fn }`, same as `scan-procedures.test.ts`) and cross-checking it
 * against the REAL `PROJECT_ROLE_PERMISSIONS` role matrix from
 * `@repo/permissions` (unmocked) — not a hand-rolled fake. The DB-backed
 * enforcement mechanics of `requireProjectPermission` itself (org-role
 * fallback, ProjectMember overrides, RBAC_DRY_RUN, etc.) are already covered
 * by `packages/api/__tests__/require-project-permission.test.ts`; this file
 * only pins which permission each grouping procedure requires.
 */
import { ORPCError } from "@orpc/client";
import {
	hasPermission,
	Permissions,
	PROJECT_ROLE_PERMISSIONS,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- @repo/database mock (hoisted spies shared across the suite) -------------
const {
	mockHasProjectAccess,
	mockHasActiveScanFindingGrouping,
	mockCreateScanFindingGrouping,
	mockUpdateScanFindingGrouping,
	mockGetScanFindingGrouping,
	mockGetLatestScanFindingGrouping,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockHasActiveScanFindingGrouping: vi.fn(),
	mockCreateScanFindingGrouping: vi.fn(),
	mockUpdateScanFindingGrouping: vi.fn(),
	mockGetScanFindingGrouping: vi.fn(),
	mockGetLatestScanFindingGrouping: vi.fn(),
}));

// Spread the REAL @repo/database exports (so transitively-eager consumers
// find every symbol they expect at module-eval), then override the handful
// of query functions these procedures call + `db` so no Prisma connection is
// opened. Mirrors scan-procedures.test.ts.
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		...actual,
		db: {},
		hasProjectAccess: (...a: unknown[]) => mockHasProjectAccess(...a),
		hasActiveScanFindingGrouping: (...a: unknown[]) =>
			mockHasActiveScanFindingGrouping(...a),
		createScanFindingGrouping: (...a: unknown[]) =>
			mockCreateScanFindingGrouping(...a),
		updateScanFindingGrouping: (...a: unknown[]) =>
			mockUpdateScanFindingGrouping(...a),
		getScanFindingGrouping: (...a: unknown[]) =>
			mockGetScanFindingGrouping(...a),
		getLatestScanFindingGrouping: (...a: unknown[]) =>
			mockGetLatestScanFindingGrouping(...a),
	};
});

// --- temporal client mock (used by start-grouping + cancel-grouping;
// cancel-grouping reaches workflow.getHandle(id).terminate(...)).
const {
	mockWorkflowStart,
	mockTerminate,
	mockGetHandle,
	mockGetTemporalClient,
} = vi.hoisted(() => {
	const start = vi.fn();
	const terminate = vi.fn();
	const getHandle = vi.fn(() => ({ terminate }));
	return {
		mockWorkflowStart: start,
		mockTerminate: terminate,
		mockGetHandle: getHandle,
		mockGetTemporalClient: vi.fn(async () => ({
			workflow: { start, getHandle },
		})),
	};
});
vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => mockGetTemporalClient(...a),
}));

// Identity passthrough so the workflow start options are inspectable verbatim.
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

// --- procedures chainable: `.handler(fn)` -> `{ _handler: fn }` --------------
// Captures the exact permission constant each procedure declares, and hands
// through the REAL `Permissions` map (unmocked @repo/permissions) so the
// captured value is the genuine "project:update" / "project:read" string —
// not a stand-in — comparable against the real PROJECT_ROLE_PERMISSIONS
// matrix imported below.
//
// NOTE: the procedure files (one directory up, in `scan/`) import this as
// `../../../../orpc/procedures`; from THIS test file (in `scan/__tests__/`)
// the same absolute module is `../../../../../orpc/procedures` (one level
// deeper). vitest resolves mock specifiers relative to the file declaring
// them, so the specifier here MUST use the 5-level path to mock what the
// procedures import.
const { mockRequireProjectPermissionArg } = vi.hoisted(() => ({
	mockRequireProjectPermissionArg: vi.fn(),
}));
async function proceduresMockFactory() {
	const actual =
		await vi.importActual<typeof import("@repo/permissions")>(
			"@repo/permissions",
		);
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: actual.Permissions,
		requireProjectPermission: (permission: string) => {
			mockRequireProjectPermissionArg(permission);
			return (c: unknown) => c;
		},
	};
}
vi.mock("../../../../../orpc/procedures", proceduresMockFactory);
vi.mock("../../../../orpc/procedures", proceduresMockFactory);

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<unknown>;

const ctx = { user: { id: "user-1" } };

async function loadHandler(
	module: string,
	exportName: string,
): Promise<Handler> {
	const mod = (await import(module)) as Record<string, { _handler: Handler }>;
	return mod[exportName]._handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.resetModules();
	mockHasProjectAccess.mockResolvedValue(true);
	// Default so a test that doesn't care about the write (e.g. exercising the
	// dispatch-failure catch block's best-effort `.catch(() => {})`) doesn't
	// crash on `undefined.catch(...)` from an unconfigured vi.fn().
	mockUpdateScanFindingGrouping.mockResolvedValue(undefined);
});

// =============================================================================
// start-grouping — dedupe + dispatch
// =============================================================================
describe("startGroupingProcedure", () => {
	it("creates a grouping run, starts the workflow on fabric-worker, and stamps the workflowId", async () => {
		mockHasActiveScanFindingGrouping.mockResolvedValue(false);
		mockCreateScanFindingGrouping.mockResolvedValue({
			id: "grouping-1",
			status: "PENDING",
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "security-ticket-grouping-grouping-1",
		});

		const handler = await loadHandler(
			"../start-grouping",
			"startGroupingProcedure",
		);
		// Declares PROJECT_UPDATE (D17) at module-load time.
		expect(mockRequireProjectPermissionArg).toHaveBeenCalledWith(
			Permissions.PROJECT_UPDATE,
		);

		const result = await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(result).toEqual({ groupingId: "grouping-1", status: "PENDING" });
		const [wfName, opts] = mockWorkflowStart.mock.calls[0] as [
			string,
			{
				taskQueue: string;
				workflowId: string;
				args: Array<Record<string, unknown>>;
			},
		];
		expect(wfName).toBe("securityFindingGroupingWorkflow");
		expect(opts.taskQueue).toBe("fabric-worker");
		expect(opts.workflowId).toBe("security-ticket-grouping-grouping-1");
		expect(opts.args[0]).toMatchObject({
			groupingId: "grouping-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
		});
		expect(mockUpdateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			{
				workflowId: "security-ticket-grouping-grouping-1",
			},
		);
	});

	it("dedupes against an in-flight grouping run (CONFLICT, no new row, no dispatch)", async () => {
		mockHasActiveScanFindingGrouping.mockResolvedValue(true);
		const handler = await loadHandler(
			"../start-grouping",
			"startGroupingProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-1" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockCreateScanFindingGrouping).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("does NOT gate on agentTicketGenerationEnabled — always creates + dispatches", async () => {
		// No call to getProjectScanConfig / the config field anywhere in this
		// procedure — the workflow itself takes the D14 fallback path. Assert the
		// happy path succeeds with zero reference to a config lookup.
		mockHasActiveScanFindingGrouping.mockResolvedValue(false);
		mockCreateScanFindingGrouping.mockResolvedValue({
			id: "grouping-2",
			status: "PENDING",
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "security-ticket-grouping-grouping-2",
		});
		const handler = await loadHandler(
			"../start-grouping",
			"startGroupingProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});
		expect(result).toEqual({ groupingId: "grouping-2", status: "PENDING" });
		expect(mockCreateScanFindingGrouping).toHaveBeenCalledTimes(1);
	});

	it("marks the row FAILED and throws INTERNAL_SERVER_ERROR when workflow dispatch fails", async () => {
		mockHasActiveScanFindingGrouping.mockResolvedValue(false);
		mockCreateScanFindingGrouping.mockResolvedValue({
			id: "grouping-3",
			status: "PENDING",
		});
		mockWorkflowStart.mockRejectedValue(new Error("worker unreachable"));

		const handler = await loadHandler(
			"../start-grouping",
			"startGroupingProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-1", organizationId: null },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockUpdateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-3",
			{
				status: "FAILED",
				error: "worker unreachable",
			},
		);
	});

	it("throws FORBIDDEN and creates nothing when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler(
			"../start-grouping",
			"startGroupingProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-x" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockCreateScanFindingGrouping).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});
});

// =============================================================================
// get-grouping — latest run + typed results
// =============================================================================
describe("getGroupingProcedure", () => {
	it("returns the latest grouping run with typed results", async () => {
		const results = {
			createdThemes: [
				{
					category: "SECURITY",
					ruleSource: "gitleaks",
					themeKey: "theme-security-gitleaks-abcd1234",
					findingCount: 3,
					storyId: "story-1",
					storyIdentifier: "F-101",
				},
			],
			updatedThemes: [],
			skippedThemes: [],
			failedThemes: [],
		};
		mockGetLatestScanFindingGrouping.mockResolvedValue({
			id: "grouping-1",
			projectId: "proj-1",
			status: "COMPLETED",
			results,
		});

		const handler = await loadHandler(
			"../get-grouping",
			"getGroupingProcedure",
		);
		expect(mockRequireProjectPermissionArg).toHaveBeenCalledWith(
			Permissions.PROJECT_READ,
		);

		const result = await handler({
			input: { projectId: "proj-1", organizationId: null },
			context: ctx,
		});

		expect(result).toEqual({
			grouping: {
				id: "grouping-1",
				projectId: "proj-1",
				status: "COMPLETED",
				results,
			},
		});
	});

	it("returns { grouping: null } when the project has never run grouping", async () => {
		mockGetLatestScanFindingGrouping.mockResolvedValue(null);
		const handler = await loadHandler(
			"../get-grouping",
			"getGroupingProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1" },
			context: ctx,
		});
		expect(result).toEqual({ grouping: null });
	});

	it("preserves null results (run not completed yet) rather than defaulting to an empty object", async () => {
		mockGetLatestScanFindingGrouping.mockResolvedValue({
			id: "grouping-2",
			projectId: "proj-1",
			status: "RUNNING",
			results: null,
		});
		const handler = await loadHandler(
			"../get-grouping",
			"getGroupingProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1" },
			context: ctx,
		});
		expect(result).toEqual({
			grouping: {
				id: "grouping-2",
				projectId: "proj-1",
				status: "RUNNING",
				results: null,
			},
		});
	});

	it("throws FORBIDDEN when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler(
			"../get-grouping",
			"getGroupingProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-x" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});
});

// =============================================================================
// cancel-grouping — terminate the running run + procedure-owned terminal state
// =============================================================================
describe("cancelGroupingProcedure", () => {
	it("terminates the workflow, marks the grouping row FAILED, and returns cancelled:true", async () => {
		mockGetScanFindingGrouping.mockResolvedValue({
			id: "grouping-1",
			projectId: "proj-1",
			status: "RUNNING",
			workflowId: "security-ticket-grouping-grouping-1",
		});
		mockUpdateScanFindingGrouping.mockResolvedValue(undefined);

		const handler = await loadHandler(
			"../cancel-grouping",
			"cancelGroupingProcedure",
		);
		expect(mockRequireProjectPermissionArg).toHaveBeenCalledWith(
			Permissions.PROJECT_UPDATE,
		);

		const result = await handler({
			input: {
				projectId: "proj-1",
				organizationId: null,
				groupingId: "grouping-1",
			},
			context: ctx,
		});

		expect(result).toEqual({ cancelled: true });
		// Best-effort terminate of the in-flight grouping workflow.
		expect(mockGetHandle).toHaveBeenCalledWith(
			"security-ticket-grouping-grouping-1",
		);
		expect(mockTerminate).toHaveBeenCalledWith("Cancelled by user");
		// Procedure owns the final state: FAILED + Cancelled + completedAt set.
		expect(mockUpdateScanFindingGrouping).toHaveBeenCalledWith(
			"grouping-1",
			{
				status: "FAILED",
				error: "Cancelled by user",
				completedAt: expect.any(Date),
			},
		);
		// Cancellation performs no rollback of tickets already created.
	});

	it("returns cancelled:false for an already-COMPLETED grouping run (no terminate, no state write)", async () => {
		mockGetScanFindingGrouping.mockResolvedValue({
			id: "grouping-1",
			projectId: "proj-1",
			status: "COMPLETED",
			workflowId: "security-ticket-grouping-grouping-1",
		});

		const handler = await loadHandler(
			"../cancel-grouping",
			"cancelGroupingProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", groupingId: "grouping-1" },
			context: ctx,
		});

		expect(result).toEqual({ cancelled: false });
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockUpdateScanFindingGrouping).not.toHaveBeenCalled();
	});

	it("returns cancelled:false for an already-FAILED grouping run (no terminate, no state write)", async () => {
		mockGetScanFindingGrouping.mockResolvedValue({
			id: "grouping-1",
			projectId: "proj-1",
			status: "FAILED",
			workflowId: "security-ticket-grouping-grouping-1",
		});

		const handler = await loadHandler(
			"../cancel-grouping",
			"cancelGroupingProcedure",
		);
		const result = await handler({
			input: { projectId: "proj-1", groupingId: "grouping-1" },
			context: ctx,
		});

		expect(result).toEqual({ cancelled: false });
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockUpdateScanFindingGrouping).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the grouping run does not belong to the project (no terminate)", async () => {
		mockGetScanFindingGrouping.mockResolvedValue(null);

		const handler = await loadHandler(
			"../cancel-grouping",
			"cancelGroupingProcedure",
		);
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					groupingId: "grouping-other",
				},
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockGetHandle).not.toHaveBeenCalled();
		expect(mockTerminate).not.toHaveBeenCalled();
		expect(mockUpdateScanFindingGrouping).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const handler = await loadHandler(
			"../cancel-grouping",
			"cancelGroupingProcedure",
		);
		await expect(
			handler({
				input: { projectId: "proj-x", groupingId: "grouping-1" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mockGetScanFindingGrouping).not.toHaveBeenCalled();
	});
});

// =============================================================================
// Role enforcement matrix — cross-checks the declared permission against the
// REAL PROJECT_ROLE_PERMISSIONS matrix (@repo/permissions, unmocked). Proves
// COMMENTER/VIEWER are rejected FORBIDDEN on start/cancel and allowed on
// latest, without re-testing requireProjectPermission's own DB-backed
// mechanics (covered by require-project-permission.test.ts).
// =============================================================================
describe("scan.grouping.* — role enforcement matrix (COMMENTER/VIEWER)", () => {
	it("start requires PROJECT_UPDATE, which COMMENTER and VIEWER both lack", async () => {
		await loadHandler("../start-grouping", "startGroupingProcedure");
		const permission = mockRequireProjectPermissionArg.mock.calls[0]?.[0];
		expect(permission).toBe(Permissions.PROJECT_UPDATE);
		expect(
			hasPermission(PROJECT_ROLE_PERMISSIONS.COMMENTER, permission),
		).toBe(false);
		expect(hasPermission(PROJECT_ROLE_PERMISSIONS.VIEWER, permission)).toBe(
			false,
		);
	});

	it("cancel requires PROJECT_UPDATE, which COMMENTER and VIEWER both lack", async () => {
		await loadHandler("../cancel-grouping", "cancelGroupingProcedure");
		const permission = mockRequireProjectPermissionArg.mock.calls[0]?.[0];
		expect(permission).toBe(Permissions.PROJECT_UPDATE);
		expect(
			hasPermission(PROJECT_ROLE_PERMISSIONS.COMMENTER, permission),
		).toBe(false);
		expect(hasPermission(PROJECT_ROLE_PERMISSIONS.VIEWER, permission)).toBe(
			false,
		);
	});

	it("latest requires only PROJECT_READ, which COMMENTER and VIEWER both have", async () => {
		await loadHandler("../get-grouping", "getGroupingProcedure");
		const permission = mockRequireProjectPermissionArg.mock.calls[0]?.[0];
		expect(permission).toBe(Permissions.PROJECT_READ);
		expect(
			hasPermission(PROJECT_ROLE_PERMISSIONS.COMMENTER, permission),
		).toBe(true);
		expect(hasPermission(PROJECT_ROLE_PERMISSIONS.VIEWER, permission)).toBe(
			true,
		);
	});
});
