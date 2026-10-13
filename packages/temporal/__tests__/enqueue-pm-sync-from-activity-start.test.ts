/**
 * `enqueuePmSyncFromActivity` — the activity-side PM sync enqueue — settles a
 * workflow start that throws the way `@repo/api`'s enqueue does: whatever the
 * error, it describes the workflow id; FAILED (scoped to this attempt) only
 * when Temporal has no running workflow there, PENDING while one runs or
 * Temporal cannot say.
 *
 * Before, every throw stamped FAILED by item id, so a start that timed out
 * after Temporal accepted it showed FAILED while the sync ran, and a late
 * compensation could overwrite a newer attempt's PENDING.
 */

import {
	Client,
	ServiceError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { OpenTelemetryWorkflowClientInterceptor } from "@temporalio/interceptors-opentelemetry-v2";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	userStoryUpdate: vi.fn(),
	userStoryUpdateMany: vi.fn(),
	isProjectReadOnly: vi.fn(),
	resolveProjectPMConfigForUser: vi.fn(),
	workflowStart: vi.fn(),
	describe: vi.fn(),
	row: {} as Record<string, unknown>,
}));

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: h.projectFindUnique },
		userStory: {
			update: h.userStoryUpdate,
			updateMany: h.userStoryUpdateMany,
		},
	},
	isProjectReadOnly: h.isProjectReadOnly,
	PmSyncStatus: { PENDING: "PENDING", FAILED: "FAILED" },
}));

vi.mock("@repo/integrations/gitlab", () => ({
	GitLabPmOriginMismatchError: class extends Error {},
	resolveProjectPMConfigForUser: h.resolveProjectPMConfigForUser,
}));

const { enqueuePmSyncFromActivity } = await import(
	"../src/lib/enqueue-pm-sync-from-activity"
);

const temporalClient = {
	workflow: {
		start: h.workflowStart,
		getHandle: () => ({ describe: h.describe }),
	},
};

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
const WORKFLOW_ID = "pm-sync-story-story-example-1";

const enqueue = () =>
	enqueuePmSyncFromActivity({
		itemId: "story-example-1",
		itemType: "story",
		projectId: "project-example-1",
		userId: "user-example-1",
		organizationId: "org-example-1",
		temporalClient: temporalClient as never,
		triggerSource: "agent-create",
	});

beforeEach(() => {
	for (const mock of [
		h.projectFindUnique,
		h.userStoryUpdate,
		h.userStoryUpdateMany,
		h.isProjectReadOnly,
		h.resolveProjectPMConfigForUser,
		h.workflowStart,
		h.describe,
	]) {
		mock.mockReset();
	}
	h.projectFindUnique.mockResolvedValue({
		id: "project-example-1",
		organizationId: "org-example-1",
		projectManagementMcpServerId: "server-example-1",
		projectManagementMcpConfigId: "config-example-1",
		projectManagementContainerId: "container-example-1",
		projectManagementContainerName: "Example board",
		projectManagementAdditionalContext: null,
	});
	h.isProjectReadOnly.mockResolvedValue(false);
	h.resolveProjectPMConfigForUser.mockResolvedValue({
		id: "user-config-example-1",
		enabled: true,
	});
	// One simulated row; writes honour their `where` as Postgres would.
	h.row = { id: "story-example-1", lastPmSyncStatus: null };
	h.userStoryUpdate.mockImplementation(
		async (args: { data: Record<string, unknown> }) => {
			Object.assign(h.row, args.data);
			return { ...h.row };
		},
	);
	h.userStoryUpdateMany.mockImplementation(
		async (args: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const matches = Object.entries(args.where).every(
				([key, value]) => h.row[key] === value,
			);
			if (!matches) {
				return { count: 0 };
			}
			Object.assign(h.row, args.data);
			return { count: 1 };
		},
	);
});

