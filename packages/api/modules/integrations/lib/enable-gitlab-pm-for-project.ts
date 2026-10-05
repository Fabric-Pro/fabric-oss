import { db, type Prisma } from "@repo/database";
import {
	GITLAB_DEFAULT_ORIGIN,
	GitLabApiError,
	getGitLabConnectionToken,
	gitlabApiBaseForOrigin,
	gitlabFetch,
	parseGitLabOrigin,
	recordedGitLabPmOrigin,
	withGitLabPmOrigin,
} from "@repo/integrations/gitlab";

/**
 * PM-tool server keys that we are allowed to overwrite when auto-wiring. A
 * project already pointed at a non-GitLab PM tool (e.g. Jira) is left
 * untouched — we never clobber an explicit choice.
 */
const GITLAB_PM_SERVER_KEYS = new Set(["gitlab", "gitlab-official"]);

export type EnableGitLabPMResult =
	| { pmWired: true; containerId: string }
	| {
			pmWired: false;
			reason:
				| "project-not-found"
				| "other-pm-tool-configured"
				/**
				 * The caller has no usable personal GitLab connection (none,
				 * or it needs reconnecting). GitLab PM runs on the acting
				 * person's own connection, never on a repository link's
				 * token, so the UI asks them to connect their personal GitLab.
				 */
				| "personal-connection-required"
				/** Their personal connection cannot see this GitLab project. */
				| "project-not-accessible"
				/**
				 * The repository is on another GitLab instance than their
				 * personal connection: its namespace/name would name an
				 * unrelated project there.
				 */
				| "instance-mismatch"
				/** GitLab could not be asked; nothing was changed. */
				| "validation-failed";
	  };

/**
 * Point a project's PM tool at the GitLab project of a repository it just
 * connected — but only when the CALLER's own GitLab connection can see that
 * GitLab project. The repository link's token (a separate team grant) is
 * never used for this and never copied into the caller's connection.
 *
 * The PM pointer targets the `gitlab-official` server with the GitLab project
 * as the container. `projectManagementMcpConfigId` is left null on purpose:
 * the capabilities resolver then routes MCP vs REST from the acting person's
 * connection.
 *
 * Never erases an existing selection: every refusal returns before the
 * project row is touched. Best-effort by contract: callers wrap this so a
 * failure never fails the repository connection.
 */
export async function enableGitLabPMForProject(args: {
	userId: string;
	organizationId: string | null;
	projectId: string;
	repositoryOwner: string;
	repositoryName: string;
	/**
	 * The connected repository's URL: its instance must be the personal
	 * connection's. A repository recorded without one predates self-hosted
	 * GitLab and is on gitlab.com.
	 */
	repositoryUrl: string | null;
}): Promise<EnableGitLabPMResult> {
	// 1. Clobber guard — never overwrite a deliberately-set non-GitLab PM tool.
	const project = await db.project.findUnique({
		where: { id: args.projectId },
		select: {
			projectManagementMcpServerId: true,
			projectManagementMcpConfigId: true,
			projectManagementContainerId: true,
			projectManagementAdditionalContext: true,
		},
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

	// 2. The caller's own GitLab connection.
	const personal = await getGitLabConnectionToken(
		{ userId: args.userId, organizationId: args.organizationId },
		// The validation below goes to the credential's own instance.
		{ mode: "strict", anyOrigin: true },
	);
	if (!personal.ok) {
		return { pmWired: false, reason: "personal-connection-required" };
	}

	// The repository's namespace/name is looked up on the connection's
	// instance below, so the repository must live on that same instance —
	// otherwise the lookup would find (and wire) an unrelated project.
	const repositoryOrigin = args.repositoryUrl
		? parseGitLabOrigin(args.repositoryUrl)
		: ({ ok: true, origin: GITLAB_DEFAULT_ORIGIN } as const);
	if (!repositoryOrigin.ok || repositoryOrigin.origin !== personal.origin) {
		return { pmWired: false, reason: "instance-mismatch" };
	}

	// 3. Resolve the GitLab project WITH THAT CONNECTION. The PM runtime
	//    passes `projectManagementContainerId` straight through as the GitLab
	//    REST `project_id`; the numeric id is stable across renames.
	const projectPath = `${args.repositoryOwner}/${args.repositoryName}`;
	let gitlabProject: {
		id?: number;
		name?: string;
		path_with_namespace?: string;
	} | null;
	try {
		gitlabProject = (await gitlabFetch(
			{
				token: personal.accessToken,
				apiBase: gitlabApiBaseForOrigin(personal.origin),
			},
			`/projects/${encodeURIComponent(projectPath)}`,
		)) as typeof gitlabProject;
	} catch (err) {
		if (err instanceof GitLabApiError) {
			if (err.status === 401) {
				return {
					pmWired: false,
					reason: "personal-connection-required",
				};
			}
			if (err.status === 403 || err.status === 404) {
				return { pmWired: false, reason: "project-not-accessible" };
			}
		}
		console.error(
			"[enableGitLabPMForProject] could not validate the GitLab project with the caller's connection",
			{ projectId: args.projectId, projectPath, error: err },
		);
		return { pmWired: false, reason: "validation-failed" };
	}
	if (!gitlabProject) {
		return { pmWired: false, reason: "project-not-accessible" };
	}
	// GitLab answered for this project with the caller's own connection. A
	// container is never left null (that hides the Pull button): without a
	// numeric id in the answer, the path is the container.
	const containerId =
		gitlabProject.id != null ? String(gitlabProject.id) : projectPath;
	const containerName =
		gitlabProject.path_with_namespace ?? gitlabProject.name ?? projectPath;

	// 4. The PM pointer targets the `gitlab-official` system MCP server.
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

	// 5. Auto-wire the PM pointer. PM → Fabric status sync is scoped to one
	//    PM source (Fizzy #2304, spec D1.4): stories linked through the old
	//    server, config or container are not the new source's tickets, so
	//    re-pointing any of them switches it off until an admin opts in again.
	// The same container id on another instance is another project too.
	const recordedOrigin = recordedGitLabPmOrigin(
		project.projectManagementAdditionalContext,
	);
	const pmSourceChanged =
		project.projectManagementMcpServerId !== serverIdToPersist ||
		project.projectManagementMcpConfigId !== null ||
		project.projectManagementContainerId !== containerId ||
		!recordedOrigin.ok ||
		recordedOrigin.origin !== personal.origin;
	await db.project.update({
		where: { id: args.projectId },
		data: {
			projectManagementMcpServerId: serverIdToPersist,
			projectManagementMcpConfigId: null,
			projectManagementContainerId: containerId,
			projectManagementContainerName: containerName,
			// The container id names a project on this instance only; every
			// PM read and write checks the actor's instance against it.
			projectManagementAdditionalContext: withGitLabPmOrigin(
				project.projectManagementAdditionalContext,
				personal.origin,
			) as Prisma.InputJsonValue,
			...(pmSourceChanged ? { pmStatusSyncEnabled: false } : {}),
		},
	});

	return { pmWired: true, containerId };
}
