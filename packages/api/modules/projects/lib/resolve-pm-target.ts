import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";

/**
 * Discriminated descriptor of how a project's PM tool is configured.
 *
 * - `mcp`: the project pins an MCPConfig that resolves to an enabled config
 *   for the calling user/tenant. The workflow dispatches through MCP.
 * - `rest-gitlab`: the project's MCPServer is `gitlab-official` and the
 *   tenant has an active `WorkflowIntegration{provider=GITLAB}`, but no
 *   MCPConfig (GitLab tier doesn't support the official MCP endpoint).
 *   The workflow dispatches through the GitLab REST adapter.
 * - `null`: neither path resolves — the project has no usable PM target.
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
		organizationId: string | null;
	};
	userId: string;
	organizationId: string | null;
}): Promise<PMTarget | null> {
	const { project, userId, organizationId } = args;

	// Path 1: MCPConfig pinned on the project. Resolve via the existing
	// per-user helper which enforces tenant ownership.
	if (project.projectManagementMcpConfigId) {
		const mcpConfig = await resolvePMConfigForUser({
			configId: project.projectManagementMcpConfigId,
			mcpServerId: project.projectManagementMcpServerId ?? undefined,
			userId,
			organizationId: organizationId ?? undefined,
		});
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
	// catalog row is missing — PR #1205 / seed drift) AND an active
	// WorkflowIntegration for this tenant.
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

	// The caller's OWN GitLab connection only (XOR tenant isolation: org
	// context filters by organizationId AND userId). This UI/capability check
	// must agree with the worker's resolver (temporal `pm-source.ts`), which
	// acts through the caller's own connection and never a teammate's.
	const integration = await db.workflowIntegration.findFirst({
		where: organizationId
			? {
					organizationId,
					userId,
					provider: "GITLAB",
					isActive: true,
					NOT: { name: "GITLAB_OAUTH_APP" },
				}
			: {
					organizationId: null,
					userId,
					provider: "GITLAB",
					isActive: true,
					NOT: { name: "GITLAB_OAUTH_APP" },
				},
		select: { id: true },
	});
	if (!integration) {
		return null;
	}

	return { kind: "rest-gitlab", mcpConfigId: null };
}
