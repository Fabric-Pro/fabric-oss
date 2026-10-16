/**
 * v1 Workflows routes
 * GET  /workflows                                          list workflows
 * GET  /workflows/:id                                      get workflow
 * POST /workflows/:id/trigger                              trigger a workflow execution
 * GET  /workflows/:id/executions                           list executions for a workflow
 * GET  /workflows/:id/executions/:execId                   get execution status
 * POST /workflows/:id/executions/:execId/cancel            cancel a running execution
 */
import {
	getWorkflowById,
	getWorkflowExecutionById,
	isWorkflowLive,
	listWorkflowExecutions,
	listWorkflows,
	type Prisma,
	updateWorkflowExecution,
} from "@repo/database";
import type { Hono } from "hono";
import { requireScope } from "../external-api/middleware/api-key-auth";
import type { ExternalApiVariables } from "../external-api/types";
import {
	concurrencyRefusalMessage,
	createExecutionWithinConcurrencyCap,
} from "../workflows/lib/execution-concurrency";
import { cancelWorkflowBuilderExecution } from "../workflows/lib/start-builder-execution";
import {
	ENGINE_UNAVAILABLE_MESSAGE,
	startReservedExecution,
} from "../workflows/lib/start-reserved-execution";
import { badRequest, notFound, ok, resolveV1Context } from "./helpers";

const TERMINAL_EXECUTION_STATUSES = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
]);

const EXECUTION_STATUS_VALUES = new Set([
	"PENDING",
	"RUNNING",
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
]);

