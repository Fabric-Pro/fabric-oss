/**
 * Whether a GitLab personal MCP server config (`gitlab`, `gitlab-official`)
 * may be used right now: the person's GitLab connection decides, exactly as
 * it does on every other GitLab screen. The config's own token columns are a
 * legacy copy (a connection made since the connection service took over
 * leaves them empty), so gating on them would refuse a connected person and
 * could pass a disconnected one.
 *
 * Returns null when the connection is usable, otherwise the message to show.
 *
 * The caller authorizes `tenant.organizationId` (membership and role there)
 * before calling: with an organization this read can classify (write) a
 * legacy connection row in it. With no organization it only inspects, so a request
 * that resolved no tenant never writes a no-organization connection row.
 */

import {
	inspectGitLabPersonalConnection,
	readGitLabPersonalConnection,
} from "@repo/integrations/gitlab";

export async function gitlabMcpConnectionBlocker(tenant: {
	userId: string;
	organizationId: string | null | undefined;
}): Promise<string | null> {
	const summary = tenant.organizationId
		? (
				await readGitLabPersonalConnection({
					userId: tenant.userId,
					organizationId: tenant.organizationId,
				})
			).summary
		: await inspectGitLabPersonalConnection({
				userId: tenant.userId,
				organizationId: null,
			});
	if (summary.state === "connected") {
		return null;
	}
	return summary.state === "needs-reconnect"
		? "Your GitLab connection needs to be reconnected. Reconnect GitLab to continue."
		: "GitLab is not connected. Connect GitLab first.";
}
