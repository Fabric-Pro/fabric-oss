/**
 * The test-case branch of `retryPmSyncItem` (`retryTestCasePmSync`).
 *
 * One workflow id per case (`test-case-sync-<project>-<case>`), shared with
 * single-case Sync now and auto-sync, so no two of those run for one case at
 * once (a multi-case push has its own id; the create claim covers it). The
 * retry stamps PENDING with a fresh attempt id that only its own run
 * carries, so it must never leave that PENDING on a case whose running push
 * is another run's:
 *
 * - a push of the case already running is reported (`already-running`) and
 *   nothing is cleared, stamped or started;
 * - otherwise the stamp is a compare-and-set on the status it read, and the
 *   start uses the FAIL conflict policy: a run that started in between makes
 *   the start throw "already started", and the stamp is rolled back to
 *   exactly what it replaced;
 * - a start that throws otherwise is settled by describing the id: running
 *   keeps PENDING, no such workflow rolls the stamp back, and an unknown
 *   answer leaves it for the stuck-sync watchdog.
 *
 * Unlink & re-create (`unlinkFirst`) clears exactly the link (id, URL,
 * server) and create claim the caller read, or nothing (`pm-recovery-stale`).
 */

import {
	ServiceError,
	WorkflowExecutionAlreadyStartedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	testCaseFindFirst: vi.fn(),
	testCaseUpdateMany: vi.fn(),
	applyTestCasePmUnlink: vi.fn(),
	clearTestCasePmCreateClaim: vi.fn(),
	workflowStart: vi.fn(),
	describe: vi.fn(),
	getTemporalClient: vi.fn(),
	resolvePmTarget: vi.fn(),
	row: {} as Record<string, unknown>,
}));

vi.mock("@repo/database", () => ({
	applyPmUnlink: vi.fn(),
	clearPmCreateClaim: vi.fn(),
	applyTestCasePmUnlink: h.applyTestCasePmUnlink,
	clearTestCasePmCreateClaim: h.clearTestCasePmCreateClaim,
	db: {
		project: { findUnique: h.projectFindUnique },
		testCase: {
			findFirst: h.testCaseFindFirst,
			updateMany: h.testCaseUpdateMany,
		},
	},
	PmSyncStatus: { PENDING: "PENDING", FAILED: "FAILED" },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: h.getTemporalClient,
}));

vi.mock("../resolve-pm-target", () => ({
	resolvePmTarget: h.resolvePmTarget,
}));

// The story path is not under test here.
vi.mock("../enqueue-pm-sync", () => ({ enqueuePmSync: vi.fn() }));

const { retryPmSyncItem } = await import("../retry-pm-sync-item");

function grpcError(code: number) {
	return Object.assign(new Error(`${code} status`), {
		code,
		details: "status details",
		metadata: {},
	});
}

function startServiceError(code: number) {
	return new ServiceError("Failed to start Workflow", {
		cause: grpcError(code),
	});
}

const GRPC_INVALID_ARGUMENT = 3;
const GRPC_DEADLINE_EXCEEDED = 4;
const WORKFLOW_ID = "test-case-sync-project-1-case-1";

const notFound = () => new WorkflowNotFoundError("not found", "wf", undefined);
const alreadyStarted = () =>
	new WorkflowExecutionAlreadyStartedError(
		"Workflow execution already started",
		WORKFLOW_ID,
		"testCaseSyncWorkflow",
	);

const retry = (overrides: Record<string, unknown> = {}) =>
	retryPmSyncItem({
		itemId: "case-1",
		itemType: "testCase",
		projectId: "project-1",
		userId: "user-1",
		externalId: null,
		externalUrl: null,
		externalMcpServerId: null,
		pmCreateClaimId: null,
		...overrides,
	});

/** The status the case had before any retry touched it. */
const PREVIOUS = {
	lastPmSyncStatus: "FAILED",
	lastPmSyncError:
		"Fabric did not create this item in fizzy: ... use Unlink & re-create.",
	lastPmSyncAttemptAt: new Date("2026-10-01T10:00:00.000Z"),
	lastPmSyncAttemptId: "attempt-old",
	pmSyncPendingSince: null,
};

function matches(where: Record<string, unknown>): boolean {
	return Object.entries(where).every(([key, value]) => {
		const cell = h.row[key] ?? null;
		if (value instanceof Date) {
			return cell instanceof Date && cell.getTime() === value.getTime();
		}
		return cell === value;
	});
}

