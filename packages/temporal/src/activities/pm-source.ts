import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import { getGitLabAccessToken } from "@repo/integrations/gitlab";

/**
 * Discriminated PM source rehydrated inside a Temporal activity.
 *
 * Activities receive primitives (`mcpServerId`, `mcpConfigId | null`,
 * tenant context, container id) in their input and resolve a concrete
 * source here. Tokens never cross the Temporal serialization boundary —
 * they live only inside the activity that resolved them.
 */
export type PMSource =
	| {
			kind: "mcp";
			mcpConfig: NonNullable<
				Awaited<ReturnType<typeof resolvePMConfigForUser>>
			>;
	  }
	| {
			kind: "rest-gitlab";
			token: string;
			baseUrl: string;
			projectId: string;
	  };

/**
 * Default base URL for GitLab REST. Mirrors `GITLAB_API_URL` inside
 * `@repo/integrations/gitlab` — self-hosted GitLab is not yet supported
 * by the workflow integration record, so we hardcode the same constant.
 */
const GITLAB_DEFAULT_BASE_URL = "https://gitlab.com/api/v4";

export class PMSourceNotFound extends Error {
	constructor(
		public reason: "no-config" | "no-integration" | "token-failed",
	) {
		super(`PM source not resolvable: ${reason}`);
		this.name = "PMSourceNotFound";
	}
}

/**
 * Resolve a project's PM server *key* (e.g. "azure-devops", "fizzy",
 * "gitlab-official") from its `projectManagementMcpServerId`, handling both the
 * `key:<key>` sentinel form (catalog-row-missing / seed drift) and the normal
 * MCPServer-UUID form. Returns null when the server row is absent. Shared by
 * `resolvePmSource` (below) and the poll's gate classifier (pm-state-poll.ts).
 */
export async function resolvePmServerKey(
	mcpServerId: string,
): Promise<string | null> {
	if (isPmServerIdKeySentinel(mcpServerId)) {
		return readPmServerIdKeySentinel(mcpServerId);
	}
	const server = await db.mCPServer.findUnique({
		where: { id: mcpServerId },
		select: { key: true },
	});
	return server?.key ?? null;
}

export async function resolvePmSource(args: {
	mcpServerId: string;
	mcpConfigId: string | null;
	userId: string;
	organizationId: string | null;
	containerId: string | null;
}): Promise<PMSource> {
	const { mcpServerId, mcpConfigId, userId, organizationId, containerId } =
		args;

	// Path 1: MCPConfig pinned. Delegate to the existing per-user helper
	// which enforces tenant ownership.
	if (mcpConfigId) {
		const mcpConfig = await resolvePMConfigForUser({
			configId: mcpConfigId,
			mcpServerId,
			userId,
			organizationId: organizationId ?? undefined,
		});
		if (!mcpConfig?.enabled) {
			throw new PMSourceNotFound("no-config");
		}
		return { kind: "mcp", mcpConfig };
	}

	// Path 2: GitLab REST fallback. Server must be gitlab-official (or the
	// `key:gitlab-official` sentinel) AND the tenant must have an active
	// WorkflowIntegration{provider=GITLAB}.
	const serverKey = await resolvePmServerKey(mcpServerId);
	if (serverKey !== "gitlab-official") {
		throw new PMSourceNotFound("no-config");
	}

	// The GitLab REST connection belongs to the project/org, not the individual
	// user who happened to set it up. Code-repo integrations (GitHub / GitLab /
	// Azure DevOps) resolve per-project so any teammate can sync; the PM GitLab
	// REST path must behave the same way. Prefer the caller's own GitLab
	// integration; in ORG context, fall back to ANY active org GitLab
	// integration when the caller has none, and resolve the token via that
	// integration's owner. Personal projects (organizationId === null) stay
	// strictly user-scoped — you can't borrow another user's personal OAuth.
	const ownIntegration = await db.workflowIntegration.findFirst({
		where: organizationId
			? { organizationId, userId, provider: "GITLAB", isActive: true }
			: {
					organizationId: null,
					userId,
					provider: "GITLAB",
					isActive: true,
				},
		select: { id: true, userId: true },
	});
	const integration =
		ownIntegration ??
		(organizationId
			? await db.workflowIntegration.findFirst({
					// Org-scoped (no userId): any teammate's active GitLab
					// connection serves the whole org, mirroring per-project
					// code-repo resolution.
					where: {
						organizationId,
						provider: "GITLAB",
						isActive: true,
					},
					select: { id: true, userId: true },
				})
			: null);
	if (!integration) {
		throw new PMSourceNotFound("no-integration");
	}

	// Resolve the token for the integration's OWNER — the caller themselves when
	// they have their own connection, or the org-mate who configured GitLab.
	// `getGitLabAccessToken` returns `string | null` and never throws on
	// auth/refresh failures (it swallows them and returns null). Guard both
	// paths so callers always see PMSourceNotFound on failure.
	let token: string | null;
	try {
		token = await getGitLabAccessToken(
			integration.userId,
			organizationId ?? undefined,
		);
	} catch {
		throw new PMSourceNotFound("token-failed");
	}
	if (!token) {
		throw new PMSourceNotFound("token-failed");
	}

	return {
		kind: "rest-gitlab",
		token,
		baseUrl: GITLAB_DEFAULT_BASE_URL,
		projectId: containerId ?? "",
	};
}
