/**
 * Fabric MCP Gateway — report tools: list a project's reports and the templates
 * a new one can start from, create one, generate one, read what one says, and
 * change its instructions. Each tool is the API's own command
 * (`reports/lib/report-agent-commands`), which makes the checks the report
 * procedures make; this file maps the tool arguments onto it and its refusals
 * onto results. Creating adds a report to the project, generating spends the
 * owner's AI credits and a change of instructions alters every later run, so
 * all three definitions ask the person on every call.
 */

import {
	FABRIC_REPORT_TOOL_DEFINITIONS,
	REPORT_PROMPT_MAX_CHARS,
} from "@repo/temporal/fabric-report-tool-definitions";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type {
	GatewayCredential,
	GatewaySession,
	ToolCallResult,
} from "../types";
import { organizationSlug } from "./frame-context";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

type ProjectAccess = (
	projectId: string,
	session: GatewaySession,
) => Promise<{ organizationId: string | null } | null>;

const ListArgs = z.object({
	projectId: z.string().trim().min(1).max(128),
	search: z.string().max(200).optional(),
	limit: z.number().optional(),
});

const InstanceArgs = z.object({
	instanceId: z.string().trim().min(1).max(128),
});

const GenerateArgs = InstanceArgs.extend({
	parameters: z.record(z.string(), z.unknown()).optional(),
	idempotencyKey: z.string().uuid().optional(),
});

const UpdatePromptArgs = InstanceArgs.extend({
	userPrompt: z.string().trim().min(1).max(REPORT_PROMPT_MAX_CHARS),
});

const CreateArgs = z.object({
	projectId: z.string().trim().min(1).max(128),
	templateId: z.string().trim().min(1).max(128).optional(),
	prompt: z.string().trim().min(1).max(REPORT_PROMPT_MAX_CHARS).optional(),
	name: z.string().trim().min(1).max(255).optional(),
	parameters: z
		.record(
			z.string(),
			z.union([z.string().max(2000), z.number(), z.boolean()]),
		)
		.optional(),
});

const INVALID_ARGS_MESSAGE =
	"Invalid report tool arguments. Use this tool's declared input schema.";

const ORGANIZATION_REQUIRED_MESSAGE =
	"Reports belong to an organization. Switch to an organization and try again.";

async function asReportCommand(
	run: () => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
	const { ReportGenerationError } = await import(
		"@repo/api/modules/reports/lib/report-refusal"
	);
	try {
		return await run();
	} catch (error) {
		if (error instanceof ReportGenerationError) {
			return errorResult(error.message, { code: error.code });
		}
		throw error;
	}
}

