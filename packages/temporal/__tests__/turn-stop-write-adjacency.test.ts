/**
 * A chat turn's stop is checked immediately before every write a tool's
 * helper makes, with no `await` between the check and the write.
 *
 * Each helper runs for real, inside the turn's dispatch guard
 * (`runWithTurnDispatch`, as the activity interceptor installs it) in an
 * activity context. Only its stores and the Temporal client are faked. The
 * activity is cancelled while the helper is still preparing (a database
 * read, a credential lookup, the Temporal availability probe), after the
 * call site's own check has passed. Before, each helper checked nothing of
 * its own, so the write or workflow start went out after the cancellation
 * and the stop surfaced only when the activity returned.
 */

import { CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	/** Runs inside the named preparation await; the test cancels there. */
	during: {} as Record<string, (() => void) | undefined>,
	projectFindUnique: vi.fn(),
	userStoryUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	/** The story row's PM-sync stamp, as the simulated database holds it. */
	row: {
		lastPmSyncStatus: null as unknown,
		lastPmSyncAttemptAt: null as unknown,
	},
	isProjectReadOnly: vi.fn(),
	resolveProjectPMConfigForUser: vi.fn(),
	triggersFindMany: vi.fn(),
	isTemporalAvailable: vi.fn(),
	workflowStart: vi.fn(),
	describe: vi.fn(),
}));

/** Resolves `value` after running the hook registered for `name`. */
async function preparing<T>(name: string, value: T): Promise<T> {
	await Promise.resolve();
	h.during[name]?.();
	return value;
}

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	// The turn guard (no ledger: the scope carries no budget contract).
	checkConversationTurnDispatchable: vi.fn(async () => ({ ok: true })),
	reserveConversationTurnAttempt: vi.fn(),
	settleConversationTurnAttempt: vi.fn(),
	getConversationTurnLedgerSnapshot: vi.fn(async () => null),
	// The helpers' stores.
	db: {
		project: { findUnique: h.projectFindUnique },
		userStory: {
			update: h.userStoryUpdate,
			updateMany: h.userStoryUpdateMany,
		},
		agentDeploymentTrigger: { findMany: h.triggersFindMany },
	},
	isProjectReadOnly: h.isProjectReadOnly,
	PmSyncStatus: { PENDING: "PENDING", FAILED: "FAILED" },
}));

vi.mock("@repo/integrations/gitlab", () => ({
	GitLabPmOriginMismatchError: class extends Error {},
	resolveProjectPMConfigForUser: h.resolveProjectPMConfigForUser,
}));

const temporalClient = {
	workflow: {
		start: h.workflowStart,
		getHandle: () => ({ describe: h.describe }),
	},
};

vi.mock("../src/client", () => ({
	getTemporalClient: vi.fn(async () => temporalClient),
	isTemporalAvailable: h.isTemporalAvailable,
}));

const { enqueuePmSyncFromActivity } = await import(
	"../src/lib/enqueue-pm-sync-from-activity"
);
const { dispatchLifecycleEvent } = await import(
	"../src/lib/lifecycle-dispatcher"
);
const { triggerDuplicateDetection } = await import(
	"../src/lib/trigger-duplicate-detection"
);
const { runWithTurnDispatch } = await import(
	"../src/activities/orchestrator/turn-dispatch"
);

const SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-00000000-0000-4000-8000-000000000001",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const PM_PROJECT = {
	id: "project-example-1",
	organizationId: "org-example-1",
	projectManagementMcpServerId: "server-example-1",
	projectManagementMcpConfigId: "config-example-1",
	projectManagementContainerId: "container-example-1",
	projectManagementContainerName: "Example board",
	projectManagementAdditionalContext: null,
};

/**
 * Runs `work` as a turn's activity runs it, cancelling the activity when
 * the helper reaches the preparation await named `cancelDuring`. Resolves
 * to the value or to the error the activity ended with.
 */
