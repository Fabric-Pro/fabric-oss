/**
 * Making a report from a template: the template checks, the connection
 * validation, the organization's and the project's defaults, and the write.
 * The "Use template" dialogs (`instances/create`) and Fabric Agent's
 * `fabric_create_project_report` both come here once they have authorized
 * the caller, so a report is made the same way whoever asks.
 */

import {
	createTemplateInstance,
	db,
	getReportTemplate,
	hasProjectKnowledgeSource,
	isFeatureEnabled,
	type reportEvidenceConfigSchema,
	reportScheduleInputSchema,
	resolveReportTemplateDefaults,
} from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import {
	mergeReportTemplateOverrides,
	templateParameterDefaults,
} from "@repo/database/prisma/queries/lib/report-template-defaults";
import { z } from "zod";
import { projectParameterDefaults } from "./project-parameter-defaults";
import { ReportGenerationError } from "./report-refusal";
import { templateScheduleForInheritance } from "./resolve-instance-schedule";
import { isOrganizationOwnedTemplate } from "./template-prompts";
import {
	type ReportDataSourceMeta,
	validateReportConnections,
} from "./validate-connections";

/** A new report's connections: what the caller bound for the template's data sources. */
export const reportInstanceConnectionsSchema = z.object({
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
});

type ReportCreation = {
	templateId: string;
	name: string;
	description?: string;
	projectId?: string;
	connections: z.infer<typeof reportInstanceConnectionsSchema>;
	schedule?: z.infer<typeof reportScheduleInputSchema>;
	reporting?: z.infer<typeof reportEvidenceConfigSchema>;
	/** Parameter values the caller chose, over every default. */
	parameterDefaults?: Record<string, string | number | boolean>;
};

/**
 * The parameter values a new report starts with before anyone chooses one.
 * Where the report suite is on, its template's values. A project's report takes
 * the parameters the project answers (its repository only where the suite is on),
 * then the organization's and the project's defaults for the template.
 */
export async function startingReportParameters({
	templateParameters,
	organizationId,
	projectId,
	overrideValues,
}: {
	templateParameters: unknown;
	organizationId: string;
	projectId?: string;
	overrideValues: Record<string, string | number | boolean>;
}): Promise<Record<string, string | number | boolean>> {
	const project = projectId
		? await db.project.findUnique({
				where: { id: projectId },
				select: {
					name: true,
					repositoryIntegrations: {
						where: { status: "ACTIVE" },
						orderBy: { createdAt: "asc" },
						take: 1,
						select: {
							repositoryOwner: true,
							repositoryName: true,
						},
					},
				},
			})
		: null;
	const reportSuite = await isFeatureEnabled(
		"REPORT_SUITE_V2",
		organizationId,
	);
	return {
		...(reportSuite
			? templateParameterDefaults(templateParameters)
			: undefined),
		...(project
			? projectParameterDefaults(templateParameters, {
					name: project.name,
					repository: reportSuite
						? project.repositoryIntegrations?.[0]
						: undefined,
				})
			: undefined),
		...overrideValues,
	};
}

/**
 * Makes the report for a caller already authorized to add reports here (the
 * organization role and, for a project report, Editor on the project). The
 * template must be one the caller may see, live, and given a project when it
 * reads Project knowledge.
 */
