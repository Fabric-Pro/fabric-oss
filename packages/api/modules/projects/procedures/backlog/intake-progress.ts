import { ORPCError } from "@orpc/server";
import { getContextById } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { scopeIntakeWorkflowId } from "./start-scope-intake";

const progressSchema = z.object({
	status: z.enum([
		"awaiting_extraction",
		"extracting",
		"persisting",
		"completed",
		"cancelled",
		"failed",
		"not_started",
	]),
	message: z.string(),
	contextId: z.string(),
	originalFilename: z.string().nullable().optional(),
	rowCount: z.number().optional(),
	areaCount: z.number().optional(),
	changeCount: z.number().optional(),
	proposalId: z.string().optional(),
	llmUsed: z.boolean().optional(),
	error: z.string().optional(),
});

/**
 * Progress of a scope-intake workflow, keyed by context id (the workflow id
 * is deterministic). Falls back to the workflow result when the run has
 * already completed and the query is no longer served.
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_READ)` plus a
 * tenant-scoped lookup proving `contextId` belongs to `projectId` before the
 * workflow is addressed. Without that check a reader of project A could
 * probe intake progress (filename, proposal id, errors) of a context in
 * project B by guessing its id.
 */
export const intakeProgressProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/scope-intake/{contextId}/progress",
		tags: ["Projects", "Backlog"],
		summary: "Get scope intake progress",
	})
	.input(
		z.object({
			projectId: z.string(),
			contextId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(progressSchema)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);
		const projectContext = await getContextById(
			input.contextId,
			input.projectId,
			{ userId: context.user.id, organizationId: organizationId ?? null },
		);
		if (!projectContext || projectContext.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", {
				message: "Context not found in this project",
			});
		}

		const { getTemporalClient, intakeProgressQuery } = await import(
			"@repo/temporal"
		);
		const client = await getTemporalClient();
		const workflowId = scopeIntakeWorkflowId(input.contextId);
		const handle = client.workflow.getHandle(workflowId);

		try {
			const progress = await handle.query(intakeProgressQuery);
			return progressSchema.parse({
				...progress,
				contextId: input.contextId,
			});
		} catch (_queryError) {
			try {
				const result = await Promise.race([
					handle.result(),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Result timeout")),
							3000,
						),
					),
				]);
				return {
					status: "completed" as const,
					message: `${result.changeCount} proposed change(s) ready for review.`,
					contextId: input.contextId,
					rowCount: result.rowCount,
					changeCount: result.changeCount,
					proposalId: result.proposalId,
				};
			} catch (resultError) {
				const err = resultError as Error & {
					cause?: Error;
					name?: string;
				};
				if (
					err.name === "WorkflowNotFoundError" ||
					err.message?.includes("not found") ||
					err.message?.includes("NotFound")
				) {
					return {
						status: "not_started" as const,
						message:
							"No scope extraction has been started for this document.",
						contextId: input.contextId,
					};
				}
				if (err.message === "Result timeout") {
					throw new ORPCError("NOT_FOUND", {
						message: "Scope intake workflow is not responding",
					});
				}
				const message =
					err.cause?.message ?? err.message ?? "Scope intake failed";
				return {
					status: "failed" as const,
					message,
					contextId: input.contextId,
					error: message,
				};
			}
		}
	});
