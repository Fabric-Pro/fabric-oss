import { ORPCError } from "@orpc/server";
import {
	canAccessReportInstance,
	createTemplateInstance,
	db,
	getReportTemplate,
	hasProjectKnowledgeSource,
	reportEvidenceConfigSchema,
	reportScheduleInputSchema,
	resolveReportTemplateDefaults,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	requireInputOrgPermission,
	requireOrganizationMembership,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { projectParameterDefaults } from "../../lib/project-parameter-defaults";
import { canEditProjectReport } from "../../lib/report-access";
import { templateScheduleForInheritance } from "../../lib/resolve-instance-schedule";
import { validateReportConnections } from "../../lib/validate-connections";

const createInstanceInputSchema = z.object({
	templateId: z.string(),
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	// The project whose Reports tab owns this report; its editors may maintain it.
	projectId: z.string().optional(),
	// User's bound connections for the template
	connections: z.object({
		mcpConfigs: z.array(z.string()).default([]),
		// Mapping of data source ID to user's MCP config ID
		mcpBindings: z.record(z.string(), z.string()).optional(),
		// Resource bindings for MCP connections (e.g., board ID for Fizzy), so a
		// new report starts with its board selected
		resourceBindings: z
			.record(
				z.string(),
				z.object({
					resourceId: z.string(),
					resourceName: z.string(),
					resourceType: z.string(),
				}),
			)
			.optional(),
		// Mapping of data source ID to parameter values
		parameterBindings: z
			.record(z.string(), z.record(z.string(), z.string()))
			.optional(),
		workflows: z.array(z.string()).default([]),
		agents: z.array(z.string()).default([]),
		workspaces: z.array(z.string()).default([]),
		integrations: z.array(z.string()).default([]),
		// Mapping of requirement key to user's workflow integration ID
		integrationBindings: z.record(z.string(), z.string()).optional(),
		// Human-readable context for AI (e.g., project name, team name)
		context: z.record(z.string(), z.string()).optional(),
		// Optional prompt override for customizing analysis
		promptOverride: z.string().optional(),
		// "user" when a person wrote the override; only then is it added to
		// the template's AI tasks.
		promptOverrideSource: z.literal("user").optional(),
		// Max AI iterations for agentic data gathering (default: 15)
		maxIterations: z.number().int().min(1).max(50).optional(),
	}),
	// Optional schedule for automated execution (shared schema — single source of truth).
	schedule: reportScheduleInputSchema.optional(),
	reporting: reportEvidenceConfigSchema.optional(),
});

export const createInstanceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.REPORT_CREATE, {
			requireOrganization: true,
		}),
	)
	.input(createInstanceInputSchema)
	.handler(async ({ input, context }) => {
		// A project report is authorized against the project BEFORE the
		// organization resolves, so the organization becomes the project's own
		// and a different input organization is refused.
		if (input.projectId) {
			await assertProjectPermission(
				input.projectId,
				context.user.id,
				Permissions.REPORT_READ,
			);
			if (!(await canEditProjectReport(input.projectId, context.user))) {
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

		// Verify template exists and user has access
		const template = await getReportTemplate({
			id: input.templateId,
			userId: context.user.id,
			organizationId,
		});

		if (!template) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found or access denied",
			});
		}

		if (template.archivedAt) {
			throw new ORPCError("BAD_REQUEST", {
				message: "This report template is archived",
			});
		}

		if (
			hasProjectKnowledgeSource(template.definition) &&
			!(input.reporting?.projectId ?? input.projectId)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Choose a project audience for Project knowledge",
			});
		}

		// Verify organization membership if org-scoped
		if (organizationId) {
			await requireOrganizationMembership(
				organizationId,
				context.user.id,
			);
		}

		// Validate connections before storing. Pass the template's data sources so
		// a binding keyed by a data source id (e.g. "task-board") can self-heal via
		// its server provider (e.g. "fizzy").
		const templateDataSources = (
			template.definition as {
				dataSources?: Array<{
					id?: string;
					key?: string;
					provider?: string;
				}>;
			} | null
		)?.dataSources;
		const validation = await validateReportConnections(
			input.connections,
			context.user.id,
			organizationId ?? undefined,
			templateDataSources,
		);
		if (!validation.valid) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid connections: ${validation.errors.join("; ")}`,
			});
		}

		// The organization's and the project's defaults for this template,
		// project over organization; what the caller sent wins over both.
		const overrides = await resolveReportTemplateDefaults({
			templateId: input.templateId,
			organizationId,
			projectId: input.projectId,
		});
		const overrideSchedule = reportScheduleInputSchema.safeParse(
			overrides.schedule,
		);

		// Inherit the template's schedule when the instance create omits one — but only
		// from a template this owner actually owns (never SYSTEM/public → cross-tenant). D3.
		const effectiveSchedule =
			input.schedule ??
			(overrideSchedule.success ? overrideSchedule.data : undefined) ??
			templateScheduleForInheritance(
				template,
				context.user.id,
				organizationId ?? null,
			);

		// A project's report starts with the parameters the project answers.
		const project = input.projectId
			? await db.project.findUnique({
					where: { id: input.projectId },
					select: { name: true },
				})
			: null;
		const parameterDefaults = {
			...(project
				? projectParameterDefaults(template.parameters, project)
				: undefined),
			...overrides.parameterDefaults,
		};
		const connections =
			Object.keys(overrides.context).length > 0
				? {
						...input.connections,
						context: {
							...overrides.context,
							...input.connections.context,
						},
					}
				: input.connections;

		// Create the instance
		const instance = await createTemplateInstance({
			templateId: input.templateId,
			userId: context.user.id,
			organizationId,
			projectId: input.projectId,
			name: input.name,
			description: input.description,
			connections,
			parameterDefaults:
				Object.keys(parameterDefaults).length > 0
					? parameterDefaults
					: undefined,
			fabricConfig: input.reporting
				? { reporting: input.reporting }
				: undefined,
			schedule: effectiveSchedule as Prisma.InputJsonValue | undefined,
			// CUSTOM iff the caller supplied an explicit per-instance schedule; otherwise the
			// instance follows the template (INHERITED), even when a schedule was inherited. (D2/§7.1)
			scheduleMode: input.schedule !== undefined ? "CUSTOM" : "INHERITED",
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
	});