async function inTurn(
	cancelDuring: string | undefined,
	work: () => Promise<unknown>,
): Promise<unknown> {
	const env = new MockActivityEnvironment();
	if (cancelDuring) {
		h.during[cancelDuring] = () => env.cancel();
	}
	return env
		.run(() => runWithTurnDispatch(SCOPE, work))
		.then(
			(value) => ({ resolvedWith: value }),
			(error: unknown) => error,
		);
}

beforeEach(() => {
	h.during = {};
	for (const mock of [
		h.projectFindUnique,
		h.userStoryUpdate,
		h.userStoryUpdateMany,
		h.isProjectReadOnly,
		h.resolveProjectPMConfigForUser,
		h.triggersFindMany,
		h.isTemporalAvailable,
		h.workflowStart,
	]) {
		mock.mockReset();
	}
	h.projectFindUnique.mockImplementation(() =>
		preparing("project read", PM_PROJECT),
	);
	h.isProjectReadOnly.mockImplementation(() =>
		preparing("read-only check", false),
	);
	h.resolveProjectPMConfigForUser.mockImplementation(() =>
		preparing("credential lookup", {
			id: "user-config-example-1",
			enabled: true,
		}),
	);
	h.row = { lastPmSyncStatus: null, lastPmSyncAttemptAt: null };
	h.userStoryUpdate.mockImplementation(
		(args: { data: Record<string, unknown> }) => {
			Object.assign(h.row, args.data);
			return preparing("pending stamp", {});
		},
	);
	// The failed start's FAILED write is scoped to the attempt: it applies
	// only while the row still matches its `where`, as Postgres would.
	h.userStoryUpdateMany.mockImplementation(
		async (args: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const row = h.row as Record<string, unknown>;
			const { id: _id, ...fields } = args.where;
			const matches = Object.entries(fields).every(
				([key, value]) => row[key] === value,
			);
			if (!matches) {
				return { count: 0 };
			}
			Object.assign(row, args.data);
			return { count: 1 };
		},
	);
	h.triggersFindMany.mockImplementation(() =>
		preparing("trigger lookup", [
			{
				id: "trigger-example-1",
				config: { resource: "story", event: "created" },
			},
		]),
	);
	h.isTemporalAvailable.mockImplementation(() =>
		preparing("availability probe", true),
	);
	h.workflowStart.mockResolvedValue({ workflowId: "wf-example-1" });
	// A failed start is reconciled by describing its workflow id; here
	// Temporal has never heard of it, so the attempt is marked FAILED.
	h.describe.mockReset().mockRejectedValue(
		Object.assign(new Error("workflow not found"), {
			name: "WorkflowNotFoundError",
		}),
	);
});

const enqueue = () =>
	enqueuePmSyncFromActivity({
		itemId: "story-example-1",
		itemType: "story",
		projectId: PM_PROJECT.id,
		userId: SCOPE.userId,
		organizationId: SCOPE.organizationId,
		temporalClient: temporalClient as never,
		triggerSource: "agent-create",
	});

/** The `lastPmSyncStatus` each story write asked for, in call order. */
function pmStatusWrites(): unknown[] {
	const writes = [h.userStoryUpdate, h.userStoryUpdateMany].flatMap((mock) =>
		mock.mock.calls.map((call, index) => ({
			order: mock.mock.invocationCallOrder[index] ?? 0,
			status: (call[0] as { data: { lastPmSyncStatus?: unknown } }).data
				.lastPmSyncStatus,
		})),
	);
	return writes
		.sort((a, b) => a.order - b.order)
		.map((write) => write.status);
}