beforeEach(() => {
	for (const mock of [
		h.projectFindUnique,
		h.testCaseFindFirst,
		h.testCaseUpdateMany,
		h.applyTestCasePmUnlink,
		h.clearTestCasePmCreateClaim,
		h.workflowStart,
		h.describe,
		h.getTemporalClient,
		h.resolvePmTarget,
	]) {
		mock.mockReset();
	}
	h.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
		readOnlyMode: false,
		projectManagementMcpServerId: "server-1",
		projectManagementMcpConfigId: "config-1",
		projectManagementContainerId: "container-1",
		projectManagementContainerName: "Board",
		projectManagementAdditionalContext: null,
	});
	h.resolvePmTarget.mockResolvedValue({ kind: "mcp", mcpConfigId: "cfg-1" });
	h.getTemporalClient.mockResolvedValue({
		workflow: {
			start: h.workflowStart,
			getHandle: () => ({ describe: h.describe }),
		},
	});
	// No push of the case is running when the retry looks.
	h.describe.mockRejectedValue(notFound());
	h.applyTestCasePmUnlink.mockResolvedValue({ applied: true });
	h.clearTestCasePmCreateClaim.mockResolvedValue({ cleared: true });
	// One simulated test-case row; reads return its fields, writes honour
	// their `where`.
	h.row = { id: "case-1", projectId: "project-1", ...PREVIOUS };
	h.testCaseFindFirst.mockImplementation(
		async (args: {
			where: Record<string, unknown>;
			select: Record<string, boolean>;
		}) =>
			matches(args.where)
				? Object.fromEntries(
						Object.keys(args.select).map((k) => [
							k,
							h.row[k] ?? null,
						]),
					)
				: null,
	);
	h.testCaseUpdateMany.mockImplementation(
		async (args: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			if (!matches(args.where)) {
				return { count: 0 };
			}
			Object.assign(h.row, args.data);
			return { count: 1 };
		},
	);
});

