import { decryptApiKey } from "@repo/utils";

/**
 * Shared Azure DevOps work-item-type resolution.
 *
 * The ADO MCP server exposes no "list work item types" tool, so the only proven
 * type-lister is the REST `_apis/wit/workitemtypes` endpoint. Both the
 * `listProjectWorkItemTypes` procedure (create-flow type picker) and the new
 * `enumerateFields` procedure (field read-mapping) need the same list, so the
 * REST fetch + org resolution + system-type filter live here, single-sourced.
 */

/** Minimal shape of a resolved PM config this helper reads (from `resolvePMConfigForUser`). */
export interface AdoConfigForTypes {
	mcpServer?: { key?: string | null; command?: string | null } | null;
	encryptedApiKey?: string | null;
	commandArgs?: unknown;
	baseUrl?: string | null;
}

interface AdoWorkItemType {
	name: string;
	description: string | null;
}

export type FetchAdoWorkItemTypesResult =
	| { types: AdoWorkItemType[]; error: null }
	| { types: []; error: string };

/**
 * System/internal and hierarchy types excluded from the pickable set — Epic is
 * auto-mapped and the test/review/shared types are never authored as stories.
 */
const EXCLUDED_TYPES = new Set([
	"Epic",
	"Task",
	"Code Review Request",
	"Code Review Response",
	"Feedback Request",
	"Feedback Response",
	"Shared Steps",
	"Shared Parameter",
	"Test Case",
	"Test Plan",
	"Test Suite",
]);

/** True when the resolved config points at an Azure DevOps MCP server. */
export function isAzureDevOpsConfig(config: AdoConfigForTypes): boolean {
	return (
		config.mcpServer?.key === "azure-devops" ||
		!!config.mcpServer?.command?.includes("azure-devops")
	);
}

/**
 * Resolve the ADO organization name from a PM config: `commandArgs[0]` is the
 * canonical source; fall back to parsing the base URL
 * (`https://dev.azure.com/{org}` or `{org}.visualstudio.com`).
 */
function resolveAdoOrg(config: AdoConfigForTypes): string | null {
	let org =
		Array.isArray(config.commandArgs) && config.commandArgs.length > 0
			? String(config.commandArgs[0]).trim()
			: null;

	if (!org && config.baseUrl) {
		try {
			const url = new URL(config.baseUrl);
			const pathMatch = url.pathname.match(/^\/([^/]+)/);
			if (pathMatch) {
				org = pathMatch[1];
			} else if (url.hostname.endsWith(".visualstudio.com")) {
				org = url.hostname.replace(".visualstudio.com", "");
			}
		} catch {
			// ignore malformed base URL — org stays null and the caller errors
		}
	}

	return org || null;
}

/**
 * Fetch the pickable Azure DevOps work item type names for a container (project)
 * via the ADO REST API, using the PAT from the resolved MCP config. Returns a
 * defensive `{ types, error }` shape (never throws on API failure) so callers can
 * surface a retryable UI state.
 *
 * @see https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-item-types/list
 */
export async function fetchAdoWorkItemTypes(params: {
	config: AdoConfigForTypes;
	containerId: string;
}): Promise<FetchAdoWorkItemTypesResult> {
	const { config, containerId } = params;

	if (!isAzureDevOpsConfig(config)) {
		return {
			types: [],
			error: "Work item type listing is only supported for Azure DevOps",
		};
	}

	if (!config.encryptedApiKey) {
		return {
			types: [],
			error: "Azure DevOps connection has no API key (PAT) configured",
		};
	}

	const org = resolveAdoOrg(config);
	if (!org) {
		return {
			types: [],
			error: "Azure DevOps organization not found. Configure org in MCP settings (command args or base URL).",
		};
	}

	const apiUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(containerId)}/_apis/wit/workitemtypes?api-version=7.1`;

	try {
		const pat = decryptApiKey(config.encryptedApiKey);
		const auth = Buffer.from(`:${pat}`).toString("base64");
		const res = await fetch(apiUrl, {
			headers: {
				Authorization: `Basic ${auth}`,
				Accept: "application/json",
			},
		});

		if (!res.ok) {
			const body = await res.text();
			return {
				types: [],
				error: `Azure DevOps API error (${res.status}): ${body.slice(0, 200)}`,
			};
		}

		const data = (await res.json()) as {
			value?: Array<{ name?: string; description?: string }>;
		};

		const raw = Array.isArray(data.value)
			? data.value
			: Array.isArray(data)
				? (data as Array<{ name?: string; description?: string }>)
				: [];

		const types = raw
			.filter((t) => t?.name && !EXCLUDED_TYPES.has(String(t.name)))
			.map((t) => ({
				name: String(t.name),
				description: t.description ? String(t.description) : null,
			}));

		return { types, error: null };
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Unknown error";
		return {
			types: [],
			error: `Failed to fetch work item types: ${msg}`,
		};
	}
}
