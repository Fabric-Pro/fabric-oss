import { ORPCError } from "@orpc/server";
import { getReportTemplate, updateReportTemplate } from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

// Evidence.dev theme configuration schema
const evidenceThemeSchema = z
	.object({
		colors: z
			.object({
				primary: z.string().optional(),
				secondary: z.string().optional(),
				accent: z.string().optional(),
				background: z.string().optional(),
				surface: z.string().optional(),
				text: z.string().optional(),
			})
			.optional(),
		fonts: z
			.object({
				heading: z.string().optional(),
				body: z.string().optional(),
				mono: z.string().optional(),
			})
			.optional(),
		borderRadius: z.string().optional(),
	})
	.optional();

// Evidence.dev configuration schema
const evidenceConfigSchema = z
	.object({
		// Theme configuration
		theme: evidenceThemeSchema,
		// Layout options
		layout: z
			.object({
				columns: z.number().min(1).max(4).optional(),
				sidebar: z.boolean().optional(),
				header: z.boolean().optional(),
			})
			.optional(),
		// Default chart type for auto-generated charts
		defaultChartType: z
			.enum(["line", "bar", "area", "scatter", "pie"])
			.optional(),
		// Component overrides per section
		componentOverrides: z
			.record(
				z.string(),
				z.object({
					evidenceComponent: z.string(),
					props: z.record(z.string(), z.unknown()).optional(),
				}),
			)
			.optional(),
		// Build options
		useDocker: z.boolean().optional(),
	})
	.optional();

// Schema for required data sources in a template
const requiredDataSourceSchema = z.object({
	key: z.string(), // Provider key, e.g., "microsoft_graph", "linear", "github"
	name: z.string(), // Display name
	description: z.string().optional(),
	required: z.boolean().default(true),
});

// Schema for template connection requirements
const templateConnectionsSchema = z
	.object({
		integrations: z.array(requiredDataSourceSchema).default([]),
		mcpServers: z.array(requiredDataSourceSchema).default([]),
		workflows: z.array(requiredDataSourceSchema).default([]),
		agents: z.array(requiredDataSourceSchema).default([]),
		workspaces: z
			.object({
				enabled: z.boolean().default(false),
				description: z.string().optional(),
			})
			.optional(),
	})
	.optional();

const updateInputSchema = z.object({
	id: z.string(),
	name: z.string().min(1).max(255).optional(),
	description: z.string().max(2000).optional(),
	heroEmojis: z.array(z.string()).max(5).optional(),
	heroImageUrl: z.string().url().optional(),
	templateType: z
		.enum([
			"GANTT_CHART",
			"BURNDOWN",
			"SPRINT_COMPLETION",
			"FEATURE_SUMMARY",
			"MONTHLY_REPORT",
			"QUARTERLY_REPORT",
			"INTEGRATION_ACTIVITY",
			"CUSTOM",
		])
		.optional(),
	category: z.string().max(100).optional(),
	tags: z.array(z.string().max(50)).max(20).optional(),
	definition: z.any().optional(),
	// Connection requirements - what integrations/tools this template needs
	connections: templateConnectionsSchema,
	parameters: z.any().optional(),
	outputFormat: z
		.enum(["MARKDOWN", "HTML", "PDF", "EVIDENCE_EMBED", "MULTI_FORMAT"])
		.optional(),
	// Fabric AI configuration for Strategy → Context → Pattern enrichment
	fabricConfig: z
		.object({
			strategy: z.string().optional(),
			context: z.string().optional(),
			pattern: z.string().optional(),
			variables: z.record(z.string(), z.string()).optional(),
			enableAutoDetection: z.boolean().optional(),
		})
		.optional(),
	schedule: z.any().optional(),
	// Evidence.dev configuration
	evidenceProjectId: z.string().optional(),
	evidenceReportSlug: z.string().optional(),
	evidenceConfig: evidenceConfigSchema,
	isPublic: z.boolean().optional(),
});

export const updateTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_UPDATE))
	.input(updateInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			undefined,
			context.session,
		);

		// First get the template to check ownership
		const existing = await getReportTemplate({
			id: input.id,
			userId: context.user.id,
			organizationId,
		});

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report template not found",
			});
		}

		// Check ownership
		if (existing.scope === "USER" && existing.userId !== context.user.id) {
			throw new ORPCError("FORBIDDEN", {
				message: "You can only update your own templates",
			});
		}

		if (existing.scope === "ORGANIZATION" && existing.organizationId) {
			await requireOrganizationMembership(
				existing.organizationId,
				context.user.id,
				["admin", "owner"],
			);
		}

		if (existing.scope === "SYSTEM") {
			throw new ORPCError("FORBIDDEN", {
				message: "System templates cannot be modified",
			});
		}

		const template = await updateReportTemplate({
			id: input.id,
			name: input.name,
			description: input.description,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl,
			templateType: input.templateType,
			category: input.category,
			tags: input.tags,
			definition: input.definition as Prisma.InputJsonValue | undefined,
			connections: input.connections as Prisma.InputJsonValue | undefined,
			parameters: input.parameters as Prisma.InputJsonValue | undefined,
			outputFormat: input.outputFormat,
			fabricConfig: input.fabricConfig as
				| Prisma.InputJsonValue
				| undefined,
			schedule: input.schedule as Prisma.InputJsonValue | undefined,
			evidenceProjectId: input.evidenceProjectId,
			evidenceReportSlug: input.evidenceReportSlug,
			evidenceConfig: input.evidenceConfig as
				| Prisma.InputJsonValue
				| undefined,
			isPublic: input.isPublic,
		});

		return template;
	});
