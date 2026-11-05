/**
 * A project's reports as Fabric Agent reaches them (`fabric_list_project_reports`,
 * `fabric_list_report_templates`, `fabric_create_project_report`,
 * `fabric_generate_report`, `fabric_get_report_content`,
 * `fabric_update_report_prompt`). The tools come through the MCP gateway rather
 * than an oRPC procedure, so each command makes the checks a procedure's
 * middleware would: the organization role, the project permission, and the
 * report suite being on for the organization. Creating reuses the "Use template"
 * dialog's path (`./report-creation`). Generating reuses the Generate
 * button's path (`./report-generation`) and adds the readiness the report page
 * shows, so a run that cannot produce a report is refused before it spends
 * credits. Changing a report's instructions makes the report page's save
 * checks and writes the same fields it does.
 */

import {
	canAccessReportInstance,
	db,
	getReportTemplate,
	getTemplateInstance,
	getTemplateInstanceArtifact,
	hasProjectKnowledgeSource,
	isFeatureEnabled,
	listReportTemplates,
	listTemplateInstances,
	type Prisma,
	publicReportParametersSchema,
	reportEvidenceConfigSchema,
	updateTemplateInstance,
} from "@repo/database";
import {
	CUSTOM_REPORT_TEMPLATE_NAME,
	isConnectorFreeReportDefinition,
} from "@repo/database/prisma/queries/lib/report-template-catalog";
import { type Permission, Permissions } from "@repo/permissions";
import {
	applyReportAiTaskOverrides,
	type ReportAiTask,
	reportAiTaskKey,
} from "@repo/temporal/report-ai-tasks";
import { redactMessage } from "@repo/temporal/report-diagnostics";
import { userHasProjectPermission } from "../../../orpc/procedures";
import {
	canCreateProjectReport,
	canEditReportInstance,
	canGenerateReportInstance,
	canReachProjectReports,
	mayUseReportPermission,
	type ReportCaller,
	reportGenerationChecker,
	reportGenerationRefusal,
} from "./report-access";
import {
	createReportFromTemplate,
	reportInstanceConnectionsSchema,
} from "./report-creation";
import {
	loadGeneratableReport,
	type ReportGenerationStart,
	startReportGeneration,
} from "./report-generation";
import { reportGenerationBlockedReason } from "./report-generation-readiness";
import { projectReportConnections } from "./report-project-connection";
import { ReportGenerationError } from "./report-refusal";

type ReportAgentActor = { userId: string; organizationId: string };

const AGENT_REPORT_LIST_LIMIT = 50;

const REPORT_NOT_FOUND_MESSAGE = "Template instance not found or access denied";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The caller as the report rules see them, with their real platform role: the
 * gateway's session names only the user, and a system admin who is a member
 * holds the same reports through the agent as on the page.
 */
async function assertAgentMayReachReports(
	actor: ReportAgentActor,
	permission: Permission,
): Promise<ReportCaller> {
	if (!(await isFeatureEnabled("REPORT_SUITE_V2", actor.organizationId))) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"Reports are not available to Fabric Agent in this organization.",
		);
	}
	const user = await db.user.findUnique({
		where: { id: actor.userId },
		select: { role: true },
	});
	const caller = { id: actor.userId, role: user?.role };
	if (
		!(await mayUseReportPermission(
			actor.organizationId,
			caller,
			permission,
		))
	) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"Your organization role does not allow this report action.",
		);
	}
	return caller;
}

