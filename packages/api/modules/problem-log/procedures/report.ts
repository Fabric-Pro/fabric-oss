import { listProblemLogReportRows } from "@repo/database";
import {
	ProblemLogCategorySchema,
	ProblemLogStatusSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";
import { loadProblemLogProject } from "../lib/access";

/**
 * Rows for an incident report: one entry, or the confirmed entries matching
 * the filters and date range. The browser renders the preview and the CSV
 * and PDF files from them. A report shows nothing the list does not, so it
 * needs only read access.
 */
export const reportProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROBLEM_LOG_READ))
	.input(
		z
			.object({
				projectId: z.string(),
				organizationId: z.string().nullable().optional(),
				entryId: z.string().optional(),
				status: ProblemLogStatusSchema.optional(),
				category: ProblemLogCategorySchema.optional(),
				from: z.coerce.date().optional(),
				to: z.coerce.date().optional(),
			})
			.refine((v) => !v.from || !v.to || v.from <= v.to, {
				message: "The start date must not be after the end date.",
				path: ["from"],
			}),
	)
	.handler(async ({ input, context }) => {
		await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		const { organizationId } = await loadProblemLogProject({
			projectId: input.projectId,
			userId: context.user.id,
		});
		const report = await listProblemLogReportRows({
			organizationId,
			projectId: input.projectId,
			entryId: input.entryId,
			status: input.status,
			category: input.category,
			from: input.from,
			to: input.to,
		});
		return { ...report, generatedAt: new Date() };
	});
