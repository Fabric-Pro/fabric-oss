/**
 * Feature Decisions Handler
 *
 * Handles `fabric_list_feature_decisions`: reads the attached feature's
 * Decision Log entries (DecisionLogEntry threads) from Feature Maturation.
 */

import type { ExecuteStepInput, ExecuteStepOutput } from "../../types";
import type {
	HandlerContext,
	HandlerResult,
	StepHandler,
	ToolCallRecord,
} from "./types";

const TOOL_NAME = "fabric_list_feature_decisions";

type DecisionStatus =
	| "OPEN"
	| "RESOLVED"
	| "REJECTED"
	| "FORMATTING_ONLY"
	| "POSSIBLY_RESOLVED";

type DecisionFilters = {
	storyId?: string;
	status?: DecisionStatus;
};

type DecisionThread = {
	root: {
		id: string;
		status: DecisionStatus;
		summary: string | null;
		content: string | null;
		topic: string | null;
		decidedBy: string | null;
		createdAt: Date;
	};
	replies: Array<{
		id: string;
		status: DecisionStatus;
		summary: string | null;
		content: string | null;
		createdAt: Date;
	}>;
};

export class FeatureDecisionsHandler implements StepHandler {
	readonly name = "feature-decisions";
	readonly capabilities = ["feature_decisions"];

	canHandle(input: ExecuteStepInput): boolean {
		const app = input.step.app;
		const executor = input.step.executor;
		return app === TOOL_NAME || executor === TOOL_NAME;
	}

	async execute(context: HandlerContext): Promise<HandlerResult> {
		const { input } = context;
		try {
			const output = await this.listFeatureDecisions(input);
			return { handled: true, output };
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error("[FeatureDecisionsHandler] failed:", error);
			return {
				handled: false,
				error: `Feature decisions lookup failed: ${message}`,
				shouldFallback: false,
			};
		}
	}

	private async listFeatureDecisions(
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
					id: `feature-decisions-${startTime}`,
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
				"No project is attached to this conversation, so there are no feature decisions to read. " +
					"Attach a project and provide a feature (storyId) to enable decision lookups.",
				{ message: "No project attached" },
			);
		}

		if (!filters.storyId) {
			return respond(
				"This tool needs a feature ID (storyId). Provide storyId to read that feature's Decision Log.",
				{ message: "storyId required" },
			);
		}

		const { hasProjectAccess, listDecisionLogThreads, db } = await import(
			"@repo/database"
		);

		const hasAccess = await hasProjectAccess(
			projectId,
			input.userId,
			input.organizationId,
		);
		if (!hasAccess) {
			return respond(
				"You don't have access to this project's feature decisions.",
				{ message: "Access denied" },
			);
		}

		const story = await db.userStory.findFirst({
			where: { id: filters.storyId, projectId },
			select: {
				id: true,
				identifier: true,
				title: true,
			},
		});

		if (!story) {
			return respond(
				"The requested feature (storyId) was not found in this project.",
				{ message: "Feature not found" },
			);
		}

		const threads = (await listDecisionLogThreads({
			tenantFilter: {
				userId: input.userId,
				organizationId: input.organizationId ?? null,
			},
			userStoryId: filters.storyId,
		})) as DecisionThread[];

		const filteredThreads = filters.status
			? threads.filter((thread) => thread.root.status === filters.status)
			: threads;

		if (filteredThreads.length === 0) {
			const filterDesc = filters.status
				? ` with status ${filters.status}`
				: "";
			return respond(
				`${story.identifier} ${story.title} has no Decision Log threads${filterDesc}.`,
				{ decisionCount: 0, storyId: story.id },
			);
		}

		const response = formatFeatureDecisions({
			storyIdentifier: story.identifier,
			storyTitle: story.title,
			threads: filteredThreads,
			total: threads.length,
		});

		return respond(
			response,
			{
				decisionCount: filteredThreads.length,
				total: threads.length,
				storyId: story.id,
			},
			filteredThreads.length,
		);
	}
}

function readFilters(
	stepInputs: Record<string, unknown> | undefined,
): DecisionFilters {
	const filters: DecisionFilters = {};
	const storyId = stepInputs?.storyId;
	const status = stepInputs?.status;

	if (typeof storyId === "string" && storyId.trim()) {
		filters.storyId = storyId.trim();
	}

	if (
		status === "OPEN" ||
		status === "RESOLVED" ||
		status === "REJECTED" ||
		status === "FORMATTING_ONLY" ||
		status === "POSSIBLY_RESOLVED"
	) {
		filters.status = status;
	}

	return filters;
}

const STATUS_LABEL: Record<DecisionStatus, string> = {
	OPEN: "Open",
	RESOLVED: "Resolved",
	REJECTED: "Rejected",
	FORMATTING_ONLY: "Formatting-only",
	POSSIBLY_RESOLVED: "Possibly resolved",
};

function summarizeText(value: string | null, max = 220): string {
	if (!value) {
		return "";
	}
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length > max
		? `${normalized.slice(0, max - 1)}…`
		: normalized;
}

function formatFeatureDecisions({
	storyIdentifier,
	storyTitle,
	threads,
	total,
}: {
	storyIdentifier: string;
	storyTitle: string;
	threads: DecisionThread[];
	total: number;
}): string {
	const shown = threads.length;
	const openCount = threads.filter((t) => t.root.status === "OPEN").length;
	const unresolvedCount = threads.filter(
		(t) =>
			t.root.status === "OPEN" || t.root.status === "POSSIBLY_RESOLVED",
	).length;

	const header =
		shown < total
			? `${storyIdentifier} ${storyTitle}: ${total} decision thread(s) total (showing ${shown}).`
			: `${storyIdentifier} ${storyTitle}: ${total} decision thread(s).`;

	const stanceLine =
		"Resolved decisions are authoritative for this feature's current intent; open threads are pending clarification.";

	const statusLine = `${openCount} OPEN and ${unresolvedCount} unresolved (OPEN or POSSIBLY_RESOLVED).`;

	const blocks = threads.map((thread, index) => {
		const root = thread.root;
		const statusLabel = STATUS_LABEL[root.status] ?? root.status;
		const summary = summarizeText(root.summary ?? root.content);
		const created = root.createdAt.toISOString().slice(0, 10);
		const topic = root.topic ? ` · Topic: ${root.topic}` : "";
		const decidedBy = root.decidedBy
			? ` · Decided by: ${root.decidedBy}`
			: "";
		const replyCount = thread.replies.length;
		const replySuffix =
			replyCount > 0
				? ` · ${replyCount} repl${replyCount === 1 ? "y" : "ies"}`
				: "";

		const lines = [
			`${index + 1}. [${statusLabel}] ${summary || "(no summary provided)"}`,
			`   Created: ${created}${topic}${decidedBy}${replySuffix}`,
		];

		if (replyCount > 0) {
			const latestReply = thread.replies[replyCount - 1];
			const latestSummary = summarizeText(
				latestReply.summary ?? latestReply.content,
				140,
			);
			if (latestSummary) {
				lines.push(`   Latest reply: ${latestSummary}`);
			}
		}

		return lines.join("\n");
	});

	return `${header}\n${statusLine}\n${stanceLine}\n\n${blocks.join("\n\n")}`;
}
