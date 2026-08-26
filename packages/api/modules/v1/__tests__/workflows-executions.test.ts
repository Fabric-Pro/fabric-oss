/**
 * v1 workflow executions — Phase 8b integration tests
 *
 * Covers:
 *   GET  /workflows/:id/executions
 *   POST /workflows/:id/executions/:execId/cancel
 *
 * Verifies tenant scoping, status filter validation, the 409 path for
 * already-terminal executions, and that the cancel route always
 * updates the DB row (Temporal call is best-effort and may be a noop
 * when isTemporalAvailable returns false).
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetWorkflowById = vi.fn();
const mockGetWorkflowExecutionById = vi.fn();
const mockListWorkflowExecutions = vi.fn();
const mockUpdateWorkflowExecution = vi.fn();
const mockCreateWorkflowExecution = vi.fn();
const mockListWorkflows = vi.fn();
const mockIsTemporalAvailable = vi.fn();
const mockTemporalCancel = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/database", () => ({
	getWorkflowById: (...args: unknown[]) => mockGetWorkflowById(...args),
	getWorkflowExecutionById: (...args: unknown[]) =>
		mockGetWorkflowExecutionById(...args),
	listWorkflowExecutions: (...args: unknown[]) =>
		mockListWorkflowExecutions(...args),
	updateWorkflowExecution: (...args: unknown[]) =>
		mockUpdateWorkflowExecution(...args),
	createWorkflowExecution: (...args: unknown[]) =>
		mockCreateWorkflowExecution(...args),
	listWorkflows: (...args: unknown[]) => mockListWorkflows(...args),
	db: {
		organization: { findFirst: vi.fn() },
		member: { findFirst: vi.fn() },
	},
}));

vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: (...args: unknown[]) =>
		mockIsTemporalAvailable(...args),
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

vi.mock("../../external-api/middleware/api-key-auth", () => ({
	requireScope: () => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

import { registerWorkflowRoutes } from "../workflows";

function makeApp() {
	const app = new Hono<{
		Variables: {
			externalApiContext: {
				keyType: "personal" | "organization";
				keyId: string;
				keyPrefix: string;
				userId: string;
				organizationId: string | undefined;
				scopes: string[];
			};
		};
	}>();
	app.use("*", async (c, next) => {
		c.set("externalApiContext", {
			keyType: "personal",
			keyId: "key-1",
			keyPrefix: "fab_test",
			userId: "user-1",
			organizationId: undefined,
			scopes: ["workflows:read", "workflows:run"],
		});
		await next();
	});
	registerWorkflowRoutes(app as never);
	return app;
}

function execRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		organizationId: null,
		status: "RUNNING" as const,
		triggerType: "MANUAL" as const,
		startedAt: new Date("2026-05-11T00:00:00.000Z"),
		completedAt: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetWorkflowById.mockResolvedValue({
		id: "wf-1",
		name: "wf",
		version: 1,
		status: "ACTIVE",
	});
	mockIsTemporalAvailable.mockResolvedValue(false);
});

describe("GET /workflows/:id/executions", () => {
	it("returns 404 when workflow not found for tenant", async () => {
		mockGetWorkflowById.mockResolvedValue(null);
		const res = await makeApp().request("/workflows/wf-x/executions");
		expect(res.status).toBe(404);
		expect(mockListWorkflowExecutions).not.toHaveBeenCalled();
	});

	it("lists with status + pagination forwarded", async () => {
		mockListWorkflowExecutions.mockResolvedValue({
			executions: [execRow(), execRow({ id: "exec-2" })],
			total: 2,
			hasMore: false,
		});
		const res = await makeApp().request(
			"/workflows/wf-1/executions?status=RUNNING&limit=50&offset=10",
		);
		expect(res.status).toBe(200);
		expect(mockListWorkflowExecutions).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: "user-1",
				status: "RUNNING",
				limit: 50,
				offset: 10,
			}),
		);
		const body = (await res.json()) as {
			data: unknown[];
			meta: { total: number };
		};
		expect(body.data).toHaveLength(2);
		expect(body.meta.total).toBe(2);
	});

	it("400 on invalid status filter", async () => {
		const res = await makeApp().request(
			"/workflows/wf-1/executions?status=NOTASTATUS",
		);
		expect(res.status).toBe(400);
		expect(mockListWorkflowExecutions).not.toHaveBeenCalled();
	});
});

describe("POST /workflows/:id/executions/:execId/cancel", () => {
	it("404 when workflow not found", async () => {
		mockGetWorkflowById.mockResolvedValue(null);
		const res = await makeApp().request(
			"/workflows/wf-x/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("404 when execution belongs to a different workflow", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(
			execRow({ workflowId: "wf-other" }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("409 when execution is already in terminal state", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(
			execRow({ status: "COMPLETED" }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code?: string } };
		expect(body.error.code).toBe("EXECUTION_TERMINAL");
		expect(mockUpdateWorkflowExecution).not.toHaveBeenCalled();
	});

	it("happy path (Temporal unavailable): updates DB row to CANCELLED", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(false);
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED", completedAt: new Date() }),
		);
		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { status: string };
		};
		expect(body.data.status).toBe("CANCELLED");
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
		expect(mockGetTemporalClient).not.toHaveBeenCalled();
	});

	it("happy path (Temporal available): signals cancel on the workflow handle, then updates DB", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockGetTemporalClient.mockResolvedValue({
			workflow: {
				getHandle: () => ({ cancel: mockTemporalCancel }),
			},
		});
		mockTemporalCancel.mockResolvedValue(undefined);
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED" }),
		);

		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		expect(mockTemporalCancel).toHaveBeenCalledTimes(1);
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});

	it("Temporal cancel failure does NOT prevent DB row update", async () => {
		mockGetWorkflowExecutionById.mockResolvedValue(execRow());
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockGetTemporalClient.mockResolvedValue({
			workflow: {
				getHandle: () => ({
					cancel: () => Promise.reject(new Error("handle gone")),
				}),
			},
		});
		mockUpdateWorkflowExecution.mockResolvedValue(
			execRow({ status: "CANCELLED" }),
		);

		const res = await makeApp().request(
			"/workflows/wf-1/executions/exec-1/cancel",
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		// DB row still got CANCELLED even though Temporal threw
		expect(mockUpdateWorkflowExecution).toHaveBeenCalledWith(
			"exec-1",
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});
});
