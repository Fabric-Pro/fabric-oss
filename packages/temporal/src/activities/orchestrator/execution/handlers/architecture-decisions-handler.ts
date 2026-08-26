/**
 * Architecture Decisions Handler
 *
 * Handles the `fabric_list_architecture_decisions` tool: reads the attached
 * project's Decisions tab entries (Architecture Decision Log) directly from
 * the ArchitectureDecision table and formats them for the agent.
 *
 * Unlike project_rag_query (which searches by semantic similarity),
 * this tool reads all current decisions directly so the agent always sees
 * their live status (PROPOSED/ACCEPTED/SUPERSEDED/etc.) and endorsement state,
 * regardless of embedding freshness or search relevance.
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

const TOOL_NAME = "fabric_list_architecture_decisions";

type DecisionFilters = {
	status?: "PROPOSED" | "ACCEPTED" | "SUPERSEDED" | "DEPRECATED" | "REJECTED";
	domain?: "infra" | "data" | "ai" | "security" | "frontend" | "platform";
};

export class ArchitectureDecisionsHandler implements StepHandler {
	readonly name = "architecture-decisions";
	readonly capabilities = ["architecture_decisions"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return app === TOOL_NAME || executor === TOOL_NAME;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		try {
			const output = await this.listDecisions(input);
			return { handled: true, output };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error("[ArchitectureDecisionsHandler] failed:", error);
			return {
				handled: false,
				error: `Architecture decisions lookup failed: ${message}`,
				shouldFallback: false,
			};
		}
	}

	private async listDecisions(
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
			decisionCount = 0,
		): ExecuteStepOutput => {
			const toolCalls: ToolCallRecord[] = [
				{
					id: `architecture-decisions-${startTime}`,
					name: TOOL_NAME,
					args: { projectId, ...filters },
					result,
					status: "success",
					durationMs: Date.now() - startTime,
				},
			];
			return {
				outputs: { response, toolResults: toolCalls, decisionCount },
				variables: {},
				toolCalls,
				response,
			};
		};

		if (!projectId) {
			return respond(
				"No project is attached to this conversation, so there are no architecture decisions to read. " +
					"Attach a project to enable decision lookups.",
				{ message: "No project attached" },
			);
		}

		const { hasProjectAccess, listArchitectureDecisions } = await import(
			"@repo/database"
		);

		const hasAccess = await hasProjectAccess(
			projectId,
			input.userId,
			input.organizationId,
		);
		if (!hasAccess) {
			return respond(
				"You don't have access to this project's architecture decisions.",
				{ message: "Access denied" },
			);
		}

		const result = await listArchitectureDecisions({
			projectId,
			...(filters.status ? { status: filters.status } : {}),
			...(filters.domain ? { domain: filters.domain } : {}),
			limit: 100,
		});

		if (result.items.length === 0) {
			const filterDesc = describeFilters(filters);
			return respond(
				`This project has no architecture decisions${filterDesc}. ` +
					"Decisions can be created in the project's Decisions tab.",
				{ decisionCount: 0 },
			);
		}

		const response = formatDecisions(result.items, result.total);
		return respond(
			response,
			{ decisionCount: result.items.length, total: result.total },
			result.items.length,
		);
	}
}

function readFilters(
	stepInputs: Record<string, unknown> | undefined,
): DecisionFilters {
	const filters: DecisionFilters = {};
	const status = stepInputs?.status;
	const domain = stepInputs?.domain;
	if (
		status === "PROPOSED" ||
		status === "ACCEPTED" ||
		status === "SUPERSEDED" ||
		status === "DEPRECATED" ||
		status === "REJECTED"
	) {
		filters.status = status;
	}
	if (
		domain === "infra" ||
		domain === "data" ||
		domain === "ai" ||
		domain === "security" ||
		domain === "frontend" ||
		domain === "platform"
	) {
		filters.domain = domain;
	}
	return filters;
}

function describeFilters(filters: DecisionFilters): string {
	const parts = [
		filters.status?.toLowerCase(),
		filters.domain ? `in the ${filters.domain} domain` : undefined,
	].filter(Boolean);
	return parts.length > 0 ? ` matching ${parts.join(", ")}` : "";
}

const STATUS_LABEL: Record<string, string> = {
	PROPOSED: "Proposed",
	ACCEPTED: "Accepted",
	SUPERSEDED: "Superseded",
	DEPRECATED: "Deprecated",
	REJECTED: "Rejected",
};

type DecisionForDisplay = {
	identifier: string;
	title: string;
	status: string;
	domain: string | null;
	decisionDate: Date;
	rationale: string;
	vouchedAt: Date | null;
	sourceKind: string | null;
	updatedAt: Date;
};

function formatDecisions(
	decisions: DecisionForDisplay[],
	total: number,
): string {
	const shown = decisions.length;
	const header =
		shown < total
			? `${total} architecture decision${total === 1 ? "" : "s"} (showing ${shown}):`
			: `${total} architecture decision${total === 1 ? "" : "s"}:`;

	const blocks = decisions.map((d, i) => {
		const status = STATUS_LABEL[d.status] ?? d.status;
		const endorsed = d.vouchedAt ? " · Endorsed" : "";
		const domain = d.domain ? ` · ${d.domain}` : "";
		const date = d.decisionDate.toISOString().slice(0, 10);
		const lines = [
			`${i + 1}. [${status}${endorsed}] ${d.identifier}: ${d.title}`,
			`   Date: ${date}${domain}`,
		];
		if (d.rationale.trim()) {
			lines.push(
				`   Rationale: ${d.rationale.trim().slice(0, 300)}${d.rationale.length > 300 ? "…" : ""}`,
			);
		}
		return lines.join("\n");
	});

	return `${header}\n\n${blocks.join("\n\n")}`;
}
