import { ORPCError } from "@orpc/server";
import { getLatestProjectTemplateRun } from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { canReachProjectReports } from "../../lib/report-access";

const previewTemplateInputSchema = z.object({
	templateId: z.string().min(1),
	projectId: z.string().min(1).max(128),
	organizationId: z.string().nullable().optional(),
});

/**
 * The preview a template shows in a project before a report is set up: the
 * newest successful report made from it in this project, or `null` when
 * there is none (the screen then offers a sample).
 */
export const previewTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(previewTemplateInputSchema)
	.handler(async ({ input, context }) => {
		// A project's reports are shared with everyone who may read them, so the
		// organization is the authorized project's own, never the caller's input.
		// Reach is `canReachProjectReports`'s, which admits an organization admin
		// to every project's reports and nobody else who cannot open the project.
		const project = await assertProjectPermission(
			input.projectId,
			context.user.id,
			Permissions.REPORT_READ,
			undefined,
			{ admitUnreachableOrganizationMember: true },
		);
		if (!(await canReachProjectReports(input.projectId, context.user))) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		// The query returns only a run the caller may open as a report.
		const run = await getLatestProjectTemplateRun({
			templateId: input.templateId,
			projectId: input.projectId,
			userId: context.user.id,
			organizationId: project.organizationId,
		});
		const artifact = run?.artifacts[0];
		if (!run || !artifact?.content) {
			return { run: null };
		}
		return {
			run: {
				executionId: run.id,
				instanceId: run.instance.id,
				instanceName: run.instance.name,
				completedAt: run.completedAt?.toISOString() ?? null,
				artifact: {
					id: artifact.id,
					name: artifact.name,
					content: artifact.content,
				},
			},
		};
	});
