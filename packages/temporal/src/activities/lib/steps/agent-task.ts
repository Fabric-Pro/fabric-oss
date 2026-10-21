/**
 * Agent Task Step
 *
 * Runs one unattended agent turn inside a workflow: the node's prompt, the
 * outputs of the steps before it as quoted data, and only the MCP servers and
 * built-in capabilities the node names. Nobody is present to answer or approve,
 * so everything the agent may reach is settled when the workflow is published
 * (`findAgenticPublishProblems`) and re-checked here against live rows.
 *
 * The wording the agent is given is not code: it is the `workflow_agent_task`
 * prompt from the Prompt Library (`resolveAgentTaskInstructions`), with the
 * node's own `systemPrompt` appended after it.
 *
 * Output: `{ text, html?, markdown?, toolCallSummary, instructions }`, where
 * `instructions` says which prompt shaped the run. `{{Agent Task.html}}` is
 * what a Publish Frame step normally reads.
 */

import { randomUUID } from "node:crypto";
import { getWorkflowById, ownMcpConfigIds } from "@repo/database";
import { agentTaskCapabilityProblem } from "../../../lib/agent-task-capabilities";
import {
	AGENT_TASK_MAX_ITERATIONS,
	AgentTaskNodeConfigSchema,
} from "../../../lib/agentic-workflow-preset";
import {
	findScheduleTimezone,
	isValidScheduleTimeZone,
} from "../../../schedules/workflow-builder-schedule";
import { executeAgentTurn } from "../../agent-execution-core/agent-executor";
import type { NodeExecutionResult, StepParams } from "../../types";
import { resolveAgentTaskInstructions } from "../agent-task-instructions";

/** Largest html / markdown document the step hands on. */
export const AGENT_TASK_MAX_DOCUMENT_CHARS = 400_000;
/** The model's full reply is kept only up to this much beside an extracted document. */
const TEXT_EXCERPT_CHARS = 20_000;
const UPSTREAM_VALUE_CHARS = 20_000;
const UPSTREAM_TOTAL_CHARS = 60_000;
const TOOL_SUMMARY_LIMIT = 50;
/** `executeAgentTurn` substitutes this when the model ends a turn with no text. */
const EMPTY_TURN_RESPONSE = "Task completed.";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, limit: number): string {
	return value.length > limit
		? `${value.slice(0, limit)}\n[truncated ${value.length - limit} characters]`
		: value;
}

function serializeUpstreamValue(value: unknown): string {
	const text =
		typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return truncate(text ?? "", UPSTREAM_VALUE_CHARS);
}

/**
 * The step's inputs carry every earlier output under both its label and its
 * `$nodeId`; after the trip through Temporal's payload converter the two are
 * separate copies, so a `$id` entry is dropped when a labelled one is equal.
 */
function selectUpstreamEntries(
	inputs: Record<string, unknown>,
): Array<[string, unknown]> {
	const entries = Object.entries(inputs).filter(
		([, value]) => value !== undefined && value !== null,
	);
	const labelled = new Set(
		entries
			.filter(([key]) => !key.startsWith("$"))
			.map(([, value]) => JSON.stringify(value)),
	);
	return entries.filter(
		([key, value]) =>
			!(key.startsWith("$") && labelled.has(JSON.stringify(value))),
	);
}

/**
 * Earlier steps' outputs as one delimited block, or null when there are none.
 * The boundary is per run, so the data cannot forge its own closing tag; the
 * instructions that tell the agent to treat the block as data are the
 * `workflow_agent_task` prompt's, which names the same boundary.
 */
export function buildUpstreamDataBlock(
	inputs: Record<string, unknown>,
	boundary: string,
): string | null {
	let remaining = UPSTREAM_TOTAL_CHARS;
	const sections: string[] = [];
	for (const [key, value] of selectUpstreamEntries(inputs)) {
		if (remaining <= 0) {
			break;
		}
		const body = truncate(serializeUpstreamValue(value), remaining);
		remaining -= body.length;
		sections.push(`## ${key}\n${body}`);
	}
	if (sections.length === 0) {
		return null;
	}
	return [
		`<upstream-data boundary="${boundary}">`,
		sections.join("\n\n"),
		`</upstream-data boundary="${boundary}">`,
	].join("\n\n");
}