export async function listProjectReportsForAgent(
	actor: ReportAgentActor,
	input: { projectId: string; search?: string; limit?: number },
) {
	const caller = await assertAgentMayReachReports(
		actor,
		Permissions.REPORT_READ,
	);
	if (
		!(await userHasProjectPermission({
			userId: actor.userId,
			projectId: input.projectId,
			permission: Permissions.REPORT_READ,
		})) ||
		!(await canReachProjectReports(input.projectId, caller))
	) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Project not found or access denied",
		);
	}
	const result = await listTemplateInstances({
		userId: actor.userId,
		organizationId: actor.organizationId,
		projectId: input.projectId,
		status: ["ACTIVE", "DRAFT", "PENDING"],
		search: input.search,
		limit: Math.min(
			Math.max(Math.trunc(input.limit ?? 20), 1),
			AGENT_REPORT_LIST_LIMIT,
		),
	});
	const mayGenerate = reportGenerationChecker(caller);
	return {
		reports: await Promise.all(
			result.instances.map(async (instance) => {
				const generateBlockedReason = (await mayGenerate(instance))
					? reportGenerationBlockedReason(instance)
					: reportGenerationRefusal(instance, caller);
				const latest = instance.executions?.[0];
				return {
					id: instance.id,
					name: instance.name,
					description: instance.description,
					templateName: instance.template.name,
					isOwner: instance.userId === caller.id,
					canGenerate: generateBlockedReason === null,
					generateBlockedReason,
					lastRunAt: instance.lastRunAt?.toISOString() ?? null,
					latestExecutionStatus: latest?.status ?? null,
					latestExecutionStartedAt:
						latest?.startedAt?.toISOString() ?? null,
					latestExecutionFailureReason:
						latest?.status === "FAILED" && latest.error
							? redactMessage(latest.error)
							: null,
				};
			}),
		),
		total: result.total,
	};
}

/** A template's parameters as an agent fills them: each key, its label, whether a run needs it. */
function templateParameterSummary(parameters: unknown) {
	const properties =
		isRecord(parameters) && isRecord(parameters.properties)
			? parameters.properties
			: {};
	const required =
		isRecord(parameters) && Array.isArray(parameters.required)
			? parameters.required
			: [];
	return Object.entries(properties).map(([key, property]) => ({
		key,
		title:
			isRecord(property) && typeof property.title === "string"
				? property.title
				: key,
		required: required.includes(key),
	}));
}

/**
 * The templates a project's new report can start from: the same catalog
 * `templates/list` shows where the report suite is on (unproven system and
 * public templates and archived ones left out).
 */
export async function listReportTemplatesForAgent(
	actor: ReportAgentActor,
	input: { projectId: string; search?: string; limit?: number },
) {
	await assertAgentMayReachReports(actor, Permissions.REPORT_READ);
	if (
		!(await userHasProjectPermission({
			userId: actor.userId,
			projectId: input.projectId,
			permission: Permissions.REPORT_READ,
		}))
	) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Project not found or access denied",
		);
	}
	const { templates, total } = await listReportTemplates({
		userId: actor.userId,
		organizationId: actor.organizationId,
		search: input.search,
		limit: Math.min(
			Math.max(Math.trunc(input.limit ?? 20), 1),
			AGENT_REPORT_LIST_LIMIT,
		),
	});
	return {
		templates: templates.map((template) => ({
			id: template.id,
			name: template.name,
			description: template.description,
			category: template.category,
			needsConnection: !isConnectorFreeReportDefinition(
				template.definition,
			),
			parameters: templateParameterSummary(template.parameters),
		})),
		total,
	};
}

/**
 * The system "Custom report" template, which follows the report's instructions:
 * what a report made from a prompt alone starts from. It is looked up whether or
 * not a run has proven it, since the caller did not pick it from the catalog.
 */
async function customReportTemplateId(
	actor: ReportAgentActor,
): Promise<string> {
	const { templates } = await listReportTemplates({
		userId: actor.userId,
		organizationId: actor.organizationId,
		scope: "SYSTEM",
		search: CUSTOM_REPORT_TEMPLATE_NAME,
		includeUnproven: true,
		limit: 10,
	});
	const custom = templates.find(
		(template) => template.name === CUSTOM_REPORT_TEMPLATE_NAME,
	);
	if (!custom) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"The Custom report template is not available. fabric_list_report_templates lists the ones this project can use; send one as templateId.",
		);
	}
	return custom.id;
}

