import { ORPCError } from "@orpc/server";
import {
	createTemplateInstance,
	getReportTemplate,
	reportScheduleInputSchema,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { templateScheduleForInheritance } from "../../lib/resolve-instance-schedule";
import { validateReportConnections } from "../../lib/validate-connections";

const createInstanceInputSchema = z.object({
	templateId: z.string(),
	name: z.string().min(1).max(255),
	description: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	// User's bound connections for the template
	connections: z.object({
		mcpConfigs: z.array(z.string()).default([]),
		// Mapping of data source ID to user's MCP config ID
		mcpBindings: z.record(z.string(), z.string()).optional(),
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
		// Max AI iterations for agentic data gathering (default: 15)
		maxIterations: z.number().int().min(1).max(50).optional(),
	}),
	// Optional schedule for automated execution (shared schema — single source of truth).
	schedule: reportScheduleInputSchema.optional(),
});

export const createInstanceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_CREATE))
	.input(createInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

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

		// Inherit the template's schedule when the instance create omits one — but only
		// from a template this owner actually owns (never SYSTEM/public → cross-tenant). D3.
		const effectiveSchedule =
			input.schedule ??
			templateScheduleForInheritance(
				template,
				context.user.id,
				organizationId ?? null,
			);

		// Create the instance
		const instance = await createTemplateInstance({
			templateId: input.templateId,
			userId: context.user.id,
			organizationId,
			name: input.name,
			description: input.description,
			connections: input.connections,
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
			createdAt: instance.createdAt.toISOString(),
		};
	});
