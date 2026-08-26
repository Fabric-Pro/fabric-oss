/**
 * Suggest an inbound field mapping from the work item FORM.
 *
 * A raw field picker does not scale: a mature Azure DevOps process exposes
 * hundreds of fields whose catalogued names give no hint which carry the story,
 * and the names an admin can actually SEE on the work item are different again —
 * rich-text bodies are drawn with an empty control label inside a titled group.
 *
 * The process template already answers both questions. `xmlForm` declares which
 * controls are rich-text bodies (`HtmlFieldControl`) and what heading each sits
 * under, so the content fields can be named and filtered from metadata rather
 * than inferred from how long their values happen to be. On a real project that
 * turns a 400+ row picker into four rows, deterministically.
 *
 * Two MCP round-trips: read the example work item (for its type and live
 * values), then read that type's definition (for the form). No sampling of peer
 * items, no LLM.
 *
 * Projects on the inherited process model do not expose `xmlForm`; those fall
 * back to ranking the example's own values by content shape
 * ({@link scoreFieldCandidates}).
 *
 * Never logs field values — only counts.
 */
import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/activity";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { parseAdoFormMetadata } from "./ado-form-metadata";
import {
	type AdoToolOp,
	describeAdoToolRequirement,
	resolveAdoTool,
} from "./ado-tool-surface";
import {
	discoverPMToolCapabilities,
	isPmNotFoundError,
	simpleHtmlToMarkdown,
} from "./story-sync";

/** Characters of example content returned per field for display. */
const PREVIEW_MAX_CHARS = 400;
/** Cap on suggestions returned when falling back to value-based ranking. */
const MAX_FALLBACK_SUGGESTIONS = 12;
/** Average length at which a field counts as fully "long-form" when scoring. */
const LENGTH_SATURATION_CHARS = 500;
/** Average length above which a field reads as prose rather than a scalar. */
const PROSE_MIN_AVERAGE_CHARS = 80;
/** Multiplier applied to fields that look like scalars/enums, not prose. */
const NON_PROSE_PENALTY = 0.35;

export interface SuggestPmFieldMappingInput {
	mcpConfigId: string;
	containerId: string;
	containerName?: string;
	/** A representative work item the admin recognises. */
	exampleWorkItemId: string | number;
	userId: string;
	organizationId?: string;
}

export interface PmFieldSuggestion {
	/** ADO referenceName, e.g. `Custom.BusinessRules`. */
	id: string;
	/**
	 * What the admin sees on the work item form. Falls back to the reference
	 * name when there is no form metadata.
	 */
	label: string;
	/** Raw form control type, when known. */
	controlType?: string;
	/** The form declares this control as a rich-text body. */
	isContentControl: boolean;
	/** The example work item has content in this field. */
	populatedOnExample: boolean;
	/** Rendered length of the example's value. */
	charCount: number;
	/** Truncated rendered content from the example, for display and searching. */
	examplePreview: string;
	/** Ordering score — only meaningful on the fallback path. */
	score: number;
}

