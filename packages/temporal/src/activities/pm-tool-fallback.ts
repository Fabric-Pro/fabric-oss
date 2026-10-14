import { isProjectReadOnly } from "@repo/database";
import {
	GITLAB_REST_CAPABILITIES,
	GitLabPmOriginMismatchError,
} from "@repo/integrations/gitlab";
import {
	createGitLabIssueFromStory,
	getGitLabIssueForPM,
	listGitLabIssuesForPM,
	updateGitLabIssueFromStory,
} from "@repo/integrations/gitlab/pm-adapter";
import { READ_ONLY_MODE_MESSAGE } from "@repo/utils";
import { runWithDispatchDeadline } from "@repo/utils/dispatch-deadline";
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
	/**
	 * Aborts a GitLab REST `createItem` request in flight when it expires
	 * (the PM create's send ceiling, `PM_CREATE_SEND_TIMEOUT_MS`); the
	 * signal is forwarded to the REST request. Other calls ignore it.
	 */
	signal?: AbortSignal;
	/**
	 * The latest the REST request may be sent, on this process's monotonic
	 * clock (a PM create's `startPmCreateSendDeadline`). The GitLab POST
	 * compares the clock with it immediately before `fetch` and, past it,
	 * throws `DispatchDeadlinePassedError` without sending.
	 */
	dispatchDeadline?: number;
}): Promise<unknown> {
	const {
		source,
		call,
		userId,
		organizationId,
		fabricProjectId,
		signal,
		dispatchDeadline,
	} = args;

	if (
		(call.tool === "createItem" || call.tool === "updateItem") &&
		fabricProjectId &&
		(await isProjectReadOnly(fabricProjectId))
	) {
		throw ApplicationFailure.nonRetryable(READ_ONLY_MODE_MESSAGE);
	}

	// Adapt the temporal-side rest-gitlab source to the GitLab REST adapter's
	// GitLabSource shape, keeping the instance the token was issued by.
	const gitlabSource = {
		kind: "rest-adapter" as const,
		credential: { token: source.token, apiBase: source.baseUrl },
	};

	const send = () =>
		dispatchRest(gitlabSource, source.projectId, call, {
			userId,
			organizationId,
			signal,
		});
	try {
		return await (dispatchDeadline === undefined
			? send()
			: runWithDispatchDeadline(dispatchDeadline, send));
	} catch (error) {
		// The adapter keeps every request on the instance `resolvePmSource`
		// checked; a connection that moved to another one since is refused,
		// and retrying cannot change that.
		if (error instanceof GitLabPmOriginMismatchError) {
			throw ApplicationFailure.nonRetryable(
				error.message,
				"GitLabPmOriginMismatch",
			);
		}
		throw error;
	}
}

async function dispatchRest(
	gitlabSource: {
		kind: "rest-adapter";
		credential: { token: string; apiBase: string };
	},
	gitlabProjectId: string,
	call: PMToolCall,
	tenant: {
		userId: string;
		organizationId: string | null;
		signal?: AbortSignal;
	},
): Promise<unknown> {
	const { userId, organizationId, signal } = tenant;
	switch (call.tool) {
		case "listWorkItems":
			return listGitLabIssuesForPM({
				source: gitlabSource,
				gitlabProjectId,
				userId,
				organizationId,
				...call.filters,
			} as never);
		case "fetchItem":
			return getGitLabIssueForPM({
				source: gitlabSource,
				gitlabProjectId,
				externalId: call.externalId,
				userId,
				organizationId,
			});
		case "createItem":
			return createGitLabIssueFromStory({
				source: gitlabSource,
				gitlabProjectId,
				payload: call.payload as never,
				userId,
				organizationId,
				signal,
			});
		case "updateItem":
			return updateGitLabIssueFromStory({
				source: gitlabSource,
				gitlabProjectId,
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