/**
 * Makes a project report from a template, with the "Use template" dialog's
 * checks and write (`./report-creation`): the organization role adds reports,
 * the caller may add them to this project, and `mayReachProject` lets the
 * session reach it. A `prompt` becomes the report's own instructions; with no
 * `templateId` it starts from the Custom report template. The report starts on
 * the project's own connection and board when that connection is the caller's
 * (`./report-project-connection`); otherwise it starts unconnected and says what
 * to connect on its page. Nothing runs.
 */
export async function createProjectReportForAgent(
	actor: ReportAgentActor,
	input: {
		projectId: string;
		templateId?: string;
		prompt?: string;
		name?: string;
		parameters?: Record<string, string | number | boolean>;
	},
	mayReachProject: (projectId: string | null) => Promise<boolean>,
) {
	const caller = await assertAgentMayReachReports(
		actor,
		Permissions.REPORT_CREATE,
	);
	const prompt = input.prompt?.trim();
	if (!input.templateId && !prompt) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Send a prompt saying what the report should cover, a templateId from fabric_list_report_templates, or both.",
		);
	}
	if (
		!(await mayReachProject(input.projectId)) ||
		!(await userHasProjectPermission({
			userId: actor.userId,
			projectId: input.projectId,
			permission: Permissions.REPORT_READ,
		}))
	) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Project not found or access denied",
		);
	}
	if (!(await canCreateProjectReport(input.projectId, caller))) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"You need at least the Editor role on this project to add a report",
		);
	}
	if (
		!publicReportParametersSchema.optional().safeParse(input.parameters)
			.success
	) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Report parameters are invalid or too large. Send an object of the template's own parameter names and values.",
		);
	}
	const template = await getReportTemplate({
		id: input.templateId ?? (await customReportTemplateId(actor)),
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!template) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Report template not found or access denied. fabric_list_report_templates lists the ones this project can use.",
		);
	}
	const connections = reportInstanceConnectionsSchema.parse(
		(await projectReportConnections({
			projectId: input.projectId,
			definition: template.definition,
			userId: actor.userId,
			organizationId: actor.organizationId,
		})) ?? {},
	);
	const instance = await createReportFromTemplate({
		caller,
		organizationId: actor.organizationId,
		creation: {
			templateId: template.id,
			name: input.name?.trim() || template.name,
			projectId: input.projectId,
			// Marked as a person's, as the report page saves them, so a run adds
			// them to the template's AI tasks.
			connections: prompt
				? {
						...connections,
						promptOverride: prompt,
						promptOverrideSource: "user",
					}
				: connections,
			parameterDefaults: input.parameters,
			// As the dialog does: a report on Project knowledge reads this
			// project's sources and is read by this project's members.
			reporting: hasProjectKnowledgeSource(template.definition)
				? reportEvidenceConfigSchema.parse({
						version: 1,
						period: "weekly",
						projectId: input.projectId,
					})
				: undefined,
		},
	});
	const generateBlockedReason = reportGenerationBlockedReason({
		...instance,
		template,
	});
	return {
		instanceId: instance.id,
		name: instance.name,
		projectId: input.projectId,
		templateName: template.name,
		canGenerate: generateBlockedReason === null,
		generateBlockedReason,
		message: generateBlockedReason
			? `Created, but it cannot be generated yet. ${generateBlockedReason} The person finishes this on the report's page.`
			: "Created. Call fabric_generate_report next if the person wants a run now.",
	};
}

/**
 * Generates a report the caller owns. `mayReachProject` is the caller's own
 * limit on which project a report may belong to (a session opened from one
 * project reaches that project alone).
 */
