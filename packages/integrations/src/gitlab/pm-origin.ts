/**
 * Which GitLab instance a project's selected PM container lives on.
 *
 * A project stores its GitLab PM container as a bare GitLab project id (or
 * path). An id names a project only on one instance: project `42` on
 * gitlab.com and project `42` on a self-hosted GitLab are unrelated. Every PM
 * read, upload and write runs on the ACTING person's GitLab connection (or
 * their own GitLab MCP config), which may be on a different instance than the
 * one the container was chosen on — another member's, or the same person's
 * after reconnecting elsewhere. So the instance is recorded next to the
 * container, in `Project.projectManagementAdditionalContext` under
 * `gitlabOrigin`, and an actor on any other instance is refused.
 *
 * A selection made before the origin was recorded has none: it was made on
 * gitlab.com, the only instance GitLab PM supported then, and reads as such.
 * The recorded value is set by the server when a container is chosen or
 * auto-wired; a value supplied by a client is never trusted.
 */

import {
	GITLAB_DEFAULT_ORIGIN,
	type GitLabOriginCheck,
	parseGitLabOrigin,
} from "./outbound";

/** Key in `Project.projectManagementAdditionalContext`. */
export const GITLAB_PM_ORIGIN_KEY = "gitlabOrigin";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/**
 * The instance a project's selected GitLab PM container lives on: the
 * recorded origin, or gitlab.com when none is recorded (a legacy selection).
 * A recorded value that is not an allowed GitLab address is refused.
 */
export function recordedGitLabPmOrigin(
	additionalContext: unknown,
): GitLabOriginCheck {
	const value = asRecord(additionalContext)?.[GITLAB_PM_ORIGIN_KEY];
	if (value === undefined || value === null || value === "") {
		return { ok: true, origin: GITLAB_DEFAULT_ORIGIN };
	}
	return parseGitLabOrigin(value);
}

/**
 * Whether an actor whose GitLab connection (or GitLab MCP config) is on
 * `actorOrigin` may act on the project's selected container. An unknown
 * actor origin, or an unusable recorded one, never matches.
 */
export function gitlabPmOriginMatches(
	additionalContext: unknown,
	actorOrigin: string | null | undefined,
): boolean {
	if (!actorOrigin) {
		return false;
	}
	const recorded = recordedGitLabPmOrigin(additionalContext);
	return recorded.ok && recorded.origin === actorOrigin;
}

/**
 * `additionalContext` with the recorded origin replaced by `origin` (removed
 * when null); every other key is kept as is.
 */
export function withGitLabPmOrigin(
	additionalContext: unknown,
	origin: string | null,
): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...(asRecord(additionalContext) ?? {}),
	};
	if (origin) {
		next[GITLAB_PM_ORIGIN_KEY] = origin;
	} else {
		delete next[GITLAB_PM_ORIGIN_KEY];
	}
	return next;
}

/** The message shown when an actor's GitLab is on another instance. */
export const GITLAB_PM_ORIGIN_MISMATCH_MESSAGE =
	"This project's GitLab project is on a different GitLab instance than your GitLab connection.";

/**
 * The calling user's GitLab (their connection, or their own GitLab MCP
 * config) is on another GitLab instance than the one the project's PM
 * container was chosen on (`recordedGitLabPmOrigin`) — or it moved to
 * another instance between the check and the request.
 */
export class GitLabPmOriginMismatchError extends Error {
	override name = "GitLabPmOriginMismatchError";
	constructor() {
		super(GITLAB_PM_ORIGIN_MISMATCH_MESSAGE);
	}
}

/**
 * The instance a request for the project's selected GitLab PM container must
 * go to (`recordedGitLabPmOrigin`), for binding an MCP client to it. A
 * recorded value that is not an allowed GitLab address binds to nothing, so
 * it is refused as a mismatch rather than read as "no binding".
 */
export function requireRecordedGitLabPmOrigin(
	additionalContext: unknown,
): string {
	const recorded = recordedGitLabPmOrigin(additionalContext);
	if (!recorded.ok) {
		throw new GitLabPmOriginMismatchError();
	}
	return recorded.origin;
}
