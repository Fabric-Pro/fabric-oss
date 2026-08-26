import { AtlasService, analyzeInputSchema } from "@repo/atlas";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertAtlasEnabled, mapAtlasError } from "../lib";

/** Kick off (or re-run) background analysis on Temporal. */
export const analyzeProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/analyze",
		tags: ["Atlas"],
		summary: "Start (or re-run) repository analysis",
	})
	.input(analyzeInputSchema)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId =
			resolveOrganizationId(input.organizationId, context.session) ??
			null;
		const service = new AtlasService({
			userId: context.user.id,
			organizationId,
		});

		const plan = await service
			.requestAnalysis({
				projectId: input.projectId,
				repositoryIntegrationId: input.repositoryIntegrationId ?? null,
				fresh: input.fresh,
			})
			.catch((error) => mapAtlasError(error));

		try {
			const client = await getTemporalClient();
			await client.workflow.start(
				plan.workflowName,
				withCorrelationMemo({
					taskQueue: plan.taskQueue,
					workflowId: plan.workflowId,
					// Coarse runaway guard only — large monorepos (clone + walk +
					// per-module AI description + business derivation, plus a
					// possible activity retry) can legitimately run well over an
					// hour. The real guardrails are the per-activity start-to-close
					// and interval-heartbeat timeouts (see the workflow), which fail
					// *catchably* so the workflow can finalize FAILED. This cap sits
					// safely above the worst-case healthy run so it never terminates
					// one uncatchably mid-flight.
					workflowExecutionTimeout: "5h",
					args: [plan.workflowArgs],
				}),
			);
		} catch (error) {
			// Roll the row back so the UI doesn't get stuck on PENDING.
			await service
				.markStatus({
					analysisId: plan.analysisId,
					status: "FAILED",
					error: "Failed to start analysis",
				})
				.catch(() => {});
			mapAtlasError(error);
		}

		return plan.status;
	});
