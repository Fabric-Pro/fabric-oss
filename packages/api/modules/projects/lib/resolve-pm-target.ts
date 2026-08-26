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

	// The GitLab REST connection belongs to the project/org, not the individual
	// user who set it up — code-repo integrations resolve per-project so any
	// teammate can sync, and this UI/capability check must agree with the
	// worker's resolver (pm-source.ts). Prefer the caller's own integration; in
	// ORG context fall back to any active org GitLab integration. Personal
	// projects (organizationId === null) stay strictly user-scoped.
	const ownIntegration = await db.workflowIntegration.findFirst({
		where: organizationId
			? { organizationId, userId, provider: "GITLAB", isActive: true }
			: {
					organizationId: null,
					userId,
					provider: "GITLAB",
					isActive: true,
				},
		select: { id: true },
	});
	const integration =
		ownIntegration ??
		(organizationId
			? await db.workflowIntegration.findFirst({
					where: {
						organizationId,
						provider: "GITLAB",
						isActive: true,
					},
					select: { id: true },
				})
			: null);
	if (!integration) {
		return null;
	}

	return { kind: "rest-gitlab", mcpConfigId: null };
}
