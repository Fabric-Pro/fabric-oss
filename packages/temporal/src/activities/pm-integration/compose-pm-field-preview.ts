/**
 * Compose the body a mapping WOULD produce, for one real work item.
 *
 * Picking fields is otherwise blind: the admin chooses identifiers and only
 * finds out what they compose into after a sync has written it. This renders the
 * exact markdown the next inbound sync would store, from a ticket they know.
 *
 * Deliberately delegates to `assembleFieldMappingDescription` — the same
 * function the sync path itself calls. Re-implementing the composition in the UI
 * (or here) would let the preview drift from what actually gets written, and a
 * preview that lies is worse than none.
 */
import {
	ADO_FIELD_MAPPING_PROVIDER,
	type FieldMappingField,
} from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/activity";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { describeAdoToolRequirement, resolveAdoTool } from "./ado-tool-surface";
import {
	assembleFieldMappingDescription,
	discoverPMToolCapabilities,
	isPmNotFoundError,
} from "./story-sync";

export interface ComposePmFieldPreviewInput {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	workItemId: string | number;
	/** The candidate mapping, in display order. */
	fields: FieldMappingField[];
	userId: string;
	organizationId?: string;
}

export interface ComposePmFieldPreviewResult {
	/** The composed body, exactly as a sync would write it. */
	markdown: string;
	/** Selected fields that are empty on this work item — they contribute no section. */
	emptyFieldIds: string[];
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

export async function composePmFieldPreview(
	input: ComposePmFieldPreviewInput,
): Promise<ComposePmFieldPreviewResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		workItemId,
		fields,
		userId,
		organizationId,
	} = input;

	if (fields.length === 0) {
		return { markdown: "", emptyFieldIds: [] };
	}

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});
	if (!capabilities) {
		throw ApplicationFailure.nonRetryable(
			"Failed to discover PM tool capabilities",
		);
	}

	const project = containerName ?? containerId;
	const numericId =
		typeof workItemId === "number"
			? workItemId
			: Number.parseInt(String(workItemId), 10);

	const getCall = resolveAdoTool(capabilities.availableTools, "get", {
		id: Number.isFinite(numericId) ? numericId : workItemId,
		project,
	});
	if (!getCall) {
		throw ApplicationFailure.nonRetryable(
			`Azure DevOps MCP server exposes neither ${describeAdoToolRequirement("get")}`,
		);
	}

	let result: { success: boolean; output?: unknown };
	try {
		result = await executeMcpTool({
			toolName: getCall.toolName,
			args: getCall.args,
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
	const workItemFields =
		data?.fields && typeof data.fields === "object"
			? (data.fields as Record<string, unknown>)
			: undefined;

	const markdown =
		assembleFieldMappingDescription(workItemFields, {
			provider: ADO_FIELD_MAPPING_PROVIDER,
			fields,
		}) ?? "";

	const emptyFieldIds = fields
		.filter((field) => {
			const raw = workItemFields?.[field.id];
			return (
				raw == null ||
				(typeof raw === "string" && raw.trim().length === 0)
			);
		})
		.map((field) => field.id);

	logger.info("[Compose PM Field Preview] Complete", {
		fieldCount: fields.length,
		emptyCount: emptyFieldIds.length,
		markdownLength: markdown.length,
	});

	return { markdown, emptyFieldIds };
}
