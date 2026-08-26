import { logger } from "@repo/logs";
import { ApplicationFailure } from "@temporalio/common";
import { executeMcpTool } from "../orchestrator/execution/execute-mcp-tool";
import { descriptionToText } from "./adf";
import type { PMToolCapabilities } from "./tool-analyzer";

export interface FetchPmTicketInput {
	mcpConfigId: string;
	userId: string;
	organizationId?: string;
	capabilities: PMToolCapabilities;
	externalId: string;
	containerId: string;
	containerName?: string;
	additionalContext?: Record<string, string>;
}

export interface PmTicketSnapshot {
	title: string;
	description: string;
	url?: string;
	/** Display name of the last person to change the PM ticket; `null` when unknown. */
	lastChangedBy: string | null;
	/** ISO 8601 timestamp of the last change; `null` when unknown. */
	lastChangedAt: string | null;
}

/**
 * Best-effort extraction of a display name from a PM "author" field. PM tools
 * return either a bare string (some ADO shapes) or an identity object with a
 * `displayName` / `name` property (ADO identity refs, Jira/Linear users).
 * Returns `null` for any other shape — never throws.
 */
export function extractDisplayName(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const candidate = obj.displayName ?? obj.name;
		if (typeof candidate === "string" && candidate.trim().length > 0) {
			return candidate.trim();
		}
	}
	return null;
}

/**
 * Normalize a PM-supplied timestamp to an ISO 8601 string. PM tools already
 * return ISO strings (ADO `System.ChangedDate`, Jira `updated`, Linear
 * `updatedAt`), but we re-parse defensively so an odd value yields `null`
 * rather than a bad subtitle. Never throws.
 */
export function normalizeIsoDate(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed.toISOString();
}

/**
 * Parse `lastChangedBy` / `lastChangedAt` from a PM-ticket payload, per tool.
 * Covered in v1: Azure DevOps, Jira, Linear (D6a). All other tools return
 * `{ null, null }`. This is a display-only read: a parse miss must never throw
 * or degrade conflict detection (`global/error-handling.md`).
 */
function parseLastChanged(
	detectedType: string | null | undefined,
	data: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): { lastChangedBy: string | null; lastChangedAt: string | null } {
	const empty = { lastChangedBy: null, lastChangedAt: null };
	try {
		const type = (detectedType ?? "").toLowerCase();

		if (type === "azure-devops" || type === "ado") {
			return {
				lastChangedBy: extractDisplayName(fields?.["System.ChangedBy"]),
				lastChangedAt: normalizeIsoDate(fields?.["System.ChangedDate"]),
			};
		}

		if (type === "jira") {
			const lastChangedBy =
				extractDisplayName(fields?.updateAuthor) ??
				extractDisplayName(fields?.creator);
			return {
				lastChangedBy,
				lastChangedAt: normalizeIsoDate(fields?.updated),
			};
		}

		if (type === "linear") {
			return {
				lastChangedBy: extractDisplayName(data.updatedBy),
				lastChangedAt: normalizeIsoDate(data.updatedAt),
			};
		}

		if (type === "fizzy") {
			// Fizzy cards expose `last_active_at` (when the card was last touched)
			// but no "last changed by" — only `creator`, the original author, which
			// would mislabel a months-old creator as the recent editor in a
			// conflict dialog. So surface the date and leave the author unknown.
			return {
				lastChangedBy: null,
				lastChangedAt: normalizeIsoDate(data.last_active_at),
			};
		}

		return empty;
	} catch {
		return empty;
	}
}

/**
 * Read a single PM ticket via the adapter's `taskGet` capability.
 *
 * Return contract:
 * - `null` ONLY when the adapter does not expose `taskGet`. Callers treat this
 *   as "no baseline available, no conflict possible".
 * - Throws on adapter-reported failure or unparsable response so callers
 *   cannot mistake a fetch error for "no conflict" and silently overwrite the
 *   PM ticket. Adapter failures are retryable; parse failures are not.
 */
