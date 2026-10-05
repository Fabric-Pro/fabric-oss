import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	type resolvePMConfigForUser,
} from "@repo/database";
import {
	findUsableGitLabConnection,
	GitLabPmOriginMismatchError,
	gitlabPmOriginMatches,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";

/**
 * Discriminated descriptor of how a project's PM tool is configured.
 *
 * - `mcp`: the project pins an MCPConfig that resolves to an enabled config
 *   for the calling user/tenant. The workflow dispatches through MCP.
 * - `rest-gitlab`: the project's MCPServer is `gitlab-official` and the
 *   caller has a usable personal GitLab connection, but no MCPConfig is
 *   pinned (GitLab tier doesn't support the official MCP endpoint).
 *   The workflow dispatches through the GitLab REST adapter.
 * - `null`: neither path resolves — the project has no usable PM target.
 *   That includes a GitLab target whose container was chosen on another
 *   GitLab instance than the caller's connection (or GitLab MCP config) is
 *   on: the container id names an unrelated project there
 *   (`recordedGitLabPmOrigin`).
 */
export type PMTarget =
	| {
			kind: "mcp";
			mcpConfigId: string;
			mcpConfig: NonNullable<
				Awaited<ReturnType<typeof resolvePMConfigForUser>>
			>;
	  }
	| { kind: "rest-gitlab"; mcpConfigId: null };

export async function resolvePmTarget(args: {
	project: {
		projectManagementMcpServerId: string | null;
		projectManagementMcpConfigId: string | null;
		/** Records which GitLab instance the selected container lives on. */
		projectManagementAdditionalContext: unknown;
		organizationId: string | null;
	};
	userId: string;
	organizationId: string | null;
}): Promise<PMTarget | null> {
	const { project, userId, organizationId } = args;

	// Path 1: MCPConfig pinned on the project. Resolve via the existing
	// per-user helper which enforces tenant ownership.
	if (project.projectManagementMcpConfigId) {
		// The caller's own GitLab MCP config may be on another instance than
		// the container: keep in step with the worker's `resolvePmSource`.
		let mcpConfig: Awaited<ReturnType<typeof resolvePMConfigForUser>>;
		try {
			mcpConfig = await resolveProjectPMConfigForUser({
				configId: project.projectManagementMcpConfigId,
				mcpServerId: project.projectManagementMcpServerId ?? undefined,
				userId,
				organizationId: organizationId ?? undefined,
				pmAdditionalContext: project.projectManagementAdditionalContext,
			});
		} catch (error) {
			if (error instanceof GitLabPmOriginMismatchError) {
				return null;
			}
			throw error;
		}
		if (!mcpConfig?.enabled) {
			return null;
		}
		return {
			kind: "mcp",
			mcpConfigId: project.projectManagementMcpConfigId,
			mcpConfig,
		};
	}

	// Path 2: GitLab REST fallback. Requires the project's server to be
	// gitlab-official (or the `key:gitlab-official` sentinel, when the
	// catalog row is missing — PR #1205 / seed drift) AND a usable personal
	// GitLab connection for the caller.
	if (!project.projectManagementMcpServerId) {
		return null;
	}

	let serverKey: string | null;
	if (isPmServerIdKeySentinel(project.projectManagementMcpServerId)) {
		serverKey = readPmServerIdKeySentinel(
			project.projectManagementMcpServerId,
		);
	} else {
		const server = await db.mCPServer.findUnique({
			where: { id: project.projectManagementMcpServerId },
			select: { key: true },
		});
		serverKey = server?.key ?? null;
	}
	if (serverKey !== "gitlab-official") {
		return null;
	}

	// The caller's OWN GitLab connection only (exclusive tenant: the
	// (userId, organizationId) connection in org context, (userId, null) in
	// personal context). This UI/capability check must agree with the
	// worker's resolver (temporal `pm-source.ts`), which acts through the
	// caller's own connection and never a teammate's. The connection service
	// reports a reconnect-required one as unusable — the same "not
	// connected" the worker reports. A legacy `gitlab-official` MCP token
	// copy is not a connection.
	const connection = await findUsableGitLabConnection({
		userId,
		organizationId: organizationId ?? null,
	});
	if (!connection) {
		return null;
	}
	// The container must be on the caller's connection's instance — the
	// worker refuses any other, so the UI must not offer it either.
	if (
		!gitlabPmOriginMatches(
			project.projectManagementAdditionalContext,
			connection.origin,
		)
	) {
		return null;
	}

	return { kind: "rest-gitlab", mcpConfigId: null };
}
