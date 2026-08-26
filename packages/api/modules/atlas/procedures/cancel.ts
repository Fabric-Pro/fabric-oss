import { AtlasService, cancelAnalysisInputSchema } from "@repo/atlas";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/**
 * Cancel the in-flight repository analysis.
 *
 * Robust against a down/unreachable worker: the service finds the current
 * PENDING/ANALYZING row, best-effort cancels the Temporal workflow (via the
 * injected callback below — the procedure owns the client to avoid a
 * `@repo/temporal` ↔ `@repo/atlas` dependency cycle), then ALWAYS
 * idempotently finalizes the row to FAILED with "Cancelled by user" and emits
 * `atlas.analysis.cancelled`. Returns the refreshed status.
 */
export const cancelAnalysisProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/cancel",
		tags: ["Atlas"],
		summary: "Cancel the in-flight repository analysis",
	})
	.input(cancelAnalysisInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});

		return service
			.cancelAnalysis({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				// Best-effort Temporal cancel. Errors here are caught and
				// swallowed inside `cancelAnalysis` so the DB finalize still
				// runs when the worker is unavailable / the workflow is already
				// closed or not found.
				cancelWorkflow: async (workflowId) => {
					const client = await getTemporalClient();
					await client.workflow.getHandle(workflowId).cancel();
					logger.info("[atlas] requested workflow cancel", {
						workflowId,
					});
				},
			})
			.catch((error) => mapAtlasError(error));
	});