export function buildUserMessage(
	prompt: string,
	upstreamDataBlock: string | null,
): string {
	return upstreamDataBlock ? `${prompt}\n\n${upstreamDataBlock}` : prompt;
}

/**
 * The moment of this run, in the schedule's time zone and in UTC, for the
 * agent to put on a page. A model has no clock of its own and writes a guess
 * ("Generated at 01:00") that is neither when the run started nor in the zone
 * the person set the schedule in.
 */
export function describeRunTime(now: Date, timeZone: string): string {
	const local = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "short",
	}).format(now);
	return `Run time: ${local} (time zone ${timeZone}; UTC ${now.toISOString()})`;
}

/**
 * The time zone the workflow's schedule is read in: its trigger's
 * `scheduleTimezone`, UTC when the workflow has none (as the schedule itself
 * reads it), has no trigger on a schedule, or names a zone that is not valid.
 */
async function scheduleTimeZone(params: StepParams): Promise<string> {
	if (!params.workflowId) {
		return "UTC";
	}
	const workflow = await getWorkflowById(
		params.workflowId,
		params.userId,
		params.organizationId,
	);
	const zone = findScheduleTimezone(workflow?.nodes);
	return zone && isValidScheduleTimeZone(zone) ? zone : "UTC";
}

function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim();
	return (
		/^<(!doctype|html|head|body|[a-z][a-z0-9-]*)/i.test(trimmed) &&
		trimmed.includes("</")
	);
}

function isFullDocument(content: string): boolean {
	return /<!doctype\s+html|<html[\s>]/i.test(content);
}

/**
 * The HTML the agent produced: a fenced ```html block when there is one,
 * otherwise the whole reply when it is itself HTML. Null when neither holds.
 */
export function extractHtmlDocument(text: string): string | null {
	const fenced = [
		...text.matchAll(/```[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)```/g),
	]
		.map((match) => ({
			lang: match[1]?.toLowerCase() ?? "",
			body: match[2] ?? "",
		}))
		.filter(
			({ lang, body }) =>
				(lang === "html" || lang === "") && looksLikeHtml(body),
		);
	if (fenced.length > 0) {
		const documents = fenced.filter(({ body }) => isFullDocument(body));
		const pool = documents.length > 0 ? documents : fenced;
		const best = pool.reduce((a, b) =>
			b.body.length > a.body.length ? b : a,
		);
		return best.body.trim();
	}

	const opening = text.match(/```[ \t]*html[^\n]*\n/i);
	if (opening?.index !== undefined) {
		let body = text.slice(opening.index + opening[0].length).trim();
		if (body.endsWith("```")) {
			body = body.slice(0, -3).trim();
		}
		if (body.toLowerCase().endsWith("</html>")) {
			return body;
		}
	}

	return looksLikeHtml(text) ? text.trim() : null;
}

/** The Markdown the agent produced, unwrapped when the whole reply is one fence. */
export function extractMarkdownDocument(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed || trimmed === EMPTY_TURN_RESPONSE) {
		return null;
	}
	const headerEnd = trimmed.indexOf("\n");
	const header = trimmed.slice(3, headerEnd).trim().toLowerCase();
	const isMarkdownFence =
		trimmed.startsWith("```") &&
		trimmed.endsWith("```") &&
		headerEnd > 0 &&
		(header === "markdown" || header === "md");
	return (
		(isMarkdownFence ? trimmed.slice(headerEnd + 1, -3) : trimmed).trim() ||
		null
	);
}

async function findUnavailableMcpConfigs(
	mcpConfigIds: string[],
	actor: { userId: string; organizationId: string },
): Promise<string[]> {
	const requested = [...new Set(mcpConfigIds)];
	const owned = await ownMcpConfigIds(requested, actor);
	const usable = new Set(
		owned.filter((config) => config.enabled).map((config) => config.id),
	);
	return requested.filter((id) => !usable.has(id));
}

