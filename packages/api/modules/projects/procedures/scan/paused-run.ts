import { ORPCError } from "@orpc/server";
import {
	type BulkRunKind,
	getProjectScan,
	getScanFindingGrouping,
	getScanFindingReview,
	hasProjectAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	getPausedRunApiAccess,
	runPausedBulkRunOnApi,
} from "../../lib/paused-bulk-run";
import { resolveProjectOrganizationId } from "../../lib/project-organization";

const RUN_KINDS = {
	scan: "PROJECT_SCAN",
	review: "SCAN_REVIEW",
	grouping: "SCAN_GROUPING",
} as const satisfies Record<string, BulkRunKind>;

async function requireAccess(
	projectId: string,
	userId: string,
	organizationId: string | null,
) {
	if (
		!(await hasProjectAccess(
			projectId,
			userId,
			organizationId ?? undefined,
		))
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

/**
 * What a paused scan, review or grouping run may offer besides Cancel
 * (Fizzy #2770): "Run now on API billing" only when the organization has an
 * LLM provider of its own to bill.
 */
export const pausedRunOptionsProcedure = tenantProtectedProcedure
	.route({
		method: "GET",
		path: "/projects/:projectId/scan/paused-run-options",
		tags: ["Projects", "Security"],
		summary: "What a run paused for a ChatGPT plan reset may offer",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		await requireAccess(input.projectId, context.user.id, organizationId);
		return getPausedRunApiAccess({
			organizationId,
			userId: context.user.id,
		});
	});

/**
 * "Run now on API billing" for a scan, review or grouping run paused for a
 * ChatGPT plan reset: that one run resumes at once on the organization's own
 * provider, audited. Cancel stays the run's own cancel procedure.
 */
export const runPausedOnApiProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/run-paused-on-api",
		tags: ["Projects", "Security"],
		summary: "Resume a paused run now on the organization's AI provider",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			kind: z.enum(["scan", "review", "grouping"]),
			runId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, runId, kind } = input;
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			projectId,
		);
		await requireAccess(projectId, context.user.id, organizationId);

		// The run must belong to this project — never resume one by an id
		// from another project or tenant.
		const run =
			kind === "scan"
				? await getProjectScan(runId, projectId)
				: kind === "review"
					? await getScanFindingReview(runId, projectId)
					: await getScanFindingGrouping(runId, projectId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", { message: "Run not found" });
		}

		return runPausedBulkRunOnApi({
			context,
			kind: RUN_KINDS[kind],
			runId,
			projectId,
			userId: context.user.id,
			organizationId,
			impersonatedBy: context.session.impersonatedBy,
		});
	});