describe("enqueuePmSyncFromActivity's workflow start", () => {
	it("uses the per-item workflow id and the attach/reuse policies of the API enqueue", async () => {
		h.workflowStart.mockResolvedValue({ workflowId: WORKFLOW_ID });
		const result = await enqueue();
		expect(result).toEqual({ enqueued: true, workflowId: WORKFLOW_ID });
		expect(h.workflowStart).toHaveBeenCalledWith(
			"pmSyncSingleStoryWorkflow",
			expect.objectContaining({
				workflowId: WORKFLOW_ID,
				workflowIdReusePolicy: "ALLOW_DUPLICATE",
				workflowIdConflictPolicy: "USE_EXISTING",
			}),
		);
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			pmSyncPendingSince: expect.any(Date),
		});
	});

	it("leaves the row PENDING when the start timed out but the workflow is running", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_DEADLINE_EXCEEDED),
		);
		h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

		const result = await enqueue();

		expect(result).toEqual({ enqueued: true, workflowId: WORKFLOW_ID });
		expect(h.userStoryUpdateMany).not.toHaveBeenCalled();
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
	});

	it("marks this attempt FAILED when the start timed out and Temporal has no such workflow", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_DEADLINE_EXCEEDED),
		);
		h.describe.mockRejectedValue(
			new WorkflowNotFoundError("not found", WORKFLOW_ID, undefined),
		);

		const result = await enqueue();

		expect(result).toEqual({ enqueued: false, reason: "temporal-error" });
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "FAILED",
			lastPmSyncError: expect.stringContaining("Temporal unreachable"),
		});
	});

	it("leaves the row PENDING with start-uncertain when the describe also fails", async () => {
		h.workflowStart.mockRejectedValue(
			startServiceError(GRPC_DEADLINE_EXCEEDED),
		);
		h.describe.mockRejectedValue(new Error("connection reset"));

		const result = await enqueue();

		expect(result).toEqual({
			enqueued: false,
			reason: "start-uncertain",
			workflowId: WORKFLOW_ID,
		});
		expect(h.userStoryUpdateMany).not.toHaveBeenCalled();
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
	});

	it.each([
		["INVALID_ARGUMENT", () => startServiceError(GRPC_INVALID_ARGUMENT)],
		// The SDK retries a start: an earlier attempt may have applied before
		// a retry was refused.
		["PERMISSION_DENIED", () => startServiceError(7)],
		["UNAUTHENTICATED", () => startServiceError(16)],
		// An interceptor can throw after the service accepted the start.
		["a plain Error", () => new Error("span exporter failed")],
	])(
		"describes before marking FAILED when the start threw %s",
		async (_name, error) => {
			h.workflowStart.mockRejectedValue(error());
			h.describe.mockResolvedValue({ status: { name: "RUNNING" } });

			const result = await enqueue();

			expect(h.describe).toHaveBeenCalledTimes(1);
			expect(result).toEqual({ enqueued: true, workflowId: WORKFLOW_ID });
			expect(h.row.lastPmSyncStatus).toBe("PENDING");
		},
	);

	it("keeps the row PENDING when the service accepted the start and the real OpenTelemetry client interceptor then threw", async () => {
		// A real `Client` with the OpenTelemetry interceptor the worker
		// registers (`buildWorkflowClientInterceptors`), over a fake gRPC
		// service that accepts the start. The tracer's span fails in `end()`,
		// which the interceptor calls after the start returned — so the
		// error escapes `workflow.start()` although the run exists.
		const startWorkflowExecution = vi.fn(async () => ({ runId: "run-1" }));
		const connection = {
			workflowService: { startWorkflowExecution },
			operatorService: {},
			plugins: [],
			close: async () => undefined,
			ensureConnected: async () => undefined,
			withDeadline: <R>(_deadline: unknown, fn: () => Promise<R>) => fn(),
			withMetadata: <R>(_metadata: unknown, fn: () => Promise<R>) => fn(),
			withAbortSignal: <R>(_signal: unknown, fn: () => Promise<R>) =>
				fn(),
		};
		const span = {
			setAttribute: () => span,
			setAttributes: () => span,
			setStatus: () => span,
			recordException: () => undefined,
			addEvent: () => span,
			isRecording: () => true,
			spanContext: () => ({
				traceId: "0".repeat(32),
				spanId: "0".repeat(16),
				traceFlags: 0,
			}),
			end: () => {
				throw new Error("span exporter has shut down");
			},
		};
		const tracer = {
			startActiveSpan: (
				_name: string,
				fn: (s: typeof span) => Promise<unknown>,
			) => fn(span),
			startSpan: () => span,
		};
		const client = new Client({
			connection: connection as never,
			namespace: "default",
			interceptors: {
				workflow: [
					new OpenTelemetryWorkflowClientInterceptor({
						tracer: tracer as never,
					}),
				],
			},
		});
		const describe = vi.fn(async () => ({ status: { name: "RUNNING" } }));
		client.workflow.getHandle = (() => ({ describe })) as never;

		const result = await enqueuePmSyncFromActivity({
			itemId: "story-example-1",
			itemType: "story",
			projectId: "project-example-1",
			userId: "user-example-1",
			organizationId: "org-example-1",
			temporalClient: client,
			triggerSource: "agent-create",
		});

		expect(startWorkflowExecution).toHaveBeenCalledTimes(1);
		expect(describe).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ enqueued: true, workflowId: WORKFLOW_ID });
		expect(h.row.lastPmSyncStatus).toBe("PENDING");
		expect(h.userStoryUpdateMany).not.toHaveBeenCalled();
	});

	it("leaves a newer attempt's PENDING alone when this attempt's compensation runs late", async () => {
		h.describe.mockRejectedValue(
			new WorkflowNotFoundError("not found", WORKFLOW_ID, undefined),
		);
		let newerAttemptId: unknown;
		h.workflowStart
			.mockImplementationOnce(async () => {
				// While this start is in flight a second enqueue stamps the
				// row and starts; then this start fails definitively.
				await enqueue();
				newerAttemptId = h.row.lastPmSyncAttemptId;
				throw startServiceError(GRPC_INVALID_ARGUMENT);
			})
			.mockResolvedValueOnce({ workflowId: WORKFLOW_ID });

		const result = await enqueue();

		expect(result).toEqual({ enqueued: false, reason: "temporal-error" });
		expect(h.userStoryUpdateMany).toHaveBeenCalledTimes(1);
		expect(h.row).toMatchObject({
			lastPmSyncStatus: "PENDING",
			lastPmSyncAttemptId: newerAttemptId,
		});
	});
});