export async function createReportFromTemplate({
	caller,
	organizationId,
	creation,
}: {
	caller: { id: string };
	organizationId: string;
	creation: ReportCreation;
}) {
	const template = await getReportTemplate({
		id: creation.templateId,
		userId: caller.id,
		organizationId,
	});
	if (!template) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Report template not found or access denied",
		);
	}
	if (template.archivedAt) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"This report template is archived",
		);
	}
	if (
		hasProjectKnowledgeSource(template.definition) &&
		!(creation.reporting?.projectId ?? creation.projectId)
	) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Choose a project audience for Project knowledge",
		);
	}

	// Validate connections before storing. Pass the template's data sources so
	// a binding keyed by a data source id (e.g. "task-board") can self-heal via
	// its server provider (e.g. "fizzy").
	const templateDataSources = (
		template.definition as {
			dataSources?: ReportDataSourceMeta[];
		} | null
	)?.dataSources;
	const validation = await validateReportConnections(
		creation.connections,
		caller.id,
		organizationId,
		templateDataSources,
	);
	if (!validation.valid) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			`Invalid connections: ${validation.errors.join("; ")}`,
		);
	}

	// The organization's and the project's defaults for this template,
	// project over organization; what the caller sent wins over both. Without
	// the report suite a report starts as it did before defaults existed, even
	// where some are stored.
	const overrides = (await isFeatureEnabled(
		"REPORT_SUITE_V2",
		organizationId,
	))
		? await resolveReportTemplateDefaults({
				templateId: creation.templateId,
				organizationId,
				projectId: creation.projectId,
			})
		: mergeReportTemplateOverrides(null, null);
	const overrideSchedule = reportScheduleInputSchema.safeParse(
		overrides.schedule,
	);

	// Inherit the template's schedule when the instance create omits one — but only
	// from a template this owner actually owns (never SYSTEM/public → cross-tenant).
	const effectiveSchedule =
		creation.schedule ??
		(overrideSchedule.success ? overrideSchedule.data : undefined) ??
		templateScheduleForInheritance(template, caller.id, organizationId);

	const parameterDefaults = {
		...(await startingReportParameters({
			templateParameters: template.parameters,
			organizationId,
			projectId: creation.projectId,
			overrideValues: overrides.parameterDefaults,
		})),
		...creation.parameterDefaults,
	};
	const withContext =
		Object.keys(overrides.context).length > 0
			? {
					...creation.connections,
					context: {
						...overrides.context,
						...creation.connections.context,
					},
				}
			: creation.connections;
	// The default prompts, project over organization. The organization's own
	// template takes none of the organization's, since prompts stored before it
	// was published to the organization are stale; a project's still apply.
	const defaultPrompts = isOrganizationOwnedTemplate(template, organizationId)
		? overrides.projectPrompts
		: overrides.prompts;
	// The default report instructions, unless the creator wrote their own.
	// Marked as written by a person so the run adds them to the template's AI
	// tasks.
	const defaultUserPrompt = defaultPrompts?.userPrompt;
	const connections =
		defaultUserPrompt &&
		creation.connections.promptOverrideSource !== "user"
			? {
					...withContext,
					promptOverride: defaultUserPrompt,
					promptOverrideSource: "user",
				}
			: withContext;
	const defaultAiTasks = defaultPrompts?.aiTasks;
	const defaultSystemPrompt = defaultPrompts?.systemPrompt;

	return createTemplateInstance({
		templateId: creation.templateId,
		userId: caller.id,
		organizationId,
		projectId: creation.projectId,
		name: creation.name,
		description: creation.description,
		connections,
		parameterDefaults:
			Object.keys(parameterDefaults).length > 0
				? parameterDefaults
				: undefined,
		fabricConfig:
			creation.reporting || defaultAiTasks || defaultSystemPrompt
				? {
						...(creation.reporting
							? { reporting: creation.reporting }
							: {}),
						// The default AI task prompts and system prompt, which the
						// report page then shows as this report's own edits
						...(defaultAiTasks
							? { customAiTasks: defaultAiTasks }
							: {}),
						...(defaultSystemPrompt
							? { customSystemPrompt: defaultSystemPrompt }
							: {}),
					}
				: undefined,
		schedule: effectiveSchedule as Prisma.InputJsonValue | undefined,
		// CUSTOM iff the caller supplied an explicit per-instance schedule; otherwise the
		// instance follows the template (INHERITED), even when a schedule was inherited.
		scheduleMode: creation.schedule !== undefined ? "CUSTOM" : "INHERITED",
	});
}
