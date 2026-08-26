import { db, resolvePMConfigForUser } from "@repo/database";
import { logger } from "@repo/logs";

export interface ResolveApplyPmConfigInput {
	projectId: string;
	userId: string;
	organizationId?: string;
}

export type ResolveApplyPmConfigResult =
	| {
			resolved: true;
			/** `null` routes the push through the GitLab REST fallback. */
			mcpConfigId: string | null;
			mcpServerId?: string;
			containerId: string;
			containerName?: string;
			additionalContext?: Record<string, string>;
	  }
	| {
			resolved: false;
			reason: "no-pm-config" | "user-not-connected";
	  };

/**
 * Resolve the PM config to use for a backlog-apply / proposal push, SERVER-SIDE,
 * for the applying user — independent of whatever (possibly absent) `pmConfig`
 * the frontend supplied.
 *
 * This is the same resolution `enqueuePmSync` runs on the (already-reliable)
 * CREATE path, lifted into an activity so the UPDATE / AI-Update apply workflow
 * can use it too. Without it, the workflow trusted the FE `pmConfig`, which the
 * client sets to `undefined` whenever the applying user can't resolve their OWN
 * MCP config (teammate-configured tool or GitLab-REST project) — so the push was
 * silently skipped and "Also sync to PM tool" appeared unreliable.
 *
 * Resolution order (mirrors `enqueuePmSync`):
 *   1. Pinned per-user MCP config → resolve the CALLER's own config of the same
 *      server type (the pinned id belongs to whoever set the integration up).
 *   2. No resolvable user config but the project's PM tool is GitLab
 *      (`key:gitlab-official`) → REST fallback (`mcpConfigId: null`).
 *   3. Otherwise unresolvable → `{ resolved: false }` so the caller can surface
 *      an actionable warning instead of a silent no-op.
 */
export async function resolveApplyPmConfig(
	input: ResolveApplyPmConfigInput,
): Promise<ResolveApplyPmConfigResult> {
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: {
			organizationId: true,
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementContainerName: true,
			projectManagementAdditionalContext: true,
		},
	});

	if (!project || !project.projectManagementContainerId) {
		return { resolved: false, reason: "no-pm-config" };
	}

	const isGitLabProject =
		project.projectManagementMcpServerId === "key:gitlab-official";
	const base = {
		mcpServerId: project.projectManagementMcpServerId ?? undefined,
		containerId: project.projectManagementContainerId,
		containerName: project.projectManagementContainerName ?? undefined,
		additionalContext:
			(project.projectManagementAdditionalContext as Record<
				string,
				string
			> | null) ?? undefined,
	};

	if (!project.projectManagementMcpConfigId) {
		// No per-user MCP was ever wired. GitLab → REST fallback; anything else
		// is an unconfigured PM tool.
		if (isGitLabProject) {
			return { resolved: true, mcpConfigId: null, ...base };
		}
		return { resolved: false, reason: "no-pm-config" };
	}

	const userMcpConfig = await resolvePMConfigForUser({
		configId: project.projectManagementMcpConfigId,
		mcpServerId: project.projectManagementMcpServerId,
		userId: input.userId,
		organizationId: project.organizationId ?? undefined,
	});

	if (userMcpConfig?.enabled) {
		return { resolved: true, mcpConfigId: userMcpConfig.id, ...base };
	}

	if (isGitLabProject) {
		// Caller has no own GitLab MCP, but the project does have GitLab
		// configured — route through REST so the sync still reaches GitLab.
		logger.info("resolveApplyPmConfig GitLab REST fallback", {
			projectId: input.projectId,
			userId: input.userId,
		});
		return { resolved: true, mcpConfigId: null, ...base };
	}

	logger.warn("resolveApplyPmConfig: caller has no resolvable MCP config", {
		projectId: input.projectId,
		userId: input.userId,
		pinnedConfigId: project.projectManagementMcpConfigId,
		pinnedServerId: project.projectManagementMcpServerId,
	});
	return { resolved: false, reason: "user-not-connected" };
}
