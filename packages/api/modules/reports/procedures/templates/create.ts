import { createReportTemplate } from "@repo/database";
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

const createInputSchema = z.object({
	name: z.string().min(1).max(255),
	description: z.string().max(2000).optional(),
	heroEmojis: z.array(z.string()).max(5).optional(),
	heroImageUrl: z.string().url().optional(),
	templateType: z.enum([
		"GANTT_CHART",
		"BURNDOWN",
		"SPRINT_COMPLETION",
		"FEATURE_SUMMARY",
		"MONTHLY_REPORT",
		"QUARTERLY_REPORT",
		"INTEGRATION_ACTIVITY",
		"CUSTOM",
	]),
	category: z.string().max(100).optional(),
	tags: z.array(z.string().max(50)).max(20).optional(),
	// Use any for JSON fields - runtime validation happens in database layer
	definition: z.any(),
	// Connection requirements - what integrations/tools this template needs
	connections: templateConnectionsSchema,
	parameters: z.any().optional(),
	outputFormat: z
		.enum(["MARKDOWN", "HTML", "PDF", "EVIDENCE_EMBED", "MULTI_FORMAT"])
		.default("MARKDOWN"),
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
	organizationId: z.string().nullable().optional(),
	scope: z.enum(["SYSTEM", "ORGANIZATION", "USER"]).default("USER"),
	isPublic: z.boolean().default(false),
});

export const createTemplateProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.REPORT_CREATE))
	.input(createInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Verify organization membership if creating org-scoped template
		if (input.scope === "ORGANIZATION" && organizationId) {
			await requireOrganizationMembership(
				organizationId,
				context.user.id,
			);
		}

		const template = await createReportTemplate({
			name: input.name,
			description: input.description,
			heroEmojis: input.heroEmojis,
			heroImageUrl: input.heroImageUrl,
			templateType: input.templateType,
			category: input.category,
			tags: input.tags,
			definition: input.definition as Prisma.InputJsonValue,
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
			userId: context.user.id,
			organizationId,
			scope: input.scope,
			isPublic: input.isPublic,
		});

		return template;
	});
