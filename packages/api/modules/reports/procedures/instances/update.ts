import { ORPCError } from "@orpc/server";
import {
	getTemplateInstance,
	reportScheduleInputSchema,
	updateTemplateInstance,
} from "@repo/database";
import type {
	Prisma,
	TemplateInstanceStatus,
} from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { validateReportConnections } from "../../lib/validate-connections";

export const updateInstanceInputSchema = z.object({
	id: z.string(),
	organizationId: z.string().nullable().optional(),
	name: z.string().min(1).max(255).optional(),
	description: z.string().optional(),
	connections: z
		.object({
			mcpConfigs: z.array(z.string()).default([]),
			mcpBindings: z.record(z.string(), z.string()).default({}),
			workflows: z.array(z.string()).default([]),
			agents: z.array(z.string()).default([]),
			workspaces: z.array(z.string()).default([]),
			integrations: z.array(z.string()).default([]),
			integrationBindings: z.record(z.string(), z.string()).default({}),
			// Resource bindings for MCP connections (e.g., board ID for Fizzy, channel ID for Slack)
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
			// Data source operation parameters (e.g., project, team, iteration)
			parameterBindings: z
				.record(z.string(), z.record(z.string(), z.string()))
				.optional(),
			// Human-readable context for AI (e.g., project name, team name)
			context: z.record(z.string(), z.string()).optional(),
			// Optional prompt override for customizing analysis
			promptOverride: z.string().optional(),
			// Max AI iterations for agentic data gathering (default: 15)
			maxIterations: z.number().int().min(1).max(50).optional(),
		})
		.optional(),
	parameterDefaults: z.record(z.string(), z.unknown()).optional(),
	fabricConfig: z
		.object({
			strategy: z.string().optional(),
			context: z.string().optional(),
			pattern: z.string().optional(),
			variables: z.record(z.string(), z.string()).optional(),
			enableAutoDetection: z.boolean().optional(),
			// Custom AI task prompts (keyed by agent output variable)
			customAiTasks: z.record(z.string(), z.string()).optional(),
			// Custom system prompt for AI analysis
			customSystemPrompt: z.string().optional(),
		})
		.optional(),
	// Three-state schedule command (Part 2). Omit to leave scheduling unchanged.
	// inherit = follow the template (fresh snapshot); custom = this report's own schedule;
	// off = disable scheduling (durable; retains config).
	scheduleUpdate: z
		.discriminatedUnion("mode", [
			z.object({ mode: z.literal("inherit") }),
			z.object({
				mode: z.literal("custom"),
				schedule: reportScheduleInputSchema,
			}),
			z.object({ mode: z.literal("off") }),
		])
		.optional(),
	isActive: z.boolean().optional(),
	status: z.enum(["PENDING", "ACTIVE", "ARCHIVED", "DRAFT"]).optional(),
	createNewVersion: z.boolean().default(false),
});

export const updateInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_UPDATE))
	.input(updateInstanceInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify instance exists and user has access
		const existing = await getTemplateInstance({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Template instance not found or access denied",
			});
		}

		// Validate connections if provided. Pass the template's data sources so a
		// binding keyed by a data source id (e.g. "task-board") can self-heal via
		// its server provider (e.g. "fizzy").
		if (input.connections) {
			const templateDataSources = (
				existing.template?.definition as {
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
		}

		// Update the instance
		const updated = await updateTemplateInstance({
			id: input.id,
			name: input.name,
			description: input.description,
			connections: input.connections as Prisma.InputJsonValue | undefined,
			parameterDefaults: input.parameterDefaults as
				| Prisma.InputJsonValue
				| undefined,
			fabricConfig: input.fabricConfig as
				| Prisma.InputJsonValue
				| undefined,
			...(input.scheduleUpdate && {
				scheduleUpdate: input.scheduleUpdate,
			}),
			isActive: input.isActive,
			status: input.status as TemplateInstanceStatus | undefined,
			createNewVersion: input.createNewVersion,
		});

		return {
			id: updated.id,
			sId: updated.sId,
			version: updated.version,
			status: updated.status,
			name: updated.name,
			description: updated.description,
			isActive: updated.isActive,
			updatedAt: updated.updatedAt.toISOString(),
		};
	});