export interface SuggestPmFieldMappingResult {
	/** The example's work item type; the form read is scoped to it. */
	workItemType: string | null;
	/**
	 * `form` when the process template supplied the content controls, `values`
	 * when it did not and ranking fell back to the example's own values. The UI
	 * says which, because the two carry very different confidence.
	 */
	source: "form" | "values";
	/** Ranked best-first. */
	suggestions: PmFieldSuggestion[];
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

/** Render one raw ADO field value to comparable plain text. */
export function renderFieldText(raw: unknown): string {
	if (typeof raw === "string") {
		return simpleHtmlToMarkdown(raw).trim();
	}
	if (typeof raw === "number" || typeof raw === "boolean") {
		return String(raw);
	}
	return "";
}

/** Flatten a work item's `fields` object into rendered text per reference name. */
export function renderFieldMap(
	fields: Record<string, unknown> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	if (!fields) {
		return out;
	}
	for (const [id, raw] of Object.entries(fields)) {
		const text = renderFieldText(raw);
		if (text.length > 0) {
			out[id] = text;
		}
	}
	return out;
}

function truncate(text: string): string {
	return text.length > PREVIEW_MAX_CHARS
		? `${text.slice(0, PREVIEW_MAX_CHARS)}…`
		: text;
}

/**
 * Rank candidate fields by the shape of their content. Pure.
 *
 * Only used when the process template exposes no form definition — with a form,
 * "is this a body?" is declared rather than guessed.
 */
export function scoreFieldCandidates(params: {
	candidateIds: string[];
	values: Record<string, string>;
}): PmFieldSuggestion[] {
	const { candidateIds, values } = params;

	const suggestions = candidateIds.map((id) => {
		const text = values[id] ?? "";
		const charCount = text.length;

		// Prose vs scalar: either it is long, or it carries the multi-line or
		// sentence structure that a status, id or date never does.
		const looksLikeProse =
			charCount >= PROSE_MIN_AVERAGE_CHARS ||
			/\n/.test(text) ||
			/[.!?]\s/.test(text);

		const lengthFactor = Math.min(1, charCount / LENGTH_SATURATION_CHARS);
		const score = lengthFactor * (looksLikeProse ? 1 : NON_PROSE_PENALTY);

		return {
			id,
			label: id,
			isContentControl: looksLikeProse,
			populatedOnExample: text.trim().length > 0,
			charCount,
			examplePreview: truncate(text),
			score,
		};
	});

	return suggestions.sort(
		(a, b) =>
			b.score - a.score ||
			b.charCount - a.charCount ||
			a.id.localeCompare(b.id),
	);
}

/** Resolve a logical ADO op or fail with a message naming both tool surfaces. */
function resolveOrThrow(
	availableTools: readonly string[],
	op: AdoToolOp,
	args: Record<string, unknown>,
) {
	const resolved = resolveAdoTool(availableTools, op, args);
	if (!resolved) {
		throw ApplicationFailure.nonRetryable(
			`Azure DevOps MCP server exposes neither ${describeAdoToolRequirement(op)}`,
		);
	}
	return resolved;
}

/** Pull the `fields` object out of a single work-item payload. */
function readFields(output: unknown): Record<string, unknown> | undefined {
	const data = unwrapMcpObject(output);
	return data?.fields && typeof data.fields === "object"
		? (data.fields as Record<string, unknown>)
		: undefined;
}

export async function suggestPmFieldMapping(
	input: SuggestPmFieldMappingInput,
): Promise<SuggestPmFieldMappingResult> {
	const {
		mcpConfigId,
		containerId,
		containerName,
		exampleWorkItemId,
		userId,
		organizationId,
	} = input;

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
	const tools = capabilities.availableTools;
	const project = containerName ?? containerId;

	// ---- 1. The example work item, in full -------------------------------
	const numericId =
		typeof exampleWorkItemId === "number"
			? exampleWorkItemId
			: Number.parseInt(String(exampleWorkItemId), 10);

	const getCall = resolveOrThrow(tools, "get", {
		id: Number.isFinite(numericId) ? numericId : exampleWorkItemId,
		project,
	});

	let exampleResult: { success: boolean; output?: unknown };
	try {
		exampleResult = await executeMcpTool({
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
				`Work item ${exampleWorkItemId} not found or not accessible`,
				"TICKET_NOT_FOUND",
			);
		}
		throw error;
	}
	if (!exampleResult.success) {
		throw ApplicationFailure.nonRetryable(
			`Work item ${exampleWorkItemId} not found or not accessible`,
			"TICKET_NOT_FOUND",
		);
	}

	const exampleFields = readFields(exampleResult.output);
	const values = renderFieldMap(exampleFields);
	const workItemType =
		typeof exampleFields?.["System.WorkItemType"] === "string"
			? (exampleFields["System.WorkItemType"] as string)
			: null;

	// ---- 2. The form definition for that type ----------------------------
	let formFields: ReturnType<typeof parseAdoFormMetadata> | undefined;

	if (workItemType) {
		const typeCall = resolveOrThrow(tools, "get_type", {
			project,
			workItemType,
		});
		try {
			const typeResult = await executeMcpTool({
				toolName: typeCall.toolName,
				args: typeCall.args,
				userId,
				organizationId,
				mcpConfigId,
			});
			if (typeResult.success) {
				const data = unwrapMcpObject(typeResult.output);
				const xmlForm =
					typeof data?.xmlForm === "string"
						? data.xmlForm
						: undefined;
				formFields = parseAdoFormMetadata(xmlForm);
			}
		} catch (error) {
			// Degrade to value-based ranking rather than failing the request —
			// but say so in the result, since the two differ in confidence.
			logger.warn("[Suggest PM Field Mapping] Form read failed", {
				workItemType,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const contentControls = formFields
		? [...formFields.values()].filter((f) => f.isContentControl)
		: [];

	// ---- 3a. Form-driven: the template names the body fields outright ----
	if (contentControls.length > 0) {
		const suggestions: PmFieldSuggestion[] = contentControls.map(
			(field) => {
				const text = values[field.referenceName] ?? "";
				return {
					id: field.referenceName,
					label: field.label || field.referenceName,
					controlType: field.controlType,
					isContentControl: true,
					populatedOnExample: text.trim().length > 0,
					charCount: text.length,
					examplePreview: truncate(text),
					score: 1,
				};
			},
		);

		// Populated first, then by size — form order is otherwise preserved so
		// the list reads like the work item does.
		suggestions.sort(
			(a, b) =>
				Number(b.populatedOnExample) - Number(a.populatedOnExample) ||
				b.charCount - a.charCount,
		);

		logger.info("[Suggest PM Field Mapping] Complete", {
			workItemType,
			source: "form",
			formFieldCount: formFields?.size ?? 0,
			suggestionCount: suggestions.length,
			surface: getCall.surface,
		});

		return { workItemType, source: "form", suggestions };
	}

	// ---- 3b. No form definition: rank the example's own values -----------
	const suggestions = scoreFieldCandidates({
		candidateIds: Object.keys(values),
		values,
	}).slice(0, MAX_FALLBACK_SUGGESTIONS);

	logger.info("[Suggest PM Field Mapping] Complete", {
		workItemType,
		source: "values",
		candidateCount: Object.keys(values).length,
		suggestionCount: suggestions.length,
		surface: getCall.surface,
	});

	return { workItemType, source: "values", suggestions };
}
