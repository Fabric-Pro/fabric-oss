import {
	type WorkflowDraft,
	WorkflowDraftSchema,
} from "@repo/temporal/agentic-workflow-preset";
import { z } from "zod";

/**
 * A tool the chat must have the person approve before it runs answers with
 * `requiresConfirmation: true`, the tool and the exact arguments it would run
 * with, and — when the tool can say — a draft of what it would do. The chat
 * draws its approval card from this and nothing about which tool it is: the
 * workflow tools are the first, and any tool Fabric MCP marks for confirmation
 * arrives the same way. A workflow draft is read with the schema the api builds
 * it with, so the card and the draft cannot drift apart.
 */

export type { WorkflowDraft };

const WorkflowActionDraftSchema = z.object({
	kind: z.literal("workflow-action"),
	workflowId: z.string(),
	workflowName: z.string().nullish(),
	description: z.string().nullish(),
	status: z.string().nullish(),
});

type WorkflowActionDraft = z.infer<typeof WorkflowActionDraftSchema>;

/**
 * A request names the tool and the exact arguments it would run with: approving
 * it runs that call and nothing else, so a request that names neither has
 * nothing to approve and draws no card.
 */
const ConfirmationRequestSchema = z.object({
	requiresConfirmation: z.literal(true),
	toolName: z.string(),
	args: z.record(z.string(), z.unknown()),
	draft: z.unknown().optional(),
	message: z.string().optional(),
});

export interface ChatConfirmationRequest {
	toolName: string;
	args: Record<string, unknown>;
	workflowDraft?: WorkflowDraft;
	workflowAction?: WorkflowActionDraft;
	message?: string;
}

/** The approval a tool result asks for, or null when it asks for none. */
export function readConfirmationRequest(
	result: unknown,
): ChatConfirmationRequest | null {
	const parsed = ConfirmationRequestSchema.safeParse(result);
	if (!parsed.success) {
		return null;
	}
	const { requiresConfirmation: _, draft, ...rest } = parsed.data;
	const workflowDraft = WorkflowDraftSchema.safeParse(draft);
	const workflowAction = WorkflowActionDraftSchema.safeParse(draft);
	return {
		...rest,
		...(workflowDraft.success ? { workflowDraft: workflowDraft.data } : {}),
		...(workflowAction.success
			? { workflowAction: workflowAction.data }
			: {}),
	};
}

/** The tool a request is for. */
function toolNameOf(request: ChatConfirmationRequest): string {
	return request.toolName;
}

/** Each phrase reads in a sentence ("approved: run workflow") and, capitalised, as a title. */
const ACTION_PHRASES: Record<string, string> = {
	fabric_create_workflow: "create workflow",
	fabric_update_workflow: "edit workflow",
	fabric_publish_workflow: "publish workflow",
	fabric_execute_workflow: "run workflow",
	fabric_page_data_set: "save data on this page",
	fabric_page_data_delete: "delete data from this page",
	fabric_page_file_upload: "upload a file to this page",
	fabric_page_file_delete: "delete a file from this page",
	fabric_page_comment_add: "add a comment",
	fabric_page_ask: "ask the AI a question",
	fabric_page_run_workflow: "run its workflow",
	fabric_page_read_connected: "read from your connected account",
};

