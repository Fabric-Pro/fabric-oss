import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	resolvePMConfigForUser,
} from "@repo/database";
import {
	getFreshGitLabAccessToken,
	getGitLabAccessToken,
} from "@repo/integrations/gitlab";

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
		/**
		 * A fixed-vocabulary explanation (never provider text) — today only why
		 * a GitLab token refresh failed (`describeGitLabRefreshFailure`).
		 */
		public detail?: string,
	) {
		super(
			detail
				? `PM source not resolvable: ${reason} (${detail})`
				: `PM source not resolvable: ${reason}`,
		);
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
	/**
	 * The hourly poll sets it: a token past its real expiry whose refresh
	 * failed skips the project with the reason, instead of letting every
	 * ticket read fail on its own.
	 */
	requireFreshToken?: boolean;
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

	// The GitLab REST path acts through the CALLER's own GitLab connection
	// (XOR tenant isolation: org context filters by organizationId AND userId).
	// A GitLab WorkflowIntegration is a member's personal OAuth connection, so
	// falling back to "any active org GitLab integration" would let a user who
	// never connected — or who disconnected — read and write tickets through a
	// teammate's account. The hourly poll passes the project owner as `userId`,
	// so it acts as the owner and skips the project when the owner has no
	// connection. Keep this in step with `resolvePmTarget` (packages/api).
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
		select: { id: true, userId: true },
	});
	if (!integration) {
		throw new PMSourceNotFound("no-integration");
	}

	// Resolve the token for the integration's owner, which the filter above
	// pins to the caller.
	// `getGitLabAccessToken` never throws on a refresh failure: it hands back
	// the current token (still valid inside the pre-expiry buffer, dead after
	// it) and lets the caller's 401 handling cope. `requireFreshToken` callers
	// get a dead-and-unrefreshable token reported as token-failed instead.
	let token: string | null;
	if (args.requireFreshToken) {
		let fresh: Awaited<ReturnType<typeof getFreshGitLabAccessToken>>;
		try {
			fresh = await getFreshGitLabAccessToken(
				integration.userId,
				organizationId ?? undefined,
			);
		} catch {
			throw new PMSourceNotFound("token-failed");
		}
		if (!fresh) {
			throw new PMSourceNotFound("token-failed");
		}
		if (!fresh.ok) {
			throw new PMSourceNotFound("token-failed", fresh.reason);
		}
		token = fresh.token;
	} else {
		try {
			token = await getGitLabAccessToken(
				integration.userId,
				organizationId ?? undefined,
			);
		} catch {
			throw new PMSourceNotFound("token-failed");
		}
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
