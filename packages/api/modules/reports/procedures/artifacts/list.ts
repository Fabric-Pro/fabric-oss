import { listReportArtifacts } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const listInputSchema = z.object({
	executionId: z.string().optional(),
	templateId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	artifactType: z
		.enum([
			"MARKDOWN",
			"PDF",
			"HTML",
			"EVIDENCE_EMBED",
			"CHART_DATA",
			"CSV",
			"JSON",
		])
		.optional(),
	limit: z.number().min(1).max(100).default(50),
	offset: z.number().min(0).default(0),
});

export const listArtifactsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_READ))
	.input(listInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const { artifacts, total } = await listReportArtifacts({
			executionId: input.executionId,
			templateId: input.templateId,
			userId: context.user.id,
			organizationId,
			artifactType: input.artifactType,
			limit: input.limit,
			offset: input.offset,
		});

		return {
			artifacts,
			total,
			hasMore: input.offset + artifacts.length < total,
		};
	});