function capitalised(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A tool's action as a phrase for a sentence: "run workflow" for the workflow
 * tools, and the tool's own name spelled out (`fabric_share_page` → "share
 * page") for any other.
 */
export function describeToolPhrase(toolName: string): string {
	if (!toolName) {
		return "run action";
	}
	return (
		ACTION_PHRASES[toolName] ??
		toolName
			.replace(/^fabric_/, "")
			.split("_")
			.join(" ")
	);
}

/** A request's action as a title: "Run workflow", "Share page". */
export function describeToolAction(request: ChatConfirmationRequest): string {
	return capitalised(describeToolPhrase(toolNameOf(request)));
}

/** The thing the call acts on: the workflow's name, when there is one. */
function subjectOf(request: ChatConfirmationRequest): string | undefined {
	return (
		request.workflowDraft?.name ??
		request.workflowAction?.workflowName ??
		undefined
	);
}

/** The card's title: the action, then what it acts on. */
export function confirmationTitle(request: ChatConfirmationRequest): string {
	const subject = subjectOf(request);
	const action = describeToolAction(request);
	return subject ? `${action}: ${subject}` : action;
}

/** The line under the title, when the request or its draft has one. */
export function confirmationDescription(
	request: ChatConfirmationRequest,
): string | undefined {
	return (
		request.workflowDraft?.description ??
		request.workflowAction?.description ??
		undefined
	);
}

/** Starting a run reads "Execute", as the card always has; the rest "Approve". */
export function approveLabel(request: ChatConfirmationRequest): string {
	return toolNameOf(request) === "fabric_execute_workflow"
		? "Execute"
		: "Approve";
}

/** A draft that cannot go live cannot be approved until it can. */
export function hasBlockingProblems(request: ChatConfirmationRequest): boolean {
	return (request.workflowDraft?.problems.length ?? 0) > 0;
}

const MAX_ARGUMENT_ROWS = 16;
const MAX_ARGUMENT_DEPTH = 4;
const MAX_ARGUMENT_CHARS = 120;
const MAX_INLINE_LIST_ITEMS = 12;

type ArgumentScalar = string | number | boolean;

function isArgumentScalar(value: unknown): value is ArgumentScalar {
	return (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean"
	);
}

function clipArgumentValue(text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > MAX_ARGUMENT_CHARS
		? `${oneLine.slice(0, MAX_ARGUMENT_CHARS - 1)}…`
		: oneLine;
}

/**
 * What the call carries, so the person sees what they approve: one row per
 * value, nested values under their path (`preset.schedule.cron`,
 * `nodes[0].type`), a list of plain values on one row. Every part is bounded:
 * values are cut short, nesting stops at a few levels with a count in place of
 * what lies below, and rows stop at a limit with a last row for the number left
 * out. Empty values and null are not shown.
 */
export function summarizeArguments(
	args: Record<string, unknown> | undefined,
): Array<[string, string]> {
	const rows: Array<[string, string]> = [];
	let omitted = 0;

	const add = (name: string, value: string) => {
		if (rows.length < MAX_ARGUMENT_ROWS) {
			rows.push([name, clipArgumentValue(value)]);
		} else {
			omitted += 1;
		}
	};

	const visit = (name: string, value: unknown, depth: number): void => {
		if (isArgumentScalar(value)) {
			add(name, String(value));
			return;
		}
		if (Array.isArray(value)) {
			if (value.length === 0) {
				return;
			}
			if (value.every(isArgumentScalar)) {
				const shown = value.slice(0, MAX_INLINE_LIST_ITEMS).join(", ");
				add(
					name,
					value.length > MAX_INLINE_LIST_ITEMS
						? `${shown}, … (${value.length} in all)`
						: shown,
				);
				return;
			}
			if (depth >= MAX_ARGUMENT_DEPTH) {
				add(name, `${value.length} items`);
				return;
			}
			value.forEach((item, index) => {
				visit(`${name}[${index}]`, item, depth + 1);
			});
			return;
		}
		if (value !== null && typeof value === "object") {
			const entries = Object.entries(value);
			if (entries.length === 0) {
				return;
			}
			if (depth >= MAX_ARGUMENT_DEPTH) {
				add(name, `${entries.length} fields`);
				return;
			}
			for (const [key, inner] of entries) {
				visit(`${name}.${key}`, inner, depth + 1);
			}
		}
	};

	for (const [name, value] of Object.entries(args ?? {})) {
		visit(name, value, 1);
	}
	if (omitted > 0) {
		rows.push(["…", `${omitted} more value${omitted === 1 ? "" : "s"}`]);
	}
	return rows;
}

/** What the person's approval says in the transcript. */
export function approvalMessage(request: ChatConfirmationRequest): string {
	const name = subjectOf(request);
	const action = describeToolPhrase(toolNameOf(request));
	return name ? `Approved: ${action} “${name}”.` : `Approved: ${action}.`;
}

/** What approving does, in the card's own words. */
export function describeConsequence(request: ChatConfirmationRequest): string {
	switch (toolNameOf(request)) {
		case "fabric_create_workflow":
			return request.workflowDraft?.schedule
				? "Approving creates the workflow, puts it on this schedule and runs it once now."
				: "Approving creates the workflow as a draft.";
		case "fabric_update_workflow":
			return "Approving saves these changes. A published workflow picks them up on its next run.";
		case "fabric_publish_workflow":
			return "Approving publishes the workflow as a new version and starts its schedule.";
		case "fabric_unpublish_workflow":
			return "Approving reverts the workflow to a draft and stops its schedule.";
		case "fabric_pause_workflow":
			return "Approving pauses the workflow's schedule until it is resumed.";
		case "fabric_resume_workflow":
			return "Approving resumes the workflow's schedule.";
		case "fabric_execute_workflow":
			return "Approving starts one run now.";
		case "fabric_create_frame":
		case "fabric_update_frame": {
			const tools = pageToolsOf(request);
			return tools.length > 0
				? `Approving saves this page and lets it call ${tools.join(", ")} as whoever opens it.`
				: "Approving runs this action once.";
		}
		default:
			return "Approving runs this action once.";
	}
}

/** The Fabric tools a page's script may call, as the call declares them. */
function pageToolsOf(request: ChatConfirmationRequest): string[] {
	const declared = request.args.runtimeTools;
	return Array.isArray(declared)
		? declared.filter((name): name is string => typeof name === "string")
		: [];
}
