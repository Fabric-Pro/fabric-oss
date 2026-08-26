export type GitLabMcpProbeStatus =
	| "ok"
	| "unauthorized"
	| "not-found"
	| "network-error"
	| "timeout";

export type GitLabMcpProbeRecord = {
	status: GitLabMcpProbeStatus;
	httpStatus: number | null;
	checkedAt: string;
	baseUrl: string;
};

/**
 * Shape of `WorkflowIntegration.settings` for the GitLab provider.
 * Other (pre-existing) fields are intentionally untyped here — they're
 * read by older code paths that consume the raw JSON.
 */
export type GitLabIntegrationSettings = {
	useOfficialMcp?: boolean;
	mcpProbe?: GitLabMcpProbeRecord | null;
	[k: string]: unknown;
};

/**
 * Reader contract:
 *   true       → probe said capable; resolver should pick official MCP
 *   false      → probe said not capable; resolver should pick REST
 *   "legacy"   → flag absent (pre-probe row); resolver falls through to
 *                today's MCPConfig-presence-wins behavior
 */
export function readUseOfficialMcp(
	settings: GitLabIntegrationSettings | null | undefined,
): true | false | "legacy" {
	if (!settings || typeof settings !== "object") {
		return "legacy";
	}
	if (settings.useOfficialMcp === true) {
		return true;
	}
	if (settings.useOfficialMcp === false) {
		return false;
	}
	return "legacy";
}
