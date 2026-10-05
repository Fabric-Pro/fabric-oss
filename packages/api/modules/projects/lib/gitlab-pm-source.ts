import { ORPCError } from "@orpc/server";
import {
	GitLabPmOriginMismatchError,
	requireRecordedGitLabPmOrigin,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { McpGitLabOriginMismatchError } from "@repo/mcp";

/**
 * For `resolveGitLabPMSource(...).catch(...)` in a procedure: a caller whose
 * GitLab connection is on another GitLab instance than the project's PM
 * container gets a BAD_REQUEST they can act on (connect GitLab on the
 * project's instance) instead of a server error. Anything else is rethrown.
 */
export function rethrowGitLabPmOriginMismatch(error: unknown): never {
	if (
		error instanceof GitLabPmOriginMismatchError ||
		error instanceof McpGitLabOriginMismatchError ||
		isWorkerGitLabPmOriginRefusal(error)
	) {
		throw new ORPCError("BAD_REQUEST", { message: error.message });
	}
	throw error;
}

/**
 * The worker's refusal of a PM call bound to another GitLab instance (an
 * `ApplicationFailure` of type `GitLabPmOriginMismatch`, from
 * `executeMcpTool` or an activity run in-process).
 */
function isWorkerGitLabPmOriginRefusal(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error as { type?: unknown }).type === "GitLabPmOriginMismatch"
	);
}

/**
 * The GitLab instance a procedure's MCP client must be bound to before it
 * sends the project's PM container anywhere (`expectedGitLabOrigin`). An
 * unusable recorded instance is the same BAD_REQUEST as a mismatch.
 */
export function projectGitLabPmOrigin(pmAdditionalContext: unknown): string {
	try {
		return requireRecordedGitLabPmOrigin(pmAdditionalContext);
	} catch (error) {
		return rethrowGitLabPmOriginMismatch(error);
	}
}

/**
 * The calling user's own MCP config for a project's PM tool
 * (`resolveProjectPMConfigForUser`), for a procedure: a personal GitLab
 * config on another instance than the project's selected container is a
 * BAD_REQUEST with the instance message, before anything is read or written
 * through it. Every procedure resolves the caller's PM config through here
 * or `resolvePmTarget`; a guard test keeps direct `resolvePMConfigForUser`
 * calls out of this package.
 */
export function resolveProjectPmConfig(
	args: Parameters<typeof resolveProjectPMConfigForUser>[0],
): ReturnType<typeof resolveProjectPMConfigForUser> {
	return resolveProjectPMConfigForUser(args).catch(
		rethrowGitLabPmOriginMismatch,
	);
}
