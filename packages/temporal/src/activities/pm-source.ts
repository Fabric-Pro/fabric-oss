import {
	db,
	isPmServerIdKeySentinel,
	readPmServerIdKeySentinel,
	type resolvePMConfigForUser,
} from "@repo/database";
import {
	assertGitLabPmMcpConfigOrigin,
	describeGitLabConnectionFailure,
	GITLAB_PM_ORIGIN_MISMATCH_MESSAGE,
	type GitLabConnectionTokenResult,
	GitLabPmOriginMismatchError,
	getGitLabConnectionToken,
	gitlabApiBaseForOrigin,
	gitlabPmOriginMatches,
	resolveProjectPMConfigForUser,
} from "@repo/integrations/gitlab";
import { ApplicationFailure } from "@temporalio/common";

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
			/** REST base of the instance that issued `token` (`…/api/v4`). */
			baseUrl: string;
			projectId: string;
	  };

export class PMSourceNotFound extends Error {
	constructor(
		public reason:
			| "no-config"
			| "no-integration"
			| "token-failed"
			/**
			 * The acting person's GitLab (connection or GitLab MCP config) is
			 * on a different GitLab instance than the one the project's
			 * container was chosen on: the container id names an unrelated
			 * project there.
			 */
			| "origin-mismatch",
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
	 * The project's `projectManagementAdditionalContext` (or the snapshot of
	 * it a workflow carries): it records which GitLab instance `containerId`
	 * lives on (`recordedGitLabPmOrigin`). Required so no caller can skip the
	 * instance check by leaving it out.
	 */
	additionalContext: unknown;
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
		// The caller's own GitLab MCP config may be on another instance than
		// the container: its endpoint must be on the recorded one.
		let mcpConfig: Awaited<
			ReturnType<typeof resolveProjectPMConfigForUser>
		>;
		try {
			mcpConfig = await resolveProjectPMConfigForUser({
				configId: mcpConfigId,
				mcpServerId,
				userId,
				organizationId: organizationId ?? undefined,
				pmAdditionalContext: args.additionalContext,
			});
		} catch (error) {
			if (error instanceof GitLabPmOriginMismatchError) {
				throw new PMSourceNotFound(
					"origin-mismatch",
					GITLAB_PM_ORIGIN_MISMATCH_MESSAGE,
				);
			}
			throw error;
		}
		if (!mcpConfig?.enabled) {
			throw new PMSourceNotFound("no-config");
		}
		return { kind: "mcp", mcpConfig };
	}

	// Path 2: GitLab REST fallback. Server must be gitlab-official (or the
	// `key:gitlab-official` sentinel) AND the caller must have a usable
	// personal GitLab connection.
	const serverKey = await resolvePmServerKey(mcpServerId);
	if (serverKey !== "gitlab-official") {
		throw new PMSourceNotFound("no-config");
	}

	// The GitLab REST path acts through the CALLER's own GitLab connection
	// (XOR tenant isolation: org context reads the (userId, organizationId)
	// connection, personal context the (userId, null) one). A GitLab
	// connection is personal, so there is no fallback to "any active org
	// GitLab integration": that would let a user who never connected — or who
	// disconnected — read and write tickets through a teammate's account. The
	// hourly poll passes the project owner as `userId`, so it acts as the owner
	// and skips the project when the owner has no connection. Keep this in
	// step with `resolvePmTarget` (packages/api).
	//
	// The connection service resolves the connection and the token in one
	// read (a legacy `gitlab-official` MCP token copy is not a connection). Lenient mode hands back the
	// current token when a refresh fails transiently and lets the caller's 401
	// handling cope; `requireFreshToken` callers (the poll) get a
	// dead-and-unrefreshable token reported as token-failed instead.
	let result: GitLabConnectionTokenResult;
	try {
		// `anyOrigin`: the source's `baseUrl` is the credential's own
		// instance, so a self-hosted credential never reaches gitlab.com.
		result = await getGitLabConnectionToken(
			{ userId, organizationId: organizationId ?? null },
			{
				mode: args.requireFreshToken ? "strict" : "lenient",
				anyOrigin: true,
			},
		);
	} catch {
		throw new PMSourceNotFound("token-failed");
	}
	if (!result.ok) {
		// No connection, or one that needs reconnecting: the person has to
		// connect GitLab before anything here can work.
		if (
			result.reason === "not-connected" ||
			result.reason === "needs-reauth"
		) {
			throw new PMSourceNotFound("no-integration");
		}
		throw new PMSourceNotFound(
			"token-failed",
			args.requireFreshToken
				? describeGitLabConnectionFailure(result)
				: undefined,
		);
	}
	// The container id names a project on the instance it was chosen on;
	// a connection on any other instance is refused before anything is read,
	// uploaded or written there.
	if (!gitlabPmOriginMatches(args.additionalContext, result.origin)) {
		throw new PMSourceNotFound(
			"origin-mismatch",
			GITLAB_PM_ORIGIN_MISMATCH_MESSAGE,
		);
	}
	const token = result.accessToken;

	return {
		kind: "rest-gitlab",
		token,
		baseUrl: gitlabApiBaseForOrigin(result.origin),
		projectId: containerId ?? "",
	};
}

/**
 * For an activity that was handed an `mcpConfigId` together with the PM
 * container (and the `additionalContext` that came with it): refuse, before
 * anything is read or written, when the config is a personal GitLab config
 * on another instance than the container's (`recordedGitLabPmOrigin`). The
 * same container id there is an unrelated project, and retrying cannot
 * change that, so the failure is non-retryable.
 */
export async function assertPmMcpTargetOrigin(args: {
	mcpConfigId: string;
	userId: string;
	organizationId?: string | null;
	additionalContext: unknown;
}): Promise<void> {
	try {
		await assertGitLabPmMcpConfigOrigin({
			mcpConfigId: args.mcpConfigId,
			userId: args.userId,
			organizationId: args.organizationId,
			pmAdditionalContext: args.additionalContext,
		});
	} catch (error) {
		if (error instanceof GitLabPmOriginMismatchError) {
			throw ApplicationFailure.nonRetryable(
				error.message,
				"GitLabPmOriginMismatch",
			);
		}
		throw error;
	}
}
