import { isProjectReadOnly } from "@repo/database";
import { GITLAB_REST_CAPABILITIES } from "@repo/integrations/gitlab";
import {
	createGitLabIssueFromStory,
	getGitLabIssueForPM,
	listGitLabIssuesForPM,
	updateGitLabIssueFromStory,
} from "@repo/integrations/gitlab/pm-adapter";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { ApplicationFailure } from "@temporalio/common";
import type { PMSource } from "./pm-source";

/**
 * Logical PM tool calls — provider-agnostic operations the workflow
 * dispatches. Each variant carries the args the operation needs.
 */
export type PMToolCall =
	| { tool: "listWorkItems"; filters: Record<string, unknown> }
	| { tool: "fetchItem"; externalId: string }
	| { tool: "createItem"; payload: Record<string, unknown> }
	| {
			tool: "updateItem";
			externalId: string;
			payload: Record<string, unknown>;
	  }
	| { tool: "discoverCapabilities" };

// Re-exported for backward-compat with internal callers (story-sync.ts).
// Prefer `@repo/integrations/gitlab` for new code.
export { GITLAB_REST_CAPABILITIES };

/**
 * REST-only dispatcher. Routes a logical PMToolCall to the GitLab REST
 * adapter when the resolved PMSource is `rest-gitlab`. The MCP path is
 * handled directly by each activity (since each activity already knows
 * which MCP tool name to invoke for its operation) — calling this with
 * an MCP source is a programming error.
 *
 * Activities use the pattern:
 *   const source = await resolvePmSource(...);
 *   if (source.kind === "rest-gitlab") {
 *     return callPmToolWithFallback({ source, call, userId, organizationId });
 *   }
 *   // else: existing MCP code path unchanged, with source.mcpConfig in scope.
 */
export async function callPmToolWithFallback(args: {
	source: Extract<PMSource, { kind: "rest-gitlab" }>;
	call: PMToolCall;
	userId: string;
	organizationId: string | null;
	/**
	 * Fabric project id for the Read-only mode write-gate.
	 * Write dispatches (`createItem`/`updateItem`) MUST pass it — this REST
	 * path bypasses the MCP chokepoint gate in execute-mcp-tool.ts, so this
	 * is the final Fabric-owned code before the GitLab REST call.
	 */
	fabricProjectId?: string | null;
}): Promise<unknown> {
	const { source, call, userId, organizationId, fabricProjectId } = args;

	if (
		(call.tool === "createItem" || call.tool === "updateItem") &&
		fabricProjectId &&
		(await isProjectReadOnly(fabricProjectId))
	) {
		throw ApplicationFailure.nonRetryable(READ_ONLY_MODE_MESSAGE);
	}

	// Adapt the temporal-side rest-gitlab source to the GitLab REST adapter's
	// GitLabSource shape: { kind: "rest-adapter", token }.
	const gitlabSource = {
		kind: "rest-adapter" as const,
		token: source.token,
	};

	switch (call.tool) {
		case "listWorkItems":
			return listGitLabIssuesForPM({
				source: gitlabSource,
				gitlabProjectId: source.projectId,
				userId,
				organizationId,
				...call.filters,
			} as never);
		case "fetchItem":
			return getGitLabIssueForPM({
				source: gitlabSource,
				gitlabProjectId: source.projectId,
				externalId: call.externalId,
				userId,
				organizationId,
			});
		case "createItem":
			return createGitLabIssueFromStory({
				source: gitlabSource,
				gitlabProjectId: source.projectId,
				payload: call.payload as never,
				userId,
				organizationId,
			});
		case "updateItem":
			return updateGitLabIssueFromStory({
				source: gitlabSource,
				gitlabProjectId: source.projectId,
				externalId: call.externalId,
				payload: call.payload as never,
				userId,
				organizationId,
			});
		case "discoverCapabilities":
			return { ...GITLAB_REST_CAPABILITIES };
		default: {
			const exhaustive: never = call;
			throw new Error(
				`Unknown tool: ${(exhaustive as { tool: string }).tool}`,
			);
		}
	}
}
