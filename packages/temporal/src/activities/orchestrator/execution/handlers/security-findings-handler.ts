/**
 * Security Findings Handler
 *
 * Handles the `fabric_list_security_findings` tool: reads the attached
 * project's Security tab findings (security + accessibility scan results)
 * directly from the ScanFinding table and formats them for the agent.
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

const TOOL_NAME = "fabric_list_security_findings";
const MAX_FINDINGS_FOR_AGENT_CONTEXT = 50;
const MAX_FINDING_FIELD_CHARS = 200;

type FindingFilters = {
	category?: "SECURITY" | "ACCESSIBILITY";
	severity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
	status?: "OPEN" | "RESOLVED" | "DISMISSED";
};

export class SecurityFindingsHandler implements StepHandler {
	readonly name = "security-findings";
	readonly capabilities = ["security_findings"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return app === TOOL_NAME || executor === TOOL_NAME;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		try {
			const output = await this.listFindings(input);
			return { handled: true, output };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error("[SecurityFindingsHandler] failed:", error);
			return {
				handled: false,
				error: `Security findings lookup failed: ${message}`,
				shouldFallback: false,
			};
		}
	}

	private async listFindings(
		input: ExecuteStepInput,
	): Promise<ExecuteStepOutput> {
		const startTime = Date.now();
		const stepInputs = input.step.inputs as
			| Record<string, unknown>
			| undefined;
		const projectId = input.projectId;
		const filters = readFilters(stepInputs);

		const respond = (
			response: string,
			result: Record<string, unknown>,
			findingCount = 0,
		): ExecuteStepOutput => {
			const toolCalls: ToolCallRecord[] = [
				{
					id: `security-findings-${startTime}`,
					name: TOOL_NAME,
					args: { projectId, ...filters },
					result,
					status: "success",
					durationMs: Date.now() - startTime,
				},
			];
			return {
				outputs: { response, toolResults: toolCalls, findingCount },
				variables: {},
				toolCalls,
				response,
			};
		};

		if (!projectId) {
			return respond(
				"No project is attached to this conversation, so there are no Security tab findings to read. " +
					"Attach a project to enable security finding lookups.",
				{ message: "No project attached" },
			);
		}

		const { getLatestProjectScan, hasProjectAccess, listScanFindings } =
			await import("@repo/database");

		const hasAccess = await hasProjectAccess(
			projectId,
			input.userId,
			input.organizationId,
		);
		if (!hasAccess) {
			return respond(
				"You don't have access to this project's security findings.",
				{ message: "Access denied" },
			);
		}

		const latestCompleted = await getLatestProjectScan(projectId, {
			status: "COMPLETED",
		});
		if (!latestCompleted) {
			return respond(
				"This project has no completed security scans yet, so there are no findings to report. " +
					"A scan can be run from the project's Security tab.",
				{ findingCount: 0, message: "No completed scans" },
			);
		}

		const findings = await listScanFindings(projectId, {
			...filters,
			limit: MAX_FINDINGS_FOR_AGENT_CONTEXT + 1,
			scanId: latestCompleted.id,
			sort: "severity",
		});

		if (findings.length === 0) {
			return respond(
				`The latest completed scan has no findings${describeFilters(filters)}.`,
				{ findingCount: 0 },
			);
		}

		const hasMore = findings.length > MAX_FINDINGS_FOR_AGENT_CONTEXT;
		const shownFindings = findings.slice(0, MAX_FINDINGS_FOR_AGENT_CONTEXT);
		const response = formatFindings(
			shownFindings,
			latestCompleted.completedAt,
			hasMore,
		);
		return respond(
			response,
			{
				findingCount: shownFindings.length,
				hasMore,
				scanId: latestCompleted.id,
			},
			shownFindings.length,
		);
	}
}

function readFilters(
	stepInputs: Record<string, unknown> | undefined,
): FindingFilters {
	const filters: FindingFilters = {};
	const category = stepInputs?.category;
	const severity = stepInputs?.severity;
	const status = stepInputs?.status;
	if (category === "SECURITY" || category === "ACCESSIBILITY") {
		filters.category = category;
	}
	if (
		severity === "CRITICAL" ||
		severity === "HIGH" ||
		severity === "MEDIUM" ||
		severity === "LOW"
	) {
		filters.severity = severity;
	}
	if (status === "OPEN" || status === "RESOLVED" || status === "DISMISSED") {
		filters.status = status;
	}
	return filters;
}

function describeFilters(filters: FindingFilters): string {
	const parts = [
		filters.category?.toLowerCase(),
		filters.severity
			? `${filters.severity.toLowerCase()} severity`
			: undefined,
		filters.status?.toLowerCase(),
	].filter(Boolean);
	return parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
}

type FindingForDisplay = {
	severity: string;
	status: string;
	category: string;
	title: string;
	description: string;
	remediation: string;
	ruleSource: string;
	location: string | null;
	sourceUrl: string | null;
	story?: { identifier: string } | null;
};

function clipFindingField(value: string): string {
	return value.length > MAX_FINDING_FIELD_CHARS
		? `${value.slice(0, MAX_FINDING_FIELD_CHARS)}…`
		: value;
}

function formatFindings(
	findings: FindingForDisplay[],
	completedAt: Date | null,
	hasMore: boolean,
): string {
	const when = completedAt
		? ` (latest completed scan, ${completedAt.toISOString().slice(0, 10)})`
		: "";
	const shown = findings.length;
	const header = hasMore
		? `Showing the first ${shown} findings${when}. More findings exist; try narrowing by severity or status.`
		: `${shown} finding${shown === 1 ? "" : "s"}${when}:`;

	const blocks = findings.map((f, i) => {
		const lines = [
			`${i + 1}. [${f.severity} · ${f.status}] ${f.title}`,
			`   Category: ${f.category} · Rule: ${f.ruleSource}`,
		];
		if (f.location) {
			lines.push(`   Location: ${clipFindingField(f.location)}`);
		}
		if (f.description) {
			lines.push(`   Description: ${clipFindingField(f.description)}`);
		}
		if (f.remediation) {
			lines.push(`   Remediation: ${clipFindingField(f.remediation)}`);
		}
		if (f.story?.identifier) {
			lines.push(`   Linked work item: ${f.story.identifier}`);
		}
		if (f.sourceUrl) {
			lines.push(`   Link: ${clipFindingField(f.sourceUrl)}`);
		}
		return lines.join("\n");
	});

	return `${header}\n\n${blocks.join("\n\n")}`;
}
