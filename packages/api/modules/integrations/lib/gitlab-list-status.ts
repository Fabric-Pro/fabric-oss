/**
 * GitLab rows in the workflow-integration lists (`workflows.integrations.list`
 * and `.listStatus`) report the person's GitLab connection as every other
 * GitLab screen does, not the raw row.
 *
 * A raw row answers the wrong question: an active row whose grant is dead
 * (`needsReauth`) still has credentials, so the catalog called it connected
 * while the GitLab page asked for a reconnect. And a legacy row with no
 * recorded issuer is classified (or marked reconnect-required) on its first
 * service read. So the lists read the connection first (which classifies
 * it) and then let its state decide `hasCredentials` for the person's own
 * connection row.
 *
 * Only the caller's own personal connection row is rewritten. GitLab is a
 * personal-only provider (never shared to an organization), so no other
 * member's GitLab row reaches these lists; a workflow-scoped GitLab
 * credential is a separate secret managed with its workflow and keeps its
 * raw answer.
 */

import {
	type GitLabPersonalConnectionState,
	inspectGitLabPersonalConnection,
	readGitLabPersonalConnection,
} from "@repo/integrations/gitlab";

/**
 * The caller's GitLab connection state, or null when the list cannot contain
 * a GitLab row (it is filtered to another provider).
 */
export async function readGitLabStateForList(args: {
	userId: string;
	organizationId: string | null | undefined;
	provider?: string;
}): Promise<GitLabPersonalConnectionState | null> {
	if (args.provider && args.provider !== "GITLAB") {
		return null;
	}
	// No organization resolved: report without classifying, so a request with
	// no tenant never writes a no-organization connection row (ADR-018: that
	// state is a resolution failure, not a personal workspace). The callers
	// verify the caller's membership of a resolved organization first.
	if (!args.organizationId) {
		const summary = await inspectGitLabPersonalConnection({
			userId: args.userId,
			organizationId: null,
		});
		return summary.state;
	}
	const { summary } = await readGitLabPersonalConnection({
		userId: args.userId,
		organizationId: args.organizationId,
	});
	return summary.state;
}

/**
 * The status a list row reports when it is the caller's own GitLab connection
 * row; null for every other row (which keeps its raw answer).
 */
export function gitlabConnectionRowStatus(
	row: {
		provider: string;
		userId?: string | null;
		workflowId?: string | null;
		name: string;
	},
	callerId: string,
	state: GitLabPersonalConnectionState | null,
): {
	hasCredentials: boolean;
	connectionState: GitLabPersonalConnectionState;
} | null {
	if (
		state === null ||
		row.provider !== "GITLAB" ||
		row.workflowId ||
		row.name === "GITLAB_OAUTH_APP" ||
		row.userId !== callerId
	) {
		return null;
	}
	return { hasCredentials: state === "connected", connectionState: state };
}