describe("retryPmSyncItem for a test case", () => {
	it("stamps PENDING with a fresh attempt and starts the case's one workflow id with the FAIL conflict policy", async () => {
		h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });

		expect(await retry()).toEqual({
			enqueued: true,
			workflowId: WORKFLOW_ID,
		});
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			pmSyncPendingSince: expect.any(Date),
		});
		const [type, options] = h.workflowStart.mock.calls[0] as [
			string,
			{
				workflowId: string;
				workflowIdReusePolicy: string;
				workflowIdConflictPolicy: string;
				args: Array<Record<string, unknown>>;
			},
		];
		expect(type).toBe("testCaseSyncWorkflow");
		expect(options).toMatchObject({
			workflowId: WORKFLOW_ID,
			workflowIdReusePolicy: "ALLOW_DUPLICATE",
			workflowIdConflictPolicy: "FAIL",
		});
		expect(options.args[0]?.pmSyncAttemptId).toBe(
			h.row.lastPmSyncAttemptId,
		);
		expect(options.args[0]?.testCaseIds).toEqual(["case-1"]);
	});

	it("a push of the case already running: reported, and nothing is stamped or started", async () => {
		h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "already-running",
			workflowId: WORKFLOW_ID,
		});
		expect(h.workflowStart).not.toHaveBeenCalled();
		expect(h.row).toMatchObject(PREVIOUS);
	});

	it("a push that started after the check: the start is refused and the stamp rolled back to exactly what it replaced", async () => {
		h.workflowStart.mockRejectedValue(alreadyStarted());

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "already-running",
			workflowId: WORKFLOW_ID,
		});
		expect(h.row).toMatchObject(PREVIOUS);
	});

	it("the rollback never touches a newer attempt's PENDING", async () => {
		let newerAttemptId: unknown;
		h.workflowStart.mockImplementationOnce(async () => {
			// Another retry stamps over this one before this start answers.
			Object.assign(h.row, {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-newer",
			});
			newerAttemptId = h.row.lastPmSyncAttemptId;
			throw alreadyStarted();
		});

		await retry();

		expect(h.row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: newerAttemptId,
		});
	});

	it("the stamp is a compare-and-set: a status that changed after the read is read again, and the rollback restores that", async () => {
		h.testCaseFindFirst.mockImplementationOnce(async () => {
			const seen = { ...PREVIOUS };
			// A run settles the case between this read and the stamp.
			Object.assign(h.row, {
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
				lastPmSyncAttemptAt: new Date("2026-10-01T11:00:00.000Z"),
			});
			return seen;
		});
		h.workflowStart.mockRejectedValue(alreadyStarted());

		await retry();

		expect(h.testCaseFindFirst).toHaveBeenCalledTimes(2);
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "SUCCESS",
			lastPmSyncError: null,
			lastPmSyncAttemptId: "attempt-old",
		});
	});

	it("hands its attempt id to the run in the start's memo, so a settle can tell its own run", async () => {
		h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });

		await retry();

		const [, options] = h.workflowStart.mock.calls[0] as [
			string,
			{ memo?: Record<string, unknown> },
		];
		expect(options.memo).toEqual({
			pmSyncAttemptId: h.row.lastPmSyncAttemptId,
		});
	});

	it("keeps the case PENDING when the start timed out but the running run is this retry's (its memo names this attempt)", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_DEADLINE_EXCEEDED),
		);
		h.describe
			.mockRejectedValueOnce(notFound())
			.mockImplementationOnce(async () => ({
				status: { name: "RUNNING" },
				memo: { pmSyncAttemptId: h.row.lastPmSyncAttemptId },
			}));

		const result = await retry();

		expect(result).toMatchObject({ enqueued: true });
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
	});

	it.each([
		["a run with no attempt in its memo (Sync now, auto-sync)", {}],
		["a run for another attempt", { pmSyncAttemptId: "attempt-other" }],
	])(
		"a start that failed with a transport error while %s runs under the id: the stamp is rolled back and the run reported",
		async (_label, memo) => {
			h.workflowStart.mockRejectedValue(
				startServiceError(GRPC_DEADLINE_EXCEEDED),
			);
			h.describe
				.mockRejectedValueOnce(notFound())
				.mockResolvedValueOnce({ status: { name: "RUNNING" }, memo });

			expect(await retry()).toEqual({
				enqueued: false,
				reason: "already-running",
				workflowId: WORKFLOW_ID,
			});
			expect(h.row).toMatchObject(PREVIOUS);
		},
	);

	it("never stamps over another attempt's PENDING: reported, nothing stamped or started", async () => {
		Object.assign(h.row, {
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-other",
		});

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "already-running",
			workflowId: WORKFLOW_ID,
		});
		expect(h.testCaseUpdateMany).not.toHaveBeenCalled();
		expect(h.workflowStart).not.toHaveBeenCalled();
	});

	it("another attempt's PENDING that lands between the read and the stamp is read again and not stamped over", async () => {
		h.testCaseFindFirst.mockImplementationOnce(async () => {
			const seen = { ...PREVIOUS };
			Object.assign(h.row, {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-other",
			});
			return seen;
		});

		expect(await retry()).toMatchObject({ reason: "already-running" });
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: "attempt-other",
		});
		expect(h.workflowStart).not.toHaveBeenCalled();
	});

	it("two overlapping retries whose starts both fail: the case ends back at its previous state, never at a PENDING no run owns", async () => {
		let second: unknown;
		h.workflowStart.mockImplementationOnce(async () => {
			// Retry B runs while A's start is in flight. It passed the
			// running check too (nothing is running).
			second = await retry();
			throw startServiceError(GRPC_DEADLINE_EXCEEDED);
		});

		const first = await retry();

		expect(second).toMatchObject({ reason: "already-running" });
		expect(first).toEqual({ enqueued: false, reason: "temporal-error" });
		expect(h.workflowStart).toHaveBeenCalledTimes(1);
		expect(h.row).toMatchObject(PREVIOUS);
	});

	it("rolls the stamp back to the case's previous state when the start timed out and Temporal has no such workflow", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_DEADLINE_EXCEEDED),
		);

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "temporal-error",
		});
		// The previous message (here, the one offering Unlink & re-create)
		// is kept, not replaced by an enqueue error.
		expect(h.row).toMatchObject(PREVIOUS);
	});

	it("leaves the case PENDING with start-uncertain when the describe after the start also fails", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_INVALID_ARGUMENT),
		);
		h.describe
			.mockRejectedValueOnce(notFound())
			.mockRejectedValueOnce(new Error("still down"));

		expect(await retry()).toMatchObject({
			enqueued: false,
			reason: "start-uncertain",
			workflowId: WORKFLOW_ID,
		});
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
	});

	it("a client that cannot be acquired: nothing is stamped", async () => {
		h.getTemporalClient.mockRejectedValue(new Error("connect failed"));

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "temporal-error",
		});
		expect(h.testCaseUpdateMany).not.toHaveBeenCalled();
		expect(h.row).toMatchObject(PREVIOUS);
	});

	it("a case that is gone is reported, and nothing is started", async () => {
		h.row = { id: "other" };

		expect(await retry()).toEqual({
			enqueued: false,
			reason: "item-not-found",
		});
		expect(h.workflowStart).not.toHaveBeenCalled();
	});

	it("a plain retry never clears the link or the create claim", async () => {
		h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });

		await retry({ pmCreateClaimId: "claim-read", externalId: "88" });

		expect(h.applyTestCasePmUnlink).not.toHaveBeenCalled();
		expect(h.clearTestCasePmCreateClaim).not.toHaveBeenCalled();
	});

	describe("Unlink & re-create", () => {
		it("a linked case: unlinks exactly the link (id, URL, server) and claim read, then starts", async () => {
			h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });

			const result = await retry({
				unlinkFirst: true,
				externalId: "88",
				externalUrl: "https://pm.example.com/cards/88",
				externalMcpServerId: "server-old",
				pmCreateClaimId: null,
			});

			expect(result).toMatchObject({ enqueued: true });
			expect(h.applyTestCasePmUnlink).toHaveBeenCalledWith({
				projectId: "project-1",
				testCaseId: "case-1",
				expectedExternalId: "88",
				expectedExternalUrl: "https://pm.example.com/cards/88",
				expectedExternalMcpServerId: "server-old",
				expectedPmCreateClaimId: null,
			});
			expect(h.clearTestCasePmCreateClaim).not.toHaveBeenCalled();
		});

		const RECOVERABLE_AT = new Date("2026-10-13T12:05:00.000Z");

		it("an unlinked case holding a claim: clears that claim, then starts", async () => {
			h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });

			await retry({ unlinkFirst: true, pmCreateClaimId: "claim-read" });

			expect(h.clearTestCasePmCreateClaim).toHaveBeenCalledWith({
				projectId: "project-1",
				testCaseId: "case-1",
				claimId: "claim-read",
			});
			expect(h.workflowStart).toHaveBeenCalledTimes(1);
		});

		it.each([
			[
				"the link changed since it was read",
				{ externalId: "88", externalUrl: null },
				() =>
					h.applyTestCasePmUnlink.mockResolvedValue({
						applied: false,
					}),
			],
			[
				"another push took a new claim since it was read",
				{ pmCreateClaimId: "claim-read" },
				() =>
					h.clearTestCasePmCreateClaim.mockResolvedValue({
						cleared: false,
					}),
			],
		])(
			"%s: pm-recovery-stale, nothing stamped or started",
			async (_label, read, refuse) => {
				refuse();

				expect(await retry({ unlinkFirst: true, ...read })).toEqual({
					enqueued: false,
					reason: "pm-recovery-stale",
				});
				expect(h.testCaseUpdateMany).not.toHaveBeenCalled();
				expect(h.workflowStart).not.toHaveBeenCalled();
			},
		);

		it.each([
			[
				"a linked case",
				{
					externalId: "88",
					externalUrl: null,
					pmCreateClaimId: "claim-read",
				},
				() =>
					h.applyTestCasePmUnlink.mockResolvedValue({
						applied: false,
						claimTooRecent: { recoverableAt: RECOVERABLE_AT },
					}),
			],
			[
				"an unlinked case",
				{ pmCreateClaimId: "claim-read" },
				() =>
					h.clearTestCasePmCreateClaim.mockResolvedValue({
						cleared: false,
						claimTooRecent: { recoverableAt: RECOVERABLE_AT },
					}),
			],
		])(
			"%s whose claim is too recent to clear: pm-recovery-too-recent with the time, nothing stamped or started",
			async (_label, read, refuse) => {
				refuse();

				expect(await retry({ unlinkFirst: true, ...read })).toEqual({
					enqueued: false,
					reason: "pm-recovery-too-recent",
					recoverableAt: RECOVERABLE_AT,
				});
				expect(h.testCaseUpdateMany).not.toHaveBeenCalled();
				expect(h.workflowStart).not.toHaveBeenCalled();
			},
		);

		it("while a push of the case is running: nothing is cleared", async () => {
			h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

			expect(
				await retry({
					unlinkFirst: true,
					pmCreateClaimId: "claim-read",
				}),
			).toMatchObject({ enqueued: false, reason: "already-running" });
			expect(h.clearTestCasePmCreateClaim).not.toHaveBeenCalled();
			expect(h.applyTestCasePmUnlink).not.toHaveBeenCalled();
		});

		it("in a Read-only project: nothing is cleared", async () => {
			h.projectFindUnique.mockResolvedValue({
				id: "project-1",
				readOnlyMode: true,
			});

			expect(
				await retry({
					unlinkFirst: true,
					pmCreateClaimId: "claim-read",
				}),
			).toEqual({ enqueued: false, reason: "read-only-mode" });
			expect(h.clearTestCasePmCreateClaim).not.toHaveBeenCalled();
		});
	});
});