export async function fetchPmTicket(
	input: FetchPmTicketInput,
): Promise<PmTicketSnapshot | null> {
	const {
		mcpConfigId,
		userId,
		organizationId,
		capabilities,
		externalId,
		containerId,
		containerName,
		additionalContext,
	} = input;

	const taskGet = capabilities.taskGet;
	if (!taskGet) {
		return null;
	}

	const isADO = capabilities.detectedType === "azure-devops";
	const containerValue = isADO ? (containerName ?? containerId) : containerId;

	const args: Record<string, unknown> = {
		[taskGet.idParam]: isADO ? Number(externalId) : externalId,
	};

	const projectParamNames = new Set(["project", "projectId", "project_id"]);

	for (const param of taskGet.additionalRequiredParams) {
		if (projectParamNames.has(param)) {
			args[param] = containerValue;
		} else if (additionalContext?.[param]) {
			args[param] = additionalContext[param];
		}
	}

	// Also fill optional project-like params (ADO marks `project` optional and
	// falls back to elicitation when missing — we already know the project).
	for (const p of taskGet.allParams) {
		if (!p.required && projectParamNames.has(p.name) && !(p.name in args)) {
			args[p.name] = containerValue;
		}
	}

	const result = await executeMcpTool({
		toolName: taskGet.toolName,
		args,
		userId,
		organizationId,
		mcpConfigId,
	});

	if (!result.success) {
		const errorOutput = result.output as
			| {
					error?: string;
					content?: Array<{ type?: string; text?: string }>;
			  }
			| undefined;
		let detail = "Unknown error";
		if (errorOutput?.error) {
			detail = String(errorOutput.error);
		} else if (Array.isArray(errorOutput?.content)) {
			const textItem = errorOutput.content.find((c) => c.type === "text");
			if (textItem?.text) {
				detail = textItem.text;
			}
		}
		logger.warn("[PM Ticket Fetch] Adapter returned failure", {
			tool: taskGet.toolName,
			externalId,
			detail,
		});
		throw new Error(
			`PM ticket fetch failed for ${externalId} via ${taskGet.toolName}: ${detail}`,
		);
	}

	let data: Record<string, unknown> = (result.output ?? {}) as Record<
		string,
		unknown
	>;

	if (Array.isArray(data.content)) {
		const textItem = (
			data.content as Array<{ type?: string; text?: string }>
		).find((c) => c.type === "text");
		if (textItem?.text) {
			try {
				data = JSON.parse(textItem.text) as Record<string, unknown>;
			} catch (err) {
				throw ApplicationFailure.nonRetryable(
					`PM ticket fetch returned unparsable JSON for ${externalId} via ${taskGet.toolName}: ${err instanceof Error ? err.message : String(err)}`,
					"PmFetchParseError",
				);
			}
		}
	}

	const fields = data.fields as Record<string, unknown> | undefined;
	const links = data._links as
		| { html?: { href?: string }; web?: { href?: string } }
		| undefined;

	// Jira (Atlassian Rovo) nests summary/description under `fields` — without
	// these the conflict dialog shows an empty PM-tool side even though the
	// ticket has content. ADO uses `fields["System.*"]`; Linear/Fizzy/GitHub
	// expose them at the top level. Jira's description comes back as an ADF
	// document, so it must be flattened to text, not read as a string.
	const title =
		((fields?.["System.Title"] as string | undefined) ??
			(typeof fields?.summary === "string"
				? fields.summary
				: undefined) ??
			(data.title as string | undefined) ??
			(data.name as string | undefined) ??
			(data.summary as string | undefined) ??
			"") ||
		"";

	const description =
		((fields?.["System.Description"] as string | undefined) ??
			descriptionToText(fields?.description) ??
			(data.description as string | undefined) ??
			(data.body as string | undefined) ??
			(data.content as string | undefined) ??
			"") ||
		"";

	const url =
		links?.html?.href ??
		links?.web?.href ??
		(data.url as string | undefined) ??
		(data.html_url as string | undefined);

	const { lastChangedBy, lastChangedAt } = parseLastChanged(
		capabilities.detectedType,
		data,
		fields,
	);

	return {
		title,
		description: typeof description === "string" ? description : "",
		url,
		lastChangedBy,
		lastChangedAt,
	};
}