export async function executeAgentTaskStep(
	params: StepParams,
): Promise<NodeExecutionResult> {
	const parsed = AgentTaskNodeConfigSchema.safeParse(params.nodeConfig);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map(
				(issue) =>
					`${issue.path.join(".") || "config"}: ${issue.message}`,
			)
			.join("; ");
		return {
			success: false,
			error: `Invalid Agent Task configuration: ${issues}`,
		};
	}
	const config = parsed.data;

	if (!params.organizationId) {
		return {
			success: false,
			error: "Agent Task needs an organization; this workflow has none.",
		};
	}
	const { userId, organizationId } = params;

	for (const capability of config.builtInToolNames) {
		const problem = agentTaskCapabilityProblem(capability);
		if (problem) {
			return { success: false, error: problem };
		}
	}

	try {
		const unavailable = await findUnavailableMcpConfigs(
			config.mcpConfigIds,
			{ userId, organizationId },
		);
		if (unavailable.length > 0) {
			return {
				success: false,
				error: `MCP server not available to this workflow's owner (removed, disabled, or owned by someone else): ${unavailable.join(", ")}`,
			};
		}

		const runTime = describeRunTime(
			new Date(),
			await scheduleTimeZone(params),
		);
		const boundary = randomUUID();
		const upstreamDataBlock = buildUpstreamDataBlock(
			params.inputs,
			boundary,
		);
		const instructions = await resolveAgentTaskInstructions({
			userId,
			organizationId,
			projectId: params.projectId,
			outputFormat: config.outputFormat,
			hasUpstreamData: upstreamDataBlock !== null,
			boundary,
		});
		const provenance = {
			source: instructions.source,
			promptVersion: instructions.promptVersion,
		};

		const result = await executeAgentTurn({
			systemPrompt: [instructions.text, config.systemPrompt?.trim()]
				.filter(Boolean)
				.join("\n\n"),
			userMessage: buildUserMessage(
				`${config.prompt}\n\n${runTime}`,
				upstreamDataBlock,
			),
			mcpConfigIds: config.mcpConfigIds,
			builtInToolNames: config.builtInToolNames,
			model: config.modelId,
			userId,
			organizationId,
			projectId: params.projectId,
			featureKey: "scheduled-agent-task",
			maxIterations: Math.min(
				config.maxIterations,
				AGENT_TASK_MAX_ITERATIONS,
			),
			executionId: params.executionId,
			workflowExecutionId: params.executionId,
			...(params.frameId ? { frameId: params.frameId } : {}),
			promptVersionId: instructions.promptVersionId,
			jobType: params.jobType,
		});

		const toolCallSummary = result.toolCalls
			.slice(0, TOOL_SUMMARY_LIMIT)
			.map((call) => ({
				name: call.name,
				serverName: call.serverName,
				status: call.status,
			}));

		if (!result.success) {
			return {
				success: false,
				error: `Agent run failed: ${result.error ?? "unknown error"}`,
				output: { text: "", toolCallSummary, instructions: provenance },
			};
		}

		const document =
			config.outputFormat === "html"
				? extractHtmlDocument(result.response)
				: extractMarkdownDocument(result.response);
		const failure = (error: string): NodeExecutionResult => ({
			success: false,
			error,
			output: {
				text: truncate(result.response, TEXT_EXCERPT_CHARS),
				toolCallSummary,
				instructions: provenance,
			},
		});

		if (!document) {
			return failure(
				config.outputFormat === "html"
					? "The agent finished without producing an HTML document."
					: "The agent finished without producing a result.",
			);
		}
		if (document.length > AGENT_TASK_MAX_DOCUMENT_CHARS) {
			return failure(
				`The agent's ${config.outputFormat} output is too large (${document.length} characters; the limit is ${AGENT_TASK_MAX_DOCUMENT_CHARS}).`,
			);
		}

		return {
			success: true,
			output: {
				text: truncate(result.response, TEXT_EXCERPT_CHARS),
				[config.outputFormat]: document,
				toolCallSummary,
				instructions: provenance,
			},
		};
	} catch (error) {
		console.error("[agent-task] Error:", toErrorMessage(error));
		return {
			success: false,
			error: `Agent Task failed: ${toErrorMessage(error)}`,
		};
	}
}
