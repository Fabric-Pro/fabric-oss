/**
 * A project's reports as Fabric Agent reaches them (`fabric_list_project_reports`,
 * `fabric_generate_report`). The tools come through the MCP gateway rather than
 * an oRPC procedure, so each command makes the checks a procedure's middleware
 * would: the organization role, the project permission, and the report suite
 * being on for the organization. Generating reuses the Generate button's path
 * (`./report-generation`) and adds the readiness the report page shows, so a
 * run that cannot produce a report is refused before it spends credits.
 */

import {
	isFeatureEnabled,
	listTemplateInstances,
	publicReportParametersSchema,
} from "@repo/database";
import { type Permission, Permissions } from "@repo/permissions";
import { userHasProjectPermission } from "../../../orpc/procedures";
import {
	canGenerateReportInstance,
	GENERATE_OWNER_ONLY_MESSAGE,
	hasOrganizationReportPermission,
} from "./report-access";
import {
	loadGeneratableReport,
	ReportGenerationError,
	type ReportGenerationStart,
	startReportGeneration,
} from "./report-generation";
import { reportGenerationBlockedReason } from "./report-generation-readiness";

type ReportAgentActor = { userId: string; organizationId: string };

const AGENT_REPORT_LIST_LIMIT = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertAgentMayReachReports(
	actor: ReportAgentActor,
	permission: Permission,
): Promise<void> {
	if (!(await isFeatureEnabled("REPORT_SUITE_V2", actor.organizationId))) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"Reports are not available to Fabric Agent in this organization.",
		);
	}
	if (
		!(await hasOrganizationReportPermission(
			actor.organizationId,
			actor.userId,
			permission,
		))
	) {
		throw new ReportGenerationError(
			"FORBIDDEN",
			"Your organization role does not allow this report action.",
		);
	}
}

export async function listProjectReportsForAgent(
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
	const caller = { id: actor.userId };
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
	return {
		reports: result.instances.map((instance) => {
			const isOwner = canGenerateReportInstance(instance, caller);
			const generateBlockedReason = isOwner
				? reportGenerationBlockedReason(instance)
				: GENERATE_OWNER_ONLY_MESSAGE;
			const latest = instance.executions?.[0];
			return {
				id: instance.id,
				name: instance.name,
				description: instance.description,
				templateName: instance.template.name,
				isOwner,
				canGenerate: generateBlockedReason === null,
				generateBlockedReason,
				lastRunAt: instance.lastRunAt?.toISOString() ?? null,
				latestExecutionStatus: latest?.status ?? null,
				latestExecutionStartedAt:
					latest?.startedAt?.toISOString() ?? null,
			};
		}),
		total: result.total,
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
	await assertAgentMayReachReports(actor, Permissions.REPORT_EXECUTE);
	if (
		!publicReportParametersSchema.optional().safeParse(input.parameters)
			.success
	) {
		throw new ReportGenerationError(
			"BAD_REQUEST",
			"Report parameters are invalid or too large. Send an object of the report's own parameter names and values; an omitted parameter keeps the report's value.",
		);
	}
	const caller = { id: actor.userId };
	const instance = await loadGeneratableReport(
		input.instanceId,
		caller,
		actor.organizationId,
	);
	if (!(await mayReachProject(instance.projectId))) {
		throw new ReportGenerationError(
			"NOT_FOUND",
			"Template instance not found or access denied",
		);
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