export async function generateReportForAgent(
	actor: ReportAgentActor & {
		/** The gateway's answer: did a person start this run? */
		planEligible: boolean;
	},
	input: {
		instanceId: string;
		parameters?: Record<string, unknown>;
		idempotencyKey?: string;
	},
	mayReachProject: (projectId: string | null) => Promise<boolean>,
): Promise<ReportGenerationStart> {
	const caller = await assertAgentMayReachReports(
		actor,
		Permissions.REPORT_EXECUTE,
	);
	if (
		!publicReportParametersSchema.optional().safeParse(input.parameters)
			.success
	) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Report parameters are invalid or too large. Send an object of the report's own parameter names and values; an omitted parameter keeps the report's value.",
		);
	}
	const instance = await loadGeneratableReport(
		input.instanceId,
		caller,
		actor.organizationId,
	);
	if (!(await mayReachProject(instance.projectId))) {
		throw new ReportGenerationError("NOT_FOUND", REPORT_NOT_FOUND_MESSAGE);
	}
	const blockedReason = reportGenerationBlockedReason({
		...instance,
		parameterDefaults: {
			...(isRecord(instance.parameterDefaults)
				? instance.parameterDefaults
				: {}),
			...input.parameters,
		},
	});
	if (blockedReason) {
		throw new ReportGenerationError("BAD_REQUEST", blockedReason);
	}
	return startReportGeneration({
		instance,
		caller,
		organizationId: actor.organizationId,
		parameters: input.parameters,
		idempotencyKey: input.idempotencyKey,
		planEligible: actor.planEligible,
	});
}

/**
 * The most of a report's content one read returns, in characters: the
 * gateway's default page of a long Context or instruction body.
 */
export const AGENT_REPORT_CONTENT_MAX_CHARS = 50_000;

/** The artifact types whose content is the report's text, as the report preview reads them. */
const READABLE_ARTIFACT_TYPES: ReadonlySet<string> = new Set([
	"MARKDOWN",
	"HTML",
]);

type ReachableReport = NonNullable<
	Awaited<ReturnType<typeof getTemplateInstance>>
>;

function isJsonObject(
	value: Prisma.JsonValue | undefined,
): value is Prisma.JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The report, when the caller may see it and `mayReachProject` lets the
 * session reach its project; otherwise the refusal a missing report gets, so
 * a report the caller may not see is not told apart from one that is not there.
 */
async function loadReachableReport(
	actor: ReportAgentActor,
	instanceId: string,
	mayReachProject: (projectId: string | null) => Promise<boolean>,
): Promise<ReachableReport> {
	const instance = await getTemplateInstance({
		id: instanceId,
		userId: actor.userId,
		organizationId: actor.organizationId,
	});
	if (!instance || !(await mayReachProject(instance.projectId))) {
		throw new ReportGenerationError("NOT_FOUND", REPORT_NOT_FOUND_MESSAGE);
	}
	return instance;
}

function templateUserPrompt(definition: Prisma.JsonValue): string {
	return isJsonObject(definition) && typeof definition.userPrompt === "string"
		? definition.userPrompt
		: "";
}

/**
 * The instructions the report runs with: the ones a person wrote for it
 * (`promptOverrideSource: "user"`), else its template's. An unmarked override
 * is a copy of an older template prompt, which a run does not add to its tasks.
 */
function reportInstructions(instance: {
	connections: Prisma.JsonValue;
	template: { definition: Prisma.JsonValue };
}): { instructions: string; instructionsSource: "report" | "template" } {
	const connections: Prisma.JsonObject = isJsonObject(instance.connections)
		? instance.connections
		: {};
	const override =
		typeof connections.promptOverride === "string"
			? connections.promptOverride.trim()
			: "";
	return override && connections.promptOverrideSource === "user"
		? { instructions: override, instructionsSource: "report" }
		: {
				instructions: templateUserPrompt(instance.template.definition),
				instructionsSource: "template",
			};
}