async function handleListProjectReports(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = ListArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const access = await authorize(parsed.data.projectId, session);
	if (!access?.organizationId) {
		return errorResult("Project not found or access denied", {
			code: "NOT_FOUND",
		});
	}
	const organizationId = access.organizationId;
	return asReportCommand(async () => {
		const { listProjectReportsForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		return jsonResult(
			await listProjectReportsForAgent(
				{ userId: session.userId, organizationId },
				parsed.data,
			),
		);
	});
}

/**
 * Whether a person started the run, so its AI steps may use their own ChatGPT
 * plan. A browser session is the person at the keyboard. The agent runtime is
 * Fabric Agent in the person's chat: this tool asks them on every call, and a
 * run nobody can answer never reaches it. Any key or OAuth token is an
 * unattended caller, whose run stays on the organization's shared plans.
 */
function startedByPerson(credential: GatewayCredential): boolean {
	switch (credential) {
		case "session":
		case "service":
			return true;
		case "organization-key":
		case "personal-key":
		case "oauth":
			return false;
		default: {
			const unhandled: never = credential;
			throw new Error(`Unhandled gateway credential: ${unhandled}`);
		}
	}
}

/**
 * Whether the session may reach a report's project, which the command asks
 * once it has found the report: the project-access helper for a project
 * report, which keeps a project-bound session to its project, and the
 * session's own binding for a report that has no project.
 */
function reportProjectReach(
	session: GatewaySession,
	authorize: ProjectAccess,
	organizationId: string,
): (projectId: string | null) => Promise<boolean> {
	return async (projectId) =>
		projectId === null
			? sessionMayReachProject(session, null)
			: (await authorize(projectId, session))?.organizationId ===
				organizationId;
}

async function handleGenerateReport(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = GenerateArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const organizationId = session.organizationId;
	if (!organizationId) {
		return errorResult(ORGANIZATION_REQUIRED_MESSAGE);
	}
	return asReportCommand(async () => {
		const { generateReportForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		const started = await generateReportForAgent(
			{
				userId: session.userId,
				organizationId,
				planEligible: startedByPerson(session.credential),
			},
			parsed.data,
			reportProjectReach(session, authorize, organizationId),
		);
		return jsonResult({
			...started,
			instanceId: parsed.data.instanceId,
			message: started.startConfirmed
				? "The report is generating. Poll fabric_list_project_reports for its latest run status; do not call this tool again for this run."
				: `${started.message}. Do not call this tool again for this run; poll fabric_list_project_reports.`,
		});
	});
}

async function handleListReportTemplates(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = ListArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const access = await authorize(parsed.data.projectId, session);
	if (!access?.organizationId) {
		return errorResult("Project not found or access denied", {
			code: "NOT_FOUND",
		});
	}
	const organizationId = access.organizationId;
	return asReportCommand(async () => {
		const { listReportTemplatesForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		return jsonResult(
			await listReportTemplatesForAgent(
				{ userId: session.userId, organizationId },
				parsed.data,
			),
		);
	});
}

async function handleCreateProjectReport(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = CreateArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const organizationId = session.organizationId;
	if (!organizationId) {
		return errorResult(ORGANIZATION_REQUIRED_MESSAGE);
	}
	return asReportCommand(async () => {
		const { createProjectReportForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		const created = await createProjectReportForAgent(
			{ userId: session.userId, organizationId },
			parsed.data,
			reportProjectReach(session, authorize, organizationId),
		);
		const slug = await organizationSlug(organizationId);
		return jsonResult({
			...created,
			...(slug
				? {
						reportUrl: `/app/${slug}/report-templates/instances/${created.instanceId}`,
					}
				: {}),
		});
	});
}

async function handleGetReportContent(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = InstanceArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const organizationId = session.organizationId;
	if (!organizationId) {
		return errorResult(ORGANIZATION_REQUIRED_MESSAGE);
	}
	return asReportCommand(async () => {
		const { getReportContentForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		return jsonResult(
			await getReportContentForAgent(
				{ userId: session.userId, organizationId },
				parsed.data,
				reportProjectReach(session, authorize, organizationId),
			),
		);
	});
}

async function handleUpdateReportPrompt(
	args: Record<string, unknown>,
	session: GatewaySession,
	authorize: ProjectAccess,
): Promise<ToolCallResult> {
	const parsed = UpdatePromptArgs.safeParse(args);
	if (!parsed.success) {
		return errorResult(INVALID_ARGS_MESSAGE, { code: "INVALID_INPUT" });
	}
	const organizationId = session.organizationId;
	if (!organizationId) {
		return errorResult(ORGANIZATION_REQUIRED_MESSAGE);
	}
	return asReportCommand(async () => {
		const { updateReportPromptForAgent } = await import(
			"@repo/api/modules/reports/lib/report-agent-commands"
		);
		return jsonResult(
			await updateReportPromptForAgent(
				{ userId: session.userId, organizationId },
				parsed.data,
				reportProjectReach(session, authorize, organizationId),
			),
		);
	});
}

export function createReportTools(authorize: ProjectAccess) {
	const handlers = new Map<string, PlatformToolHandler>([
		[
			"fabric_list_project_reports",
			(args, session) =>
				handleListProjectReports(args, session, authorize),
		],
		[
			"fabric_list_report_templates",
			(args, session) =>
				handleListReportTemplates(args, session, authorize),
		],
		[
			"fabric_create_project_report",
			(args, session) =>
				handleCreateProjectReport(args, session, authorize),
		],
		[
			"fabric_generate_report",
			(args, session) => handleGenerateReport(args, session, authorize),
		],
		[
			"fabric_get_report_content",
			(args, session) => handleGetReportContent(args, session, authorize),
		],
		[
			"fabric_update_report_prompt",
			(args, session) =>
				handleUpdateReportPrompt(args, session, authorize),
		],
	]);
	return toolFamily(FABRIC_REPORT_TOOL_DEFINITIONS, handlers);
}
