import { logger } from "@repo/logs";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { descriptionToText } from "./adf";
import { extractDisplayName, normalizeIsoDate } from "./fetch-pm-ticket";
import type { PMToolCapabilities } from "./tool-analyzer";

/** Max number of comments included (most recent first). */
export const MAX_COMMENTS = 20;
/** Per-comment character cap (ellipsis-truncated). */
export const MAX_CHARS_PER_COMMENT = 1_000;

export interface PmComment {
	author: string | null;
	createdAt: string | null;
	body: string;
}

export interface FetchPmCommentsInput {
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	capabilities: PMToolCapabilities;
	externalId: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
	maxComments?: number;
	maxCharsPerComment?: number;
}

/** Ellipsis-truncate a single comment body (matches message-extractor's capAt). */
export function capComment(
	text: string,
	max: number = MAX_CHARS_PER_COMMENT,
): string {
	const trimmed = text.trim();
	return trimmed.length > max
		? `${trimmed.slice(0, max).trimEnd()}…`
		: trimmed;
}

function extractCommentBody(raw: Record<string, unknown>): string {
	const candidate =
		raw.text ?? raw.body ?? raw.content ?? raw.comment_text ?? raw.note;
	if (typeof candidate === "string") {
		return candidate.trim();
	}
	// Some PM tools return a structured body object rather than a string.
	// Fizzy: `{ plain_text, html }`. Prefer plain_text, then text, then a
	// minimal HTML→text strip — before falling through to ADF flattening.
	if (candidate && typeof candidate === "object") {
		const obj = candidate as Record<string, unknown>;
		if (typeof obj.plain_text === "string" && obj.plain_text.trim()) {
			return obj.plain_text.trim();
		}
		if (typeof obj.text === "string" && obj.text.trim()) {
			return obj.text.trim();
		}
		if (typeof obj.html === "string" && obj.html.trim()) {
			return obj.html
				.replace(/<[^>]*>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		}
	}
	// Jira (Atlassian) comment bodies arrive as ADF documents → flatten.
	return (descriptionToText(candidate) ?? "").trim();
}

function extractCommentsArray(data: unknown): Record<string, unknown>[] {
	if (Array.isArray(data)) {
		return data as Record<string, unknown>[];
	}
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		const arr =
			obj.comments ?? obj.value ?? obj.nodes ?? obj.notes ?? obj.data;
		if (Array.isArray(arr)) {
			return arr as Record<string, unknown>[];
		}
	}
	return [];
}

/**
 * Fetch a PM ticket's comments via the adapter's `taskComments` capability.
 *
 * Supplemental + non-blocking (`global/error-handling.md`): returns `[]` — never
 * throws — when there is no capability, the call fails, or the response is
 * unparsable. AI Update must complete regardless of comment availability.
 */
export async function fetchPmComments(
	input: FetchPmCommentsInput,
): Promise<PmComment[]> {
	const {
		mcpConfigId,
		userId,
		organizationId,
		capabilities,
		externalId,
		containerId,
		containerName,
		additionalContext,
		maxComments = MAX_COMMENTS,
		maxCharsPerComment = MAX_CHARS_PER_COMMENT,
	} = input;

	const taskComments = capabilities.taskComments;
	if (!taskComments) {
		return [];
	}

	const isADO = capabilities.detectedType === "azure-devops";
	const containerValue = isADO ? (containerName ?? containerId) : containerId;
	const projectParamNames = new Set(["project", "projectId", "project_id"]);

	const args: Record<string, unknown> = {
		[taskComments.idParam]: isADO ? Number(externalId) : externalId,
	};
	for (const param of taskComments.additionalRequiredParams) {
		if (projectParamNames.has(param)) {
			args[param] = containerValue;
		} else if (additionalContext?.[param]) {
			args[param] = additionalContext[param];
		}
	}

	// Fill OPTIONAL project-like params we already know. Azure DevOps marks
	// `project` optional on wit_list_work_item_comments and falls back to
	// interactive elicitation ("Project selection cancelled." in a headless
	// call) when it's absent — so it must be supplied. Mirrors fetchPmTicket.
	for (const p of taskComments.allParams) {
		if (!p.required && projectParamNames.has(p.name) && !(p.name in args)) {
			args[p.name] = containerValue;
		}
	}

	let result: { success: boolean; output: unknown };
	try {
		result = await executeMcpTool({
			toolName: taskComments.toolName,
			args,
			userId,
			organizationId,
			mcpConfigId,
		});
	} catch (error) {
		logger.warn("[PM Comments] adapter threw; skipping comments", {
			tool: taskComments.toolName,
			externalId,
			err: error instanceof Error ? error.message : String(error),
		});
		return [];
	}

	if (!result.success) {
		logger.warn(
			"[PM Comments] adapter returned failure; skipping comments",
			{
				tool: taskComments.toolName,
				externalId,
			},
		);
		return [];
	}

	let data: unknown = result.output ?? {};
	if (
		data &&
		typeof data === "object" &&
		Array.isArray((data as { content?: unknown }).content)
	) {
		const textItem = (
			data as { content: Array<{ type?: string; text?: string }> }
		).content.find((c) => c.type === "text");
		if (textItem?.text) {
			try {
				data = JSON.parse(textItem.text);
			} catch {
				logger.warn("[PM Comments] unparsable JSON content; skipping", {
					tool: taskComments.toolName,
					externalId,
				});
				return [];
			}
		}
	}

	const normalized: PmComment[] = [];
	for (const raw of extractCommentsArray(data)) {
		const body = extractCommentBody(raw);
		if (!body) {
			continue;
		}
		normalized.push({
			author: extractDisplayName(
				raw.createdBy ??
					raw.author ??
					raw.user ??
					raw.creator ??
					raw.updatedBy,
			),
			createdAt: normalizeIsoDate(
				raw.createdDate ??
					raw.created_date ??
					raw.createdAt ??
					raw.created_at ??
					raw.created ??
					raw.date,
			),
			body,
		});
	}

	// Most-recent first when dates exist; take N; then chronological asc for the
	// prompt. With no dates, assume chronological input order and take the tail.
	const hasDates = normalized.some((c) => c.createdAt !== null);
	const selected = hasDates
		? [...normalized]
				.sort((a, b) =>
					(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
				)
				.slice(0, maxComments)
				.reverse()
		: normalized.slice(-maxComments);

	return selected.map((c) => ({
		...c,
		body: capComment(c.body, maxCharsPerComment),
	}));
}