/** The report's own AI task prompts, keyed as the report page saves them. */
function customAiTaskPrompts(
	fabricConfig: Prisma.JsonValue,
): Record<string, string> {
	const tasks: Prisma.JsonObject =
		isJsonObject(fabricConfig) && isJsonObject(fabricConfig.customAiTasks)
			? fabricConfig.customAiTasks
			: {};
	return Object.fromEntries(
		Object.entries(tasks).filter(
			(entry): entry is [string, string] =>
				typeof entry[1] === "string" && entry[1].trim().length > 0,
		),
	);
}

/**
 * The template's AI tasks as this report's next run takes them: the report's own
 * task prompts over the template's, with its instructions added to each, by the
 * same helper the run uses.
 */
function effectiveReportTasks(instance: {
	connections: Prisma.JsonValue;
	fabricConfig: Prisma.JsonValue;
	template: { definition: Prisma.JsonValue };
}) {
	const definition = isJsonObject(instance.template.definition)
		? instance.template.definition
		: {};
	const agents = Array.isArray(definition.aiAgents)
		? definition.aiAgents
		: [];
	// Every entry stays in place, since a task's key can be its index.
	const tasks = agents.map((agent): ReportAiTask => {
		const task: Prisma.JsonObject = isJsonObject(agent) ? agent : {};
		return {
			agentId: typeof task.agentId === "string" ? task.agentId : "",
			task: typeof task.task === "string" ? task.task : "",
			outputVariable:
				typeof task.outputVariable === "string"
					? task.outputVariable
					: undefined,
		};
	});
	const customAiTasks = customAiTaskPrompts(instance.fabricConfig);
	const connections: Prisma.JsonObject = isJsonObject(instance.connections)
		? instance.connections
		: {};
	return applyReportAiTaskOverrides(tasks, {
		customAiTasks,
		promptOverride:
			typeof connections.promptOverride === "string"
				? connections.promptOverride
				: undefined,
		promptOverrideSource:
			typeof connections.promptOverrideSource === "string"
				? connections.promptOverrideSource
				: undefined,
		templateUserPrompt: templateUserPrompt(instance.template.definition),
	}).map((task, index) => ({
		key: reportAiTaskKey(task, index),
		task: task.task,
		customized: Boolean(customAiTasks[reportAiTaskKey(task, index)]),
	}));
}

/**
 * The text of the report's newest completed run the caller may open, among
 * the runs the report page lists, cut to {@link AGENT_REPORT_CONTENT_MAX_CHARS}.
 * A run's first readable artifact is its report, as in the report preview.
 */
async function latestReportContent(
	instance: ReachableReport,
	actor: ReportAgentActor,
) {
	for (const execution of instance.executions) {
		if (execution.status !== "COMPLETED") {
			continue;
		}
		const readable = execution.artifacts.filter((artifact) =>
			READABLE_ARTIFACT_TYPES.has(artifact.artifactType),
		);
		const candidate = readable[readable.length - 1];
		if (!candidate) {
			continue;
		}
		const artifact = await getTemplateInstanceArtifact(candidate.id, {
			userId: actor.userId,
			organizationId: actor.organizationId,
		});
		if (typeof artifact?.content !== "string") {
			continue;
		}
		const chars = Array.from(artifact.content);
		const truncated = chars.length > AGENT_REPORT_CONTENT_MAX_CHARS;
		return {
			executionId: execution.id,
			completedAt: execution.completedAt?.toISOString() ?? null,
			artifactName: artifact.name,
			artifactType: artifact.artifactType,
			content: truncated
				? chars.slice(0, AGENT_REPORT_CONTENT_MAX_CHARS).join("")
				: artifact.content,
			truncated,
			totalChars: chars.length,
		};
	}
	return null;
}

/**
 * What the report says now and what made it: its instructions, its own AI
 * task prompts, the tasks as its next run takes them, and the text of its newest
 * completed run. Reads need the access `fabric_list_project_reports` needs for
 * the report's project.
 */
