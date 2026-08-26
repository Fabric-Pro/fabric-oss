/**
 * Preview example-ticket field values activity
 *
 * Live-fetches ONE work item via the existing ADO `taskGet` MCP path (no raw
 * REST) and returns each requested field's raw value + a rendered markdown
 * preview, so an admin can empirically tell content-bearing fields from empty
 * ones (ADO returns no data-type on the field object). On-demand, never cached.
 *
 * Never logs field values — only field count + failures.
 */
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/activity";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import {
	discoverPMToolCapabilities,
	isPmNotFoundError,
	simpleHtmlToMarkdown,
} from "./story-sync";

/** Max characters of rendered markdown returned per field (display only). */
const PREVIEW_MAX_CHARS = 600;

/**
 * Default candidate fields when `fieldIds` is omitted — the spike's
 * content-bearing set (empty ones are reported with `isEmpty: true`).
 */
const DEFAULT_CANDIDATE_FIELD_IDS = [
	"System.Description",
	"Microsoft.VSTS.Common.AcceptanceCriteria",
	"Custom.BusinessRules",
	"Custom.UserStoryAcceptance",
	"Custom.DesignCriteria",
	"Custom.ReleaseNotes",
];

export interface PreviewPmFieldValuesInput {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	workItemId: string | number;
	/** When omitted, a default content-candidate set is returned. */
	fieldIds?: string[];
	userId: string;
	organizationId?: string;
}

export interface PreviewPmFieldValue {
	/** The requested field id (ADO referenceName). */
	id: string;
	/**
	 * Human label. The activity has no display-name source, so this echoes `id`;
	 * the caller (which holds the enumerated catalog) substitutes the friendly
	 * name.
	 */
	displayName: string;
	/** Raw stringified value, or null when the field is absent/non-scalar. */
	value: string | null;
	/** True when the field is absent or renders to blank after conversion. */
	isEmpty: boolean;
	/** HTML→markdown preview via `simpleHtmlToMarkdown`, truncated for display. */
	renderedPreview: string;
}

export interface PreviewPmFieldValuesResult {
	fields: PreviewPmFieldValue[];
}

/** Best-effort unwrap of an MCP text-content payload into a plain object. */
function unwrapMcpObject(output: unknown): Record<string, unknown> | null {
	let data: unknown = output;
	if (data && typeof data === "object") {
		const obj = data as Record<string, unknown>;
		if (Array.isArray(obj.content)) {
			const textItem = (
				obj.content as Array<{ type?: string; text?: string }>
			).find((c) => c.type === "text");
			if (textItem?.text) {
				try {
					data = JSON.parse(textItem.text);
				} catch {
					return null;
				}
			}
		}
	}
	return data && typeof data === "object"
		? (data as Record<string, unknown>)
		: null;
}

export async function previewPmFieldValues(
	input: PreviewPmFieldValuesInput,
): Promise<PreviewPmFieldValuesResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		workItemId,
		fieldIds,
		userId,
		organizationId,
	} = input;

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});
	if (!capabilities?.taskGet) {
		throw ApplicationFailure.nonRetryable(
			"PM tool does not expose a work-item get capability",
		);
	}
	const getTool = capabilities.taskGet;

	// Build get args mirroring the sync pull path: id + any project/container
	// params the tool requires (pre-filled to bypass ADO's interactive
	// elicitation on the headless client).
	const getArgs: Record<string, unknown> = {
		[getTool.idParam]: workItemId,
	};
	const project = containerName ?? containerId;
	for (const param of getTool.additionalRequiredParams) {
		if (
			param.includes("board") ||
			param.includes("container") ||
			param === "project"
		) {
			getArgs[param] = project;
		}
	}
	const projectLikeParams = [
		"project",
		"project_id",
		"project_key",
		"board_id",
	];
	for (const param of projectLikeParams) {
		if (
			!getArgs[param] &&
			project &&
			getTool.allParams?.some((p) => p.name === param)
		) {
			getArgs[param] = project;
			break;
		}
	}

	let result: { success: boolean; output?: unknown };
	try {
		result = await executeMcpTool({
			toolName: getTool.toolName,
			args: getArgs,
			userId,
			organizationId,
			mcpConfigId,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isPmNotFoundError(message)) {
			throw ApplicationFailure.nonRetryable(
				`Work item ${workItemId} not found or not accessible`,
				"TICKET_NOT_FOUND",
			);
		}
		throw error;
	}

	if (!result.success) {
		throw ApplicationFailure.nonRetryable(
			`Work item ${workItemId} not found or not accessible`,
			"TICKET_NOT_FOUND",
		);
	}

	const data = unwrapMcpObject(result.output);
	const fields =
		data?.fields && typeof data.fields === "object"
			? (data.fields as Record<string, unknown>)
			: undefined;

	const requestedIds =
		fieldIds && fieldIds.length > 0
			? fieldIds
			: DEFAULT_CANDIDATE_FIELD_IDS;

	const previews: PreviewPmFieldValue[] = requestedIds.map((id) => {
		const raw = fields?.[id];
		let value: string | null;
		if (typeof raw === "string") {
			value = raw;
		} else if (typeof raw === "number" || typeof raw === "boolean") {
			value = String(raw);
		} else {
			value = null;
		}
		const converted =
			value != null ? simpleHtmlToMarkdown(value).trim() : "";
		const isEmpty = converted.length === 0;
		const renderedPreview =
			converted.length > PREVIEW_MAX_CHARS
				? `${converted.slice(0, PREVIEW_MAX_CHARS)}…`
				: converted;
		return { id, displayName: id, value, isEmpty, renderedPreview };
	});

	logger.info("[Preview PM Field Values] Complete", {
		fieldCount: previews.length,
		emptyCount: previews.filter((p) => p.isEmpty).length,
	});

	return { fields: previews };
}
