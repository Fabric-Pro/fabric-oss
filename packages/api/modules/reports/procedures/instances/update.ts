import { isDeepStrictEqual } from "node:util";
import { ORPCError } from "@orpc/server";
import {
	assertPublicReportParameters,
	canAccessReportInstance,
	getProjectReportSetupReason,
	getTemplateInstance,
	publicReportParametersSchema,
	readReportEvidenceConfig,
	reportEvidenceConfigSchema,
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
import {
	assertCanEditReportInstance,
	canManageReportLifecycle,
} from "../../lib/report-access";
import {
	type ReportDataSourceMeta,
	validateReportConnections,
} from "../../lib/validate-connections";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
			// "user" when a person wrote the override; only then is it added
			// to the template's AI tasks.
			promptOverrideSource: z.literal("user").optional(),
			// Max AI iterations for agentic data gathering (default: 15)
			maxIterations: z.number().int().min(1).max(50).optional(),
		})
		.optional(),
	parameterDefaults: publicReportParametersSchema.optional(),
	fabricConfig: z
		.object({
			reporting: reportEvidenceConfigSchema.optional(),
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

/** A binding's stored form as the input schema reads it, an absent one being empty. */
function comparableBinding(value: unknown): unknown {
	if (!isRecord(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, entry]) => {
			if (isRecord(entry)) {
				return [[key, comparableBinding(entry)]];
			}
			const text =
				entry === null || entry === undefined ? "" : String(entry);
			return text.trim() ? [[key, text.trim()]] : [];
		}),
	);
}

/**
 * Whether an edit changes what a connected report's owner connections read. A
 * resent stored value changes nothing, whichever way the page normalized it. A
 * report with no connection has nothing of the owner's to repoint.
 */
function repointsOwnerConnections(
	stored: unknown,
	next: Record<string, unknown>,
): boolean {
	const current = isRecord(stored) ? stored : {};
	const connected = [
		current.mcpConfigs,
		current.mcpBindings,
		current.integrations,
		current.integrationBindings,
	].some((bound) =>
		Array.isArray(bound)
			? bound.length > 0
			: isRecord(bound) && Object.keys(bound).length > 0,
	);
	return (
		connected &&
		["context", "resourceBindings", "parameterBindings"].some(
			(field) =>
				!isDeepStrictEqual(
					comparableBinding(current[field]),
					comparableBinding(next[field]),
				),
		)
	);
}

// The middleware only admits members: `assertCanEditReportInstance` decides per
// report, since a project Editor who is an organization Viewer may edit theirs.
export const updateInstanceProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_READ))
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

		await assertCanEditReportInstance(existing, context.user);

		if (!organizationId) {
			throw new ORPCError("BAD_REQUEST", {
				message: "An organization is required",
			});
		}
		// Editing a report does not take over when it runs or whether it exists:
		// a schedule spends the owner's connections and credits, a status starts
		// or stops its scheduled runs, and `instances.archive` and
		// `instances.restore` have stricter gates. A new version comes out active,
		// so it counts as switching the report on.
		if (
			(input.scheduleUpdate !== undefined ||
				input.isActive !== undefined ||
				input.createNewVersion ||
				(input.status !== undefined &&
					input.status !== existing.status)) &&
			!(await canManageReportLifecycle(existing, context.user))
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Your organization role can edit this report, but not schedule, switch on, archive or restore it",
			});
		}
		assertPublicReportParameters(input.parameterDefaults);
		const originalReporting = readReportEvidenceConfig(
			existing.fabricConfig,
		);
		if (
			input.fabricConfig?.reporting &&
			input.fabricConfig.reporting.projectId !==
				originalReporting?.projectId
		) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A report audience cannot be changed. Create a new report for the project audience you need.",
			});
		}

		const storedFabricConfig = existing.fabricConfig as Record<
			string,
			unknown
		> | null;
		const mergedFabricConfig = input.fabricConfig
			? {
					...storedFabricConfig,
					...input.fabricConfig,
					// An explicit `undefined` must not drop the audience locked above.
					...(input.fabricConfig.reporting === undefined &&
					storedFabricConfig?.reporting !== undefined
						? { reporting: storedFabricConfig.reporting }
						: {}),
				}
			: undefined;
		if (
			!(await canAccessReportInstance(
				existing,
				{ userId: context.user.id, organizationId },
				undefined,
				true,
			)) ||
			(mergedFabricConfig &&
				!(await canAccessReportInstance(
					{ ...existing, fabricConfig: mergedFabricConfig },
					{ userId: context.user.id, organizationId },
					undefined,
					true,
				)))
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "Project report access denied",
			});
		}

		const setupReason = getProjectReportSetupReason(
			mergedFabricConfig ?? existing.fabricConfig,
			existing.template.definition,
			input.connections ?? existing.connections,
		);
		if (
			setupReason &&
			(input.isActive === true ||
				input.status === "ACTIVE" ||
				(input.scheduleUpdate && input.scheduleUpdate.mode !== "off"))
		) {
			throw new ORPCError("BAD_REQUEST", { message: setupReason });
		}
		if (
			input.connections &&
			existing.userId !== context.user.id &&
			repointsOwnerConnections(existing.connections, input.connections)
		) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only the report's owner can change what its connections read: the board or resource, the data source parameters and the context. You can still edit its prompts.",
			});
		}

		// Validate connections if provided. Pass the template's data sources so a
		// binding keyed by a data source id (e.g. "task-board") can self-heal via
		// its server provider (e.g. "fizzy").
		if (input.connections) {
			const templateDataSources = (
				existing.template?.definition as {
					dataSources?: ReportDataSourceMeta[];
				} | null
			)?.dataSources;
			const validation = await validateReportConnections(
				input.connections,
				existing.userId,
				organizationId ?? undefined,
				templateDataSources,
				existing.connections,
				{ sameServerOnly: existing.userId !== context.user.id },
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
			fabricConfig: mergedFabricConfig as
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