describe("the initial PM sync (enqueuePmSyncFromActivity) inside a chat turn", () => {
	it("stamps PENDING and starts the sync when nothing stops the turn", async () => {
		const outcome = await inTurn(undefined, enqueue);
		expect(outcome).toMatchObject({ resolvedWith: { enqueued: true } });
		expect(pmStatusWrites()).toEqual(["PENDING"]);
		expect(h.workflowStart).toHaveBeenCalledTimes(1);
	});

	it.each(["project read", "read-only check", "credential lookup"])(
		"writes nothing and starts nothing when the activity is cancelled during the %s",
		async (step) => {
			const outcome = await inTurn(step, enqueue);
			expect(outcome).toBeInstanceOf(CancelledFailure);
			expect(h.userStoryUpdate).not.toHaveBeenCalled();
			expect(h.workflowStart).not.toHaveBeenCalled();
		},
	);

	it("still starts the sync when the turn stops after PENDING is stamped: the stamp and the start are one operation", async () => {
		const outcome = await inTurn("pending stamp", enqueue);
		// The start is issued, and nothing undoes or overwrites the stamp:
		// once PENDING is written the sync proceeds, and the workflow it
		// starts settles the stamp as it does outside a turn.
		expect(h.workflowStart).toHaveBeenCalledTimes(1);
		expect(pmStatusWrites()).toEqual(["PENDING"]);
		expect(h.userStoryUpdateMany).not.toHaveBeenCalled();
		// The turn still ends with its stop once the activity returns.
		expect(outcome).toBeInstanceOf(CancelledFailure);
	});
});

describe("the initial PM sync's failed start (enqueuePmSyncFromActivity)", () => {
	// The same handling inside and outside a turn: the failed start is
	// described, Temporal has no such workflow, so the stamp is set FAILED
	// with the Temporal error and the result is `temporal-error`.
	it.each([
		["outside a chat turn", () => enqueue()],
		["inside a chat turn", () => inTurn(undefined, enqueue)],
	])(
		"stamps FAILED and reports temporal-error when the workflow start throws %s",
		async (_where, run) => {
			h.workflowStart.mockRejectedValueOnce(
				new Error("connection refused"),
			);
			const outcome = await run();
			const result =
				outcome &&
				typeof outcome === "object" &&
				"resolvedWith" in outcome
					? outcome.resolvedWith
					: outcome;
			expect(result).toEqual({
				enqueued: false,
				reason: "temporal-error",
			});
			expect(pmStatusWrites()).toEqual(["PENDING", "FAILED"]);
			expect(h.row).toMatchObject({
				lastPmSyncStatus: "FAILED",
				lastPmSyncError:
					"Failed to enqueue PM sync (Temporal unreachable): connection refused",
			});
		},
	);

	it("still reports temporal-error when stamping FAILED also fails", async () => {
		h.workflowStart.mockRejectedValueOnce(new Error("connection refused"));
		h.userStoryUpdateMany.mockRejectedValueOnce(
			new Error("database unavailable"),
		);
		const outcome = await enqueue();
		expect(outcome).toEqual({ enqueued: false, reason: "temporal-error" });
	});
});

describe("the lifecycle event (dispatchLifecycleEvent) inside a chat turn", () => {
	const dispatch = () =>
		dispatchLifecycleEvent({
			resource: "story",
			event: "created",
			projectId: PM_PROJECT.id,
			entityId: "story-example-1",
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
		});

	it("starts the matching trigger's workflow when nothing stops the turn", async () => {
		const outcome = await inTurn(undefined, dispatch);
		expect(outcome).toMatchObject({
			resolvedWith: { matched: 1, started: 1 },
		});
		expect(h.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("starts no workflow when the activity is cancelled during the trigger lookup", async () => {
		const outcome = await inTurn("trigger lookup", dispatch);
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.workflowStart).not.toHaveBeenCalled();
	});
});

describe("duplicate detection (triggerDuplicateDetection) inside a chat turn", () => {
	const trigger = () =>
		triggerDuplicateDetection({
			projectId: PM_PROJECT.id,
			userId: SCOPE.userId,
			organizationId: SCOPE.organizationId,
			targetStoryIds: ["story-example-1"],
		});

	it("starts the detection workflow when nothing stops the turn", async () => {
		const outcome = await inTurn(undefined, trigger);
		expect(outcome).toMatchObject({
			resolvedWith: { workflowId: "wf-example-1" },
		});
		expect(h.workflowStart).toHaveBeenCalledTimes(1);
	});

	it("starts no workflow when the activity is cancelled during the availability probe, and does not swallow the stop", async () => {
		const outcome = await inTurn("availability probe", trigger);
		expect(outcome).toBeInstanceOf(CancelledFailure);
		expect(h.workflowStart).not.toHaveBeenCalled();
	});
});
