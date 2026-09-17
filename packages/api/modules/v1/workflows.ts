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
	listWorkflowExecutions,
	listWorkflows,
	markExecutionRunningIfPending,
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
import {
	attemptWorkflowBuilderStart,
	cancelWorkflowBuilderExecution,
	startFailureMessage,
	unconfirmedStartMessage,
} from "../workflows/lib/start-builder-execution";
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

			if (workflow.status !== "ACTIVE") {
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

			const failRow = async (message: string) => {
				// No sweeper reclaims a PENDING execution. Record the terminal
				// state so the run history says "never started", not "queued".
				const failedAt = new Date();
				await updateWorkflowExecution(execution.id, {
					status: "FAILED",
					error: message,
					completedAt: failedAt,
					duration:
						failedAt.getTime() - execution.startedAt.getTime(),
				});
			};

			// This used to start a workflow type that does not exist, under an
			// id no other path knew, with the input under a key the workflow
			// never reads — and then swallow the error on the theory that "the
			// worker will pick it up later". Nothing ever did: every API-started
			// run sat at PENDING for good. The shared helper fixes the first
			// three; the row now records the fourth instead of hiding it.
			const { isTemporalAvailable } = await import("@repo/temporal");
			if (!(await isTemporalAvailable())) {
				await failRow("Workflow engine unavailable");
				return c.json(
					{
						error: {
							message:
								"Workflow engine unavailable — the run was not started. Try again.",
							code: "EXECUTION_NOT_STARTED",
							executionId: execution.id,
						},
					},
					502,
				);
			}

			const outcome = await attemptWorkflowBuilderStart({
				executionId: execution.id,
				workflowId: workflow.id,
				userId: ctx.userId,
				organizationId: ctx.organizationId ?? undefined,
				projectId: workflow.projectId ?? undefined,
				triggerData: (body.triggerInput ?? {}) as Record<
					string,
					unknown
				>,
			});

			if (outcome.status === "not-started") {
				// Temporal confirmed nothing runs under the row's id, so the
				// row can be failed and the caller may retry.
				await failRow(startFailureMessage(outcome.error));
				return c.json(
					{
						error: {
							message:
								"Workflow engine unavailable — the run was not started. Try again.",
							code: "EXECUTION_NOT_STARTED",
							executionId: execution.id,
						},
					},
					502,
				);
			}

			if (outcome.status === "unknown") {
				// The start call failed and the follow-up describe could not
				// settle whether Temporal accepted it. The run may be in
				// progress under the deterministic id, so the row stays
				// active — failing it invites a retry, which creates a new row
				// and a second run with the same side effects. The workflow
				// writes its own status as it progresses.
				console.warn(
					"[v1 workflows] Start unconfirmed; leaving the execution row active:",
					{
						executionId: execution.id,
						workflowId: outcome.workflowId,
					},
					outcome.error,
				);
				// 202 with an explicit "unconfirmed" status, not a 5xx:
				// clients and webhook senders retry server errors, and a
				// retry creates a second row and a second run. The caller
				// polls this execution instead.
				return c.json(
					ok({
						executionId: execution.id,
						workflowId: workflow.id,
						status: "unconfirmed",
						message: unconfirmedStartMessage(execution.id),
					}),
					202,
				);
			}

			// The run exists in the engine from here on. A failure to record
			// that must not be reported as "not started" (a retry would start a
			// second run with the same side effects); it is logged and the
			// start is still reported. The workflow writes its own status as it
			// progresses and its id is deterministic from the execution id.
			// PENDING → RUNNING only: a fast run may already have written its
			// terminal status, which must not move back to RUNNING.
			let status = "RUNNING";
			try {
				const moved = await markExecutionRunningIfPending({
					executionId: execution.id,
					temporalRunId: outcome.workflowId,
				});
				if (!moved) {
					// The run already moved on; report where it is.
					const current = await getWorkflowExecutionById(
						execution.id,
						ctx.userId,
						ctx.organizationId ?? undefined,
					);
					status = current?.status ?? status;
				}
			} catch (error) {
				console.error(
					"[v1 workflows] Run started but the execution row could not be marked RUNNING:",
					{
						executionId: execution.id,
						workflowId: outcome.workflowId,
					},
					error,
				);
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