export async function getReportContentForAgent(
	actor: ReportAgentActor,
	input: { instanceId: string },
	mayReachProject: (projectId: string | null) => Promise<boolean>,
) {
	const caller = await assertAgentMayReachReports(
		actor,
		Permissions.REPORT_READ,
	);
	const instance = await loadReachableReport(
		actor,
		input.instanceId,
		mayReachProject,
	);
	if (
		instance.projectId &&
		!(await userHasProjectPermission({
			userId: actor.userId,
			projectId: instance.projectId,
			permission: Permissions.REPORT_READ,
		}))
	) {
		throw new ReportGenerationError("NOT_FOUND", REPORT_NOT_FOUND_MESSAGE);
	}
	const latestRun = await latestReportContent(instance, actor);
	return {
		instanceId: instance.id,
		name: instance.name,
		templateName: instance.template.name,
		...reportInstructions(instance),
		customAiTasks: customAiTaskPrompts(instance.fabricConfig),
		tasks: effectiveReportTasks(instance),
		canEditInstructions: await canEditReportInstance(instance, caller),
		latestRun,
		message: latestRun
			? latestRun.truncated
				? `latestRun.content holds the first ${AGENT_REPORT_CONTENT_MAX_CHARS} of the run's ${latestRun.totalChars} characters.`
				: "latestRun.content holds the latest run's full text."
			: "This report has no completed run with readable content yet. fabric_generate_report produces one.",
	};
}

/**
 * The report's connections with new instructions, as the report page saves
 * them: text a person wrote is marked `promptOverrideSource: "user"`, and the
 * template's own prompt is no override at all, so the report follows its
 * template again.
 */
function connectionsWithInstructions(
	connections: Prisma.JsonValue,
	userPrompt: string,
	templatePrompt: string,
): Prisma.InputJsonObject {
	const stored: Prisma.JsonObject = isJsonObject(connections)
		? connections
		: {};
	const {
		promptOverride: _promptOverride,
		promptOverrideSource: _promptOverrideSource,
		...rest
	} = stored;
	return userPrompt === templatePrompt.trim()
		? rest
		: { ...rest, promptOverride: userPrompt, promptOverrideSource: "user" };
}

/**
 * Replaces a report's instructions, with the report page's save checks: the
 * caller is a member, may edit this report, and may write to its project, which
 * an organization Viewer holds only through an Editor project row. Nothing runs;
 * the next run adds the new instructions to each of the template's AI tasks.
 */
export async function updateReportPromptForAgent(
	actor: ReportAgentActor,
	input: { instanceId: string; userPrompt: string },
	mayReachProject: (projectId: string | null) => Promise<boolean>,
) {
	const caller = await assertAgentMayReachReports(
		actor,
		Permissions.REPORT_READ,
	);
	const instance = await loadReachableReport(
		actor,
		input.instanceId,
		mayReachProject,
	);
	if (
		!(await canEditReportInstance(instance, caller)) ||
		!(await canAccessReportInstance(
			instance,
			{ userId: actor.userId, organizationId: actor.organizationId },
			undefined,
			true,
		))
	) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"You do not have permission to change this report",
		);
	}
	const userPrompt = input.userPrompt.trim();
	if (!userPrompt) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"userPrompt is empty. Send the report's complete new instructions.",
		);
	}
	const connections = connectionsWithInstructions(
		instance.connections,
		userPrompt,
		templateUserPrompt(instance.template.definition),
	);
	await updateTemplateInstance({ id: instance.id, connections });
	const followsTemplate = !("promptOverride" in connections);
	return {
		instanceId: instance.id,
		instructions: userPrompt,
		instructionsSource: followsTemplate ? "template" : "report",
		message: [
			followsTemplate
				? "Saved. These are the template's own instructions, so the report follows its template again."
				: "Saved. The report's next run uses these instructions.",
			(await canGenerateReportInstance(instance, caller))
				? "Call fabric_generate_report next if the person wants a new run now."
				: "Only the report's owner can generate it, while their project role allows it, so ask them for a new run.",
		].join(" "),
	};
}