export function registerWorkflowRoutes(
	app: Hono<{ Variables: ExternalApiVariables }>,
) {
	// List workflows
	app.get("/workflows", requireScope("workflows:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
		const offset = Number(c.req.query("offset") ?? 0);

		const result = await listWorkflows({
			userId: ctx.userId,
			organizationId: ctx.organizationId ?? undefined,
			limit,
			offset,
			search: c.req.query("search"),
			status: c.req.query("status") as
				| "DRAFT"
				| "ACTIVE"
				| "PAUSED"
				| "ARCHIVED"
				| undefined,
			triggerType: c.req.query("triggerType") as
				| "MANUAL"
				| "SCHEDULE"
				| "WEBHOOK"
				| "EVENT"
				| undefined,
		});

		return c.json(
			ok(result.workflows, {
				total: result.total,
				hasMore: result.hasMore,
			}),
		);
	});

	// Get single workflow
	app.get("/workflows/:id", requireScope("workflows:read"), async (c) => {
		const apiCtx = c.get("externalApiContext");
		const ctx = await resolveV1Context(
			apiCtx,
			c.req.query("org"),
			c.req.query("personal") === "1",
		);
		if ("error" in ctx) {
			return c.json({ error: { message: ctx.error } }, ctx.status);
		}

		const workflow = await getWorkflowById(
			c.req.param("id")!,
			ctx.userId,
			ctx.organizationId ?? undefined,
		);
		if (!workflow) {
			return c.json(notFound("Workflow"), 404);
		}

		return c.json(ok(workflow));
	});

	// Trigger a workflow execution
	app.post(
		"/workflows/:id/trigger",
		requireScope("workflows:run"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			let body: {
				triggerInput?: Prisma.InputJsonValue;
			} = {};
			try {
				const text = await c.req.text();
				if (text) {
					body = JSON.parse(text);
				}
			} catch {
				return c.json(badRequest("Invalid JSON body"), 400);
			}

			const workflow = await getWorkflowById(
				c.req.param("id")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!workflow) {
				return c.json(notFound("Workflow"), 404);
			}

			if (!isWorkflowLive(workflow.status)) {
				return c.json(
					badRequest(
						`Workflow is not active (status: ${workflow.status})`,
					),
					422,
				);
			}

			// Same cap the oRPC, webhook and MCP starters apply. The row is
			// created inside the reservation, so the cap holds under
			// concurrent triggers rather than only when nobody races for it.
			const reservation = await createExecutionWithinConcurrencyCap({
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? null,
				data: {
					workflowId: workflow.id,
					version: workflow.version,
					triggerType: "MANUAL",
					triggerInput: body.triggerInput ?? {},
				},
			});
			if (!reservation.allowed) {
				return c.json(
					{
						error: {
							message: concurrencyRefusalMessage(reservation),
							code: "EXECUTION_LIMIT_REACHED",
						},
					},
					429,
				);
			}
			const execution = reservation.execution;

			// This used to start a workflow type that does not exist, under an
			// id no other path knew, with the input under a key the workflow
			// never reads — and then swallow the error on the theory that "the
			// worker will pick it up later". Nothing ever did: every API-started
			// run sat at PENDING for good. The shared start fixes the first
			// three; the row now records the fourth instead of hiding it.
			const started = await startReservedExecution({
				execution,
				logTag: "v1 workflows",
				start: {
					workflowId: workflow.id,
					userId: ctx.userId,
					organizationId: ctx.organizationId ?? undefined,
					projectId: workflow.projectId ?? undefined,
					triggerData: (body.triggerInput ?? {}) as Record<
						string,
						unknown
					>,
				},
			});

			if (started.status === "failed") {
				return c.json(
					{
						error: {
							message: ENGINE_UNAVAILABLE_MESSAGE,
							code: "EXECUTION_NOT_STARTED",
							executionId: execution.id,
						},
					},
					502,
				);
			}

			if (started.status === "unconfirmed") {
				// 202 with an explicit "unconfirmed" status, not a 5xx:
				// clients and webhook senders retry server errors, and a
				// retry creates a second row and a second run. The caller
				// polls this execution instead.
				return c.json(
					ok({
						executionId: execution.id,
						workflowId: workflow.id,
						status: "unconfirmed",
						message: started.message,
					}),
					202,
				);
			}

			// The run already moved on (a short run finished before the row
			// was marked); report where it is.
			let status = "RUNNING";
			if (started.rowAlreadyAdvanced) {
				const current = await getWorkflowExecutionById(
					execution.id,
					ctx.userId,
					ctx.organizationId ?? undefined,
				);
				status = current?.status ?? status;
			}

			return c.json(
				ok({
					executionId: execution.id,
					workflowId: workflow.id,
					status,
				}),
				202,
			);
		},
	);

	// Get execution status
	app.get(
		"/workflows/:id/executions/:execId",
		requireScope("workflows:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			// Verify the caller can access the parent workflow
			const workflow = await getWorkflowById(
				c.req.param("id")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!workflow) {
				return c.json(notFound("Workflow"), 404);
			}

			const execution = await getWorkflowExecutionById(
				c.req.param("execId")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			// Also verify the execution belongs to this workflow
			if (!execution || execution.workflowId !== workflow.id) {
				return c.json(notFound("Execution"), 404);
			}

			return c.json(ok(execution));
		},
	);

	/**
	 * GET /workflows/:id/executions
	 * Lists executions for a workflow, scoped to the caller's tenant.
	 */
	app.get(
		"/workflows/:id/executions",
		requireScope("workflows:read"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const workflow = await getWorkflowById(
				c.req.param("id")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!workflow) {
				return c.json(notFound("Workflow"), 404);
			}

			const limit = Math.min(Number(c.req.query("limit") ?? 20), 100);
			const offset = Number(c.req.query("offset") ?? 0);
			if (Number.isNaN(limit) || Number.isNaN(offset)) {
				return c.json(
					badRequest("limit and offset must be numbers"),
					400,
				);
			}

			const statusFilter = c.req.query("status");
			if (statusFilter && !EXECUTION_STATUS_VALUES.has(statusFilter)) {
				return c.json(
					badRequest(`Invalid status: ${statusFilter}`),
					400,
				);
			}

			const result = await listWorkflowExecutions({
				workflowId: workflow.id,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
				status: statusFilter as Parameters<
					typeof listWorkflowExecutions
				>[0]["status"],
				limit,
				offset,
			});

			return c.json(
				ok(result.executions, {
					total: result.total,
					hasMore: result.hasMore,
					nextOffset: result.nextOffset,
				}),
			);
		},
	);

	/**
	 * POST /workflows/:id/executions/:execId/cancel
	 * Cancels a running execution. Best-effort signals the underlying
	 * Temporal workflow handle; always marks the DB row as CANCELLED
	 * so subsequent reads reflect the request. Already-terminal
	 * executions return 409.
	 */
	app.post(
		"/workflows/:id/executions/:execId/cancel",
		requireScope("workflows:run"),
		async (c) => {
			const apiCtx = c.get("externalApiContext");
			const ctx = await resolveV1Context(
				apiCtx,
				c.req.query("org"),
				c.req.query("personal") === "1",
			);
			if ("error" in ctx) {
				return c.json({ error: { message: ctx.error } }, ctx.status);
			}

			const workflow = await getWorkflowById(
				c.req.param("id")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!workflow) {
				return c.json(notFound("Workflow"), 404);
			}

			const execution = await getWorkflowExecutionById(
				c.req.param("execId")!,
				ctx.userId,
				ctx.organizationId ?? undefined,
			);
			if (!execution || execution.workflowId !== workflow.id) {
				return c.json(notFound("Execution"), 404);
			}

			if (TERMINAL_EXECUTION_STATUSES.has(execution.status)) {
				return c.json(
					{
						error: {
							message: `Execution is already ${execution.status}`,
							code: "EXECUTION_TERMINAL",
						},
					},
					409,
				);
			}

			// Best-effort Temporal cancel — mirrors the optional Temporal
			// dispatch in /trigger. If Temporal is unavailable the DB row
			// update still records the user's intent.
			try {
				const { isTemporalAvailable } = await import("@repo/temporal");
				if (await isTemporalAvailable()) {
					await cancelWorkflowBuilderExecution(execution.id);
				}
			} catch {
				// Temporal unavailable or handle gone — fall through to DB update.
			}

			const updated = await updateWorkflowExecution(execution.id, {
				status: "CANCELLED",
				completedAt: new Date(),
			});

			return c.json(
				ok({
					executionId: updated.id,
					workflowId: workflow.id,
					status: updated.status,
				}),
			);
		},
	);
}
