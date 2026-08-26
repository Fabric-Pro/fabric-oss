import { db } from "@repo/database";
import { gitlabFetch } from "@repo/integrations/gitlab";
import { type GitLabUserIdentity, persistGitLabToken } from "./gitlab-token";

/**
 * PM-tool server keys that we are allowed to overwrite when auto-wiring. A
 * project already pointed at a non-GitLab PM tool (e.g. Jira) is left
 * untouched — we only populate the credential stores so GitLab becomes
 * selectable, never clobber an explicit choice.
 */
const GITLAB_PM_SERVER_KEYS = new Set(["gitlab", "gitlab-official"]);

export type EnableGitLabPMResult =
	| { pmWired: true; containerId: string }
	| {
			pmWired: false;
			reason: "project-not-found" | "other-pm-tool-configured";
	  };

/**
 * Make a GitLab connection usable as a project's PM tool from the SAME token
 * that was issued for the codebase/repo connection.
 *
 * Two steps:
 *  1. Dual-write the token into `WorkflowIntegration` + `MCPConfig` (via
 *     `persistGitLabToken`, which also runs the MCP tier probe). This is what
 *     lets `get-pm-capabilities` resolve the user for GitLab PM.
 *  2. Auto-wire the project's PM pointer at the `gitlab-official` server with
 *     the connected GitLab project as the container. `projectManagementMcpConfigId`
 *     is left null on purpose: the capabilities resolver then routes MCP vs
 *     REST automatically based on whether a `gitlab-official` MCPConfig exists
 *     (the tier probe controls that), so the Pull button appears either way.
 *
 * Best-effort by contract: callers wrap this so a failure never fails the repo
 * connection.
 */
export async function enableGitLabPMForProject(args: {
	userId: string;
	organizationId: string | null;
	projectId: string;
	repositoryOwner: string;
	repositoryName: string;
	token: {
		accessToken: string;
		refreshToken: string | null;
		expiresAt: Date | null;
		scopes: string[];
	};
	gitlabUser: GitLabUserIdentity;
	/**
	 * Whether `token` came from an OAuth authorization-code exchange the
	 * caller just completed. Forwarded to `persistGitLabToken` as its
	 * circuit-breaker reset authority — see `PersistTokenInput.freshGrant`.
	 *
	 * Defaults to `false` because this helper has callers on both sides: the
	 * project-target OAuth callback holds a new grant, while the PM backfill
	 * script replays a token it decrypted out of the database and must not be
	 * able to clear a condemned credential.
	 */
	freshGrant?: boolean;
}): Promise<EnableGitLabPMResult> {
	// 1. Dual-write credential stores (+ tier probe). Always runs so the user's
	//    WorkflowIntegration/MCPConfig exist even if the pointer is left alone.
	await persistGitLabToken(db as never, {
		userId: args.userId,
		organizationId: args.organizationId,
		token: args.token,
		gitlabUser: args.gitlabUser,
		freshGrant: args.freshGrant ?? false,
	});

	// 2. Clobber guard — never overwrite a deliberately-set non-GitLab PM tool.
	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: { projectManagementMcpServerId: true },
	});
	if (!project) {
		return { pmWired: false, reason: "project-not-found" };
	}
	if (project.projectManagementMcpServerId) {
		const existing = await db.mCPServer.findUnique({
			where: { id: project.projectManagementMcpServerId },
			select: { key: true },
		});
		if (existing && !GITLAB_PM_SERVER_KEYS.has(existing.key)) {
			return { pmWired: false, reason: "other-pm-tool-configured" };
		}
	}

	// 3. The PM pointer targets the `gitlab-official` system MCP server.
	//    When the catalog row is missing (seed drift on some envs — see
	//    `packages/database/prisma/default-pm-tool-keys.ts` and PR #1205),
	//    fall back to the `key:gitlab-official` sentinel so the PM pointer is
	//    still wired and the downstream REST fallback fires.
	const officialServer = await db.mCPServer.findFirst({
		where: { key: "gitlab-official" },
		select: { id: true },
	});
	let serverIdToPersist: string;
	if (officialServer) {
		serverIdToPersist = officialServer.id;
	} else {
		console.error(
			"[enableGitLabPMForProject] gitlab-official MCPServer row missing; persisting key: sentinel so REST PM path still resolves",
			{ projectId: args.projectId },
		);
		serverIdToPersist = "key:gitlab-official";
	}

	// 4. Resolve the GitLab project id for the connected repo. The PM runtime
	//    passes `projectManagementContainerId` straight through as the GitLab
	//    REST `project_id`, which accepts BOTH a numeric id and a URL-encoded
	//    `owner/name` path. We prefer the numeric id (stable across renames),
	//    but the path is a valid fallback — so a transient/expired-token
	//    failure here must NOT leave the container null (which would hide the
	//    Pull button). The token also self-heals via the REST 401-retry path
	//    at sync time, so the path container keeps working regardless.
	const projectPath = `${args.repositoryOwner}/${args.repositoryName}`;
	let containerId = projectPath;
	let containerName = projectPath;
	try {
		const gitlabProject = (await gitlabFetch(
			args.token.accessToken,
			`/projects/${encodeURIComponent(projectPath)}`,
		)) as {
			id?: number;
			name?: string;
			path_with_namespace?: string;
		} | null;
		if (gitlabProject?.id != null) {
			containerId = String(gitlabProject.id);
		}
		containerName =
			gitlabProject?.path_with_namespace ??
			gitlabProject?.name ??
			projectPath;
	} catch (err) {
		// Numeric-id resolution failed (e.g. expired token at connect). Fall
		// back to the path container so the project is still PM-enabled.
		console.error(
			"[enableGitLabPMForProject] numeric project-id resolution failed; using path container",
			{ projectId: args.projectId, projectPath, error: err },
		);
	}

	// 5. Auto-wire the PM pointer.
	await db.project.update({
		where: { id: args.projectId },
		data: {
			projectManagementMcpServerId: serverIdToPersist,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: containerId,
			projectManagementContainerName: containerName,
		},
	});

	return { pmWired: true, containerId };
}
