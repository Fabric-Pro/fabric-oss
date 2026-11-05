import { ORPCError } from "@orpc/server";
import {
	assertPublicReportParameters,
	canAccessReportInstance,
	reportEvidenceConfigSchema,
	reportScheduleInputSchema,
} from "@repo/database";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	requireOrganizationMembership,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	assertReportPermission,
	canCreateProjectReport,
} from "../../lib/report-access";
import {
	createReportFromTemplate,
	reportInstanceConnectionsSchema,
} from "../../lib/report-creation";
import { ReportGenerationError } from "../../lib/report-refusal";

const createInstanceInputSchema = z.object({
	templateId: z.string(),
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	// The project whose Reports tab owns this report; its editors may maintain it.
	projectId: z.string().optional(),
	// User's bound connections for the template
	connections: reportInstanceConnectionsSchema,
	// Optional schedule for automated execution (shared schema — single source of truth).
	schedule: reportScheduleInputSchema.optional(),
	reporting: reportEvidenceConfigSchema.optional(),
	// Values the person chose or kept on the form, over every default.
	parameterDefaults: z
		.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
		.optional(),
});

// The middleware only admits members: the handler asks for `REPORT_CREATE`, which
// a platform admin holds in any organization they belong to.
export const createInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_READ, {
			requireOrganization: true,
		}),
	)
	.input(createInstanceInputSchema)
	.handler(async ({ input, context }) => {
		assertPublicReportParameters(input.parameterDefaults);
		// A project report is authorized against the project BEFORE the
		// organization resolves, so the organization becomes the project's own
		// and a different input organization is refused.
		if (input.projectId) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.REPORT_READ,
			);
			if (
				!(await canCreateProjectReport(input.projectId, context.user))
			) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"You need at least the Editor role on this project to add a report",
				});
			}
		}

		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization is required",
			});
		}
		await assertReportPermission(
			organizationId,
			context.user,
			Permissions.REPORT_CREATE,
		);
		if (
			input.reporting?.projectId &&
			!(await canAccessReportInstance(
				{
					userId: context.user.id,
					organizationId,
					fabricConfig: { reporting: input.reporting },
				},
				{ userId: context.user.id, organizationId },
				undefined,
				true,
			))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Project report access denied",
			});
		}

		await requireOrganizationMembership(organizationId, context.user.id);

		try {
			const instance = await createReportFromTemplate({
				caller: context.user,
				organizationId,
				creation: {
					templateId: input.templateId,
					name: input.name,
					description: input.description,
					projectId: input.projectId,
					connections: input.connections,
					schedule: input.schedule,
					reporting: input.reporting,
					parameterDefaults: input.parameterDefaults,
				},
			});
			return {
				id: instance.id,
				sId: instance.sId,
				version: instance.version,
				name: instance.name,
				templateId: instance.templateId,
				projectId: instance.projectId,
				createdAt: instance.createdAt.toISOString(),
			};
		} catch (error) {
			if (error instanceof ReportGenerationError) {
				throw new ORPCError(error.code, { message: error.message });
			}
			throw error;
		}
	});
