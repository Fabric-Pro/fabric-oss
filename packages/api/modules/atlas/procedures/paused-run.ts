import { ORPCError } from "@orpc/server";
import { AtlasService } from "@repo/atlas";
import { markAtlasAnalysisResumeApproved } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	getPausedRunApiAccess,
	runPausedBulkRunOnApi,
} from "../../projects/lib/paused-bulk-run";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";
import { assertAtlasEnabled } from "../lib";

const pausedRunInput = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	analysisId: z.string(),
});

/**
 * The analysis run paused for a ChatGPT plan reset (Fizzy #2770), if one is:
 * when it resumes, and whether the viewer may run it now on the
 * organization's AI provider. Cancel is "Cancel analysis", which stops a
 * paused run too.
 */
export const atlasPausedRunProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_READ, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "GET",
		path: "/projects/:projectId/atlas/paused-run",
		tags: ["Atlas"],
		summary: "The analysis run paused for a ChatGPT plan reset",
	})
	.input(pausedRunInput)
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		const run = await new AtlasService({
			userId: context.user.id,
			organizationId,
		}).getPausedRun({
			projectId: input.projectId,
			analysisId: input.analysisId,
		});
		if (!run) {
			return { run: null };
		}
		return {
			run: {
				id: run.id,
				resumesAt: run.resumesAt,
				pauseCount: run.pauseCount,
				...(await getPausedRunApiAccess({
					organizationId,
					userId: context.user.id,
				})),
			},
		};
	});

/**
 * "Run now on API billing" for a paused analysis run: it resumes at once on
 * the organization's own provider, for this run only, audited. Only an
 * organization admin or owner may approve it, never while impersonating.
 */
export const atlasRunPausedOnApiProcedure = tenantProtectedProcedure
	.use(
		requireProjectPermission(Permissions.PROJECT_SETTINGS_EDIT, {
			projectIdKey: "projectId",
		}),
	)
	.route({
		method: "POST",
		path: "/projects/:projectId/atlas/paused-run/run-on-api",
		tags: ["Atlas"],
		summary:
			"Resume a paused analysis now on the organization's AI provider",
	})
	.input(pausedRunInput.extend({ runId: z.string() }))
	.handler(async ({ input, context }) => {
		assertAtlasEnabled();
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		// The run must be this project's paused run, in the caller's tenant —
		// never one resumed by an id from elsewhere.
		const run = await new AtlasService({
			userId: context.user.id,
			organizationId,
		}).getPausedRun({
			projectId: input.projectId,
			analysisId: input.analysisId,
		});
		if (!run || run.id !== input.runId) {
			throw new ORPCError("CONFLICT", {
				message:
					"This analysis is no longer waiting for a ChatGPT plan reset.",
			});
		}
		const { workflowId } = await runPausedBulkRunOnApi({
			context,
			kind: "ATLAS_ANALYSIS",
			runId: run.id,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId,
			impersonatedBy: context.session.impersonatedBy,
		});
		await markAtlasAnalysisResumeApproved({
			analysisId: run.analysisId,
			workflowId,
		});
		return { workflowId };
	});
