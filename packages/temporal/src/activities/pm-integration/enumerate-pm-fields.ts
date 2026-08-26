/**
 * Field enumeration activity
 *
 * Enumerates the union of ADO fields (standard + custom) across a project's work
 * item types so an admin can pick which fields get aggregated into Fabric
 * content. MCP-native: invokes `wit_get_work_item_type` per type and unions
 * `.fields[]` — no raw ADO REST. The pure projection + plumbing
 * heuristic + union/dedupe live in `tool-analyzer.ts`; this file only owns the
 * MCP orchestration.
 *
 * The list of work item TYPE NAMES is an INPUT, not resolved here: the ADO MCP
 * exposes no list-types tool (spike), and the only proven type-lister is the
 * REST `_apis/wit/workitemtypes` sibling in the API layer
 * (`list-project-work-item-types.ts`). Keeping type-listing at the caller (the
 * oRPC procedure, Group 3) preserves this activity's MCP-only contract and the
 * temporal ⊄ api package boundary.
 */
import { ADO_FIELD_MAPPING_PROVIDER } from "@repo/database";
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/activity";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { discoverPMToolCapabilities } from "./story-sync";
import {
	buildFieldCatalogFromTypeFields,
	type PmFieldCatalogEntry,
} from "./tool-analyzer";

export interface EnumeratePmFieldsInput {
	mcpConfigId: string;
	/** ADO project id/name (container). Used as the `project` arg. */
	containerId: string;
	/** Human-readable container name; preferred over `containerId` when present. */
	containerName?: string;
	/**
	 * Work item type names to enumerate fields for (e.g. ["User Story", "Bug"]).
	 * Resolved by the caller (the oRPC procedure reuses the REST work-item-types
	 * sibling). The full project field set = union of `.fields[]` across these.
	 */
	workItemTypes: string[];
	userId: string;
	organizationId?: string;
}

export type EnumeratePmFieldsResult =
	| { unsupported: true; provider: string | null }
	| {
			unsupported?: false;
			fields: PmFieldCatalogEntry[];
			workItemTypeCount: number;
	  };

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

/**
 * Enumerate the deduped field catalog for a connected ADO project.
 *
 * Non-ADO providers return `{ unsupported: true, provider }` WITHOUT calling any
 * ADO tool. Never logs field values — only provider, type count,
 * field count, and failure count.
 */
export async function enumeratePmFields(
	input: EnumeratePmFieldsInput,
): Promise<EnumeratePmFieldsResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		workItemTypes,
		userId,
		organizationId,
	} = input;

	const capabilities = await discoverPMToolCapabilities({
		mcpConfigId,
		userId,
		organizationId,
	});

	const provider = capabilities?.detectedType ?? null;
	if (!capabilities || provider !== ADO_FIELD_MAPPING_PROVIDER) {
		logger.info(
			"[Enumerate PM Fields] Non-ADO provider — returning unsupported",
			{ provider },
		);
		return { unsupported: true, provider };
	}

	const toolName = capabilities.availableTools.find((t) =>
		/wit_get_work_item_type$/i.test(t),
	);
	if (!toolName) {
		throw ApplicationFailure.nonRetryable(
			"Azure DevOps MCP server does not expose wit_get_work_item_type",
		);
	}

	// ADO project arg: prefer the human-readable container name, fall back to id
	// (mirrors getWorkItemsByIdsFromPM).
	const project = containerName ?? containerId;

	const typeFieldArrays: unknown[] = [];
	let failures = 0;
	for (const type of workItemTypes) {
		try {
			const result = await executeMcpTool({
				toolName,
				// The ADO MCP `wit_get_work_item_type` tool's required param is
				// `workItemType` (NOT `type`) — passing the wrong key made every
				// call fail with a missing-required-arg error at runtime.
				args: { project, workItemType: type },
				userId,
				organizationId,
				mcpConfigId,
			});
			if (!result.success) {
				failures++;
				continue;
			}
			const data = unwrapMcpObject(result.output);
			if (data && Array.isArray(data.fields)) {
				typeFieldArrays.push(data.fields);
			}
		} catch (error) {
			failures++;
			logger.warn("[Enumerate PM Fields] wit_get_work_item_type failed", {
				// NB: type name is metadata, not field content — safe to log.
				workItemType: type,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	// Every type call failed → surface a retryable error so the UI can retry,
	// rather than silently presenting an empty catalog.
	if (workItemTypes.length > 0 && failures === workItemTypes.length) {
		throw ApplicationFailure.nonRetryable(
			"Failed to enumerate fields: every wit_get_work_item_type call failed",
		);
	}

	const fields = buildFieldCatalogFromTypeFields(typeFieldArrays);

	logger.info("[Enumerate PM Fields] Complete", {
		provider,
		workItemTypeCount: workItemTypes.length,
		fieldCount: fields.length,
		failures,
	});

	return { fields, workItemTypeCount: workItemTypes.length };
}
