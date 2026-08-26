/**
 * Project Repository Integration Queries
 *
 * Manages project-level repository credentials shared with all project members.
 * Access is gated by project membership (hasProjectAccess), NOT by userId/organizationId XOR.
 *
 * Token encryption uses AES-256-GCM via @repo/utils encryptApiKey/decryptApiKey.
 */

import { db, type Prisma } from "../client";
import type {
	RepositoryAuthMethod,
	RepositoryIntegrationStatus,
	RepositoryProvider,
} from "../zod";

// ============================================================================
// Types
// ============================================================================

export interface CreateProjectRepoIntegrationInput {
	projectId: string;
	provider: RepositoryProvider;
	authMethod: RepositoryAuthMethod;
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryName: string;
	defaultBranch?: string;
	roleTag?: string | null;
	encryptedAccessToken?: string;
	encryptedRefreshToken?: string;
	tokenExpiresAt?: Date;
	tokenScopes?: string[];
	encryptedPat?: string;
	azureOrganization?: string;
	configuredByUserId: string;
	/**
	 * Initial status. Defaults to ACTIVE; the OAuth callbacks pass the verdict
	 * of their repository-access probe instead, so a credential that cannot
	 * read the repo is never recorded as healthy (the column default alone
	 * would say ACTIVE about a row nobody had verified).
	 */
	status?: RepositoryIntegrationStatus;
	lastError?: string | null;
}

export type RepoCredentialResult =
	| {
			source: "project";
			integrationId: string;
			provider: RepositoryProvider;
			encryptedAccessToken: string | null;
			encryptedRefreshToken: string | null;
			tokenExpiresAt: Date | null;
			encryptedPat: string | null;
			azureOrganization: string | null;
			authMethod: RepositoryAuthMethod;
	  }
	| { source: "user"; mcpConfigId: string }
	| { source: "none"; reason: string };

// ============================================================================
// CRUD
// ============================================================================

/**
 * Sync legacy Project.repositoryUrl fields when a repo integration is added.
 * Sets the legacy fields only if no primary repo is currently set.
 * Called from connect procedures and OAuth callbacks.
 */
export async function syncLegacyProjectRepoOnConnect(
	projectId: string,
	repositoryUrl: string,
	repositoryOwner: string,
	repositoryName: string,
	defaultBranch?: string,
): Promise<void> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { repositoryUrl: true },
	});
	if (!project?.repositoryUrl) {
		await db.project.update({
			where: { id: projectId },
			data: {
				repositoryUrl,
				repositoryOwner,
				repositoryName,
				defaultBranch: defaultBranch ?? "main",
			},
		});
	}
}

/**
 * Sync legacy Project.repositoryUrl fields when a repo integration is removed.
 * If the removed repo was the primary, updates to the next ACTIVE integration.
 */
export async function syncLegacyProjectRepoOnDisconnect(
	projectId: string,
	removedRepoUrl: string,
): Promise<void> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { repositoryUrl: true },
	});
	if (project?.repositoryUrl === removedRepoUrl) {
		const remaining = await db.projectRepositoryIntegration.findMany({
			where: { projectId, status: "ACTIVE" },
			select: {
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
			},
			orderBy: { createdAt: "asc" },
			take: 1,
		});
		const next = remaining[0];
		await db.project.update({
			where: { id: projectId },
			data: {
				repositoryUrl: next?.repositoryUrl ?? null,
				repositoryOwner: next?.repositoryOwner ?? null,
				repositoryName: next?.repositoryName ?? null,
				defaultBranch: next?.defaultBranch ?? null,
			},
		});
	}
}

export type ProjectRepositoryRole = {
	url: string;
	provider: RepositoryProvider;
	roleTag: string | null;
};

/**
 * Get active repository integrations with their role tags for project context injection.
 * Lightweight query that avoids reading encrypted credential columns.
 */
export async function getProjectRepositoryRoles(
	projectId: string,
): Promise<ProjectRepositoryRole[]> {
	const integrations = await db.projectRepositoryIntegration.findMany({
		where: { projectId, status: "ACTIVE" },
		select: {
			repositoryUrl: true,
			provider: true,
			roleTag: true,
		},
		orderBy: { createdAt: "asc" },
	});
	return integrations.map((i) => ({
		url: i.repositoryUrl,
		provider: i.provider,
		roleTag: i.roleTag,
	}));
}

/**
 * List all repository integrations for a project.
 * Returns integration metadata — never returns encrypted credential fields.
 */
export async function listProjectRepoIntegrations(projectId: string) {
	return db.projectRepositoryIntegration.findMany({
		where: { projectId },
		select: {
			id: true,
			projectId: true,
			provider: true,
			authMethod: true,
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			roleTag: true,
			tokenScopes: true,
			status: true,
			lastHealthCheck: true,
			lastError: true,
			configuredByUserId: true,
			createdAt: true,
			updatedAt: true,
			configuredBy: {
				select: { id: true, name: true, email: true, image: true },
			},
		},
		orderBy: { createdAt: "desc" },
	});
}

/**
 * Get a single integration by ID, scoped to project.
 * Returns full record including encrypted fields (for server-side use).
 */
export async function getProjectRepoIntegration(
	integrationId: string,
	projectId: string,
) {
	return db.projectRepositoryIntegration.findFirst({
		where: { id: integrationId, projectId },
	});
}

/**
 * Create a new project repository integration.
 */
export async function createProjectRepoIntegration(
	input: CreateProjectRepoIntegrationInput,
) {
	return db.projectRepositoryIntegration.create({
		data: {
			projectId: input.projectId,
			provider: input.provider,
			authMethod: input.authMethod,
			repositoryUrl: input.repositoryUrl,
			repositoryOwner: input.repositoryOwner,
			repositoryName: input.repositoryName,
			defaultBranch: input.defaultBranch ?? "main",
			roleTag: input.roleTag ?? null,
			encryptedAccessToken: input.encryptedAccessToken,
			encryptedRefreshToken: input.encryptedRefreshToken,
			tokenExpiresAt: input.tokenExpiresAt,
			tokenScopes: input.tokenScopes ?? [],
			encryptedPat: input.encryptedPat,
			azureOrganization: input.azureOrganization,
			configuredByUserId: input.configuredByUserId,
			status: input.status ?? "ACTIVE",
			lastError: input.lastError,
		},
	});
}

/**
 * Delete a project repository integration.
 */
export async function deleteProjectRepoIntegration(
	integrationId: string,
	projectId: string,
) {
	return db.projectRepositoryIntegration.deleteMany({
		where: { id: integrationId, projectId },
	});
}

// ============================================================================
// Credential Resolution
// ============================================================================

/**
 * Find repository credentials for a given repo URL, checking project-level
 * integrations first, then falling back to user-level MCP configs.
 *
 * RESOLUTION PRIORITY:
 *   1. ProjectRepositoryIntegration WHERE status = ACTIVE (project-level, shared)
 *   2. User-level MCP config (handled by caller — findMcpConfigsForRepos)
 *
 * IMPORTANT: Only ACTIVE integrations are returned. If a project integration
 * exists with status TOKEN_EXPIRED, this returns source: "none" — it does NOT
 * fall through to user-level credentials. This is deliberate:
 *   - Using a different user's token would bypass the project owner's audit trail
 *   - The requesting user's personal token may access different repos
 *   - Silently switching credential sources would make debugging confusing
 * The caller (findMcpConfigsForRepos) handles the fallback to user-level.
 *
 * The user-level fallback is handled by the caller to avoid circular imports
 * with MCP queries.
 */
export async function findProjectRepoCredentials(
	repoUrl: string,
	projectId: string,
): Promise<RepoCredentialResult> {
	// Parse owner/name from URL
	const parsed = parseRepoUrl(repoUrl);
	if (!parsed) {
		return { source: "none", reason: `Cannot parse repo URL: ${repoUrl}` };
	}

	const integration = await db.projectRepositoryIntegration.findFirst({
		where: {
			projectId,
			provider: parsed.provider,
			repositoryOwner: parsed.owner,
			repositoryName: parsed.name,
			status: "ACTIVE",
		},
	});

	if (!integration) {
		return {
			source: "none",
			reason: `No active project-level integration for ${repoUrl}`,
		};
	}

	return {
		source: "project",
		integrationId: integration.id,
		provider: integration.provider,
		encryptedAccessToken: integration.encryptedAccessToken,
		encryptedRefreshToken: integration.encryptedRefreshToken,
		tokenExpiresAt: integration.tokenExpiresAt,
		encryptedPat: integration.encryptedPat,
		azureOrganization: integration.azureOrganization,
		authMethod: integration.authMethod,
	};
}

// ============================================================================
// Token Refresh (Optimistic Locking)
// ============================================================================

/**
 * Atomically refresh a project repo integration token using optimistic locking.
 *
 * OPTIMISTIC LOCK PATTERN:
 * Multiple members may trigger actions concurrently that all discover the token
 * is expired. Each attempts a refresh. We use `updatedAt` as a compare-and-swap
 * guard: the WHERE clause includes `updatedAt = expectedUpdatedAt`, so only the
 * first writer succeeds (count=1). Subsequent writers see count=0, meaning
 * another process already refreshed — they should re-read the integration to
 * get the new token rather than retrying the refresh.
 *
 * This avoids a database-level lock (SELECT FOR UPDATE) which would serialize
 * all reads during the refresh window.
 *
 * @returns true if refresh succeeded, false if another process already refreshed.
 */
export async function refreshProjectRepoToken(params: {
	integrationId: string;
	encryptedAccessToken: string;
	encryptedRefreshToken: string;
	tokenExpiresAt: Date;
	expectedUpdatedAt: Date;
}): Promise<boolean> {
	const result = await db.projectRepositoryIntegration.updateMany({
		where: {
			id: params.integrationId,
			updatedAt: params.expectedUpdatedAt,
		},
		data: {
			encryptedAccessToken: params.encryptedAccessToken,
			encryptedRefreshToken: params.encryptedRefreshToken,
			tokenExpiresAt: params.tokenExpiresAt,
			status: "ACTIVE",
			lastHealthCheck: new Date(),
			lastError: null,
			probeFailCount: 0,
			// A successful exchange proves the grant is alive; drop any earlier
			// refresh-token rejection so the row rejoins the health-check sweep.
			refreshTokenRejectedAt: null,
		},
	});
	return result.count > 0;
}

export interface SetIntegrationStatusResult {
	/** The persisted status after the update. */
	status: RepositoryIntegrationStatus;
	/**
	 * The status the row held immediately before this update (null if the row
	 * could not be read — e.g. it was deleted between read and write).
	 */
	previousStatus: RepositoryIntegrationStatus | null;
	/**
	 * True when `previousStatus !== status`. Callers use this to fire
	 * transition-only side effects (e.g. a "credentials expired" notification)
	 * exactly once instead of on every scheduled re-check. The repo health
	 * check deliberately re-includes already-expired GitHub-OAUTH rows every
	 * cycle to retry refresh, so a blind "is expired now" check would re-notify
	 * forever — this flag is the dedupe signal.
	 */
	statusChanged: boolean;
	/**
	 * True when a row was actually updated. Distinct from `statusChanged`: a
	 * re-assertion of the status a row already holds writes but does not
	 * transition (`written: true, statusChanged: false`), whereas a guard miss
	 * — DISCONNECTED, deleted, or a failed `expectedRefreshToken` pin — writes
	 * nothing (`written: false`). Callers that must tell "no change needed"
	 * apart from "my evidence was stale" need this, not `statusChanged`.
	 */
	written: boolean;
}

/**
 * Set integration status (TOKEN_EXPIRED / ERROR on failure). To restore ACTIVE
 * use `restoreIntegrationActive` (also disconnect-safe).
 *
 * Disconnect-safe: the write is conditional on the row NOT being DISCONNECTED,
 * so a concurrent `disconnect` (separate writer) landing between the prior-status
 * read and the write is never overwritten. Returns `statusChanged: false` when no
 * row was written (already DISCONNECTED / deleted).
 *
 * `expectedRefreshToken` additionally pins the write to one credential
 * generation. `status != DISCONNECTED` does NOT cover reconnect, which returns
 * the row to ACTIVE with brand-new credentials — so a caller acting on evidence
 * about an OLD credential (a refresh the provider rejected, say) would expire
 * the connection a user has just successfully repaired, and notify them to
 * repair it again. Pass the ciphertext the evidence refers to and the write
 * lands only while that credential is still the stored one; otherwise nothing
 * is written and `statusChanged` is false.
 *
 * `expectedUpdatedAt` is the same idea for sweep cycles: a probe verdict drawn
 * from a snapshot must not land on a row whose credentials changed after the
 * snapshot (e.g. attachPat flipping authMethod mid-cycle). Pass the snapshot's
 * `updatedAt`; any intervening write makes the CAS miss and nothing is written.
 */
export async function setIntegrationStatus(
	integrationId: string,
	status: RepositoryIntegrationStatus,
	lastError?: string,
	expectedRefreshToken?: string | null,
	expectedUpdatedAt?: Date,
): Promise<SetIntegrationStatusResult> {
	const prior = await db.projectRepositoryIntegration.findUnique({
		where: { id: integrationId },
		select: { status: true },
	});
	const previousStatus = prior?.status ?? null;

	const result = await db.projectRepositoryIntegration.updateMany({
		where: {
			id: integrationId,
			status: { not: "DISCONNECTED" },
			...(expectedUpdatedAt === undefined
				? {}
				: { updatedAt: expectedUpdatedAt }),
			...(expectedRefreshToken === undefined
				? {}
				: { encryptedRefreshToken: expectedRefreshToken }),
		},
		data: {
			status,
			lastError: lastError ?? null,
			lastHealthCheck: new Date(),
		},
	});
	const written = result.count > 0;

	return {
		status: written ? status : (previousStatus ?? status),
		previousStatus,
		statusChanged: written && previousStatus !== status,
		written,
	};
}

/**
 * A No-access row retires from the sweep after this many consecutive
 * definitive-negative probes (~3 hours at the 30-minute cadence). A deleted or
 * renamed repository can never self-heal, so re-probing it forever is pure
 * waste; the counter resets on any successful probe, reconnect, or attachPat.
 */
export const RETIRE_AFTER_PROBE_FAILURES = 6;

/**
 * Get all recoverable integrations for the health check workflow.
 *
 * `ACTIVE` and `ERROR` rows are always returned. `TOKEN_EXPIRED` rows are
 * returned only when they are recoverable — currently GitHub and GitLab OAUTH,
 * whose refresh tokens can be exchanged (by `refreshProjectRepoGitHubToken` and
 * `getValidGitLabAccessToken` respectively). Azure DevOps PATs cannot be
 * refreshed, so including them here would re-call the Azure DevOps API and
 * re-log every 30 minutes with no recovery value — they recover via a user
 * reconnect instead.
 *
 * That recoverability is conditional, not a property of the auth method: a
 * refresh token the provider has REJECTED can never be exchanged again, so a
 * row carrying `refreshTokenRejectedAt` is excluded too. Without that, the
 * exact waste described above for Azure DevOps PATs reappears for OAuth rows —
 * a revoked GitHub grant re-probed and re-exchanged every 30 minutes forever,
 * with no recovery value, since only a user reconnect can fix it. The marker is
 * cleared by any successful refresh and on reconnect, so a row that becomes
 * recoverable again rejoins the sweep on its own.
 *
 * `DISCONNECTED` is excluded because its tokens are wiped.
 */
export async function getActiveIntegrations() {
	return db.projectRepositoryIntegration.findMany({
		where: {
			OR: [
				// REPO_UNAVAILABLE rows are swept so an access grant restored
				// out-of-band (the app installed on the repository) returns to
				// ACTIVE without user action — but only while they can still
				// self-heal. Past the retirement threshold the repo is almost
				// certainly gone; the badge stays No access and re-probing it
				// forever is pure waste.
				{
					status: "REPO_UNAVAILABLE",
					probeFailCount: { lt: RETIRE_AFTER_PROBE_FAILURES },
				},
				{ status: { in: ["ACTIVE", "ERROR"] } },
				{
					status: "TOKEN_EXPIRED",
					provider: { in: ["GITHUB", "GITLAB"] },
					authMethod: "OAUTH",
					refreshTokenRejectedAt: null,
				},
			],
		},
		include: {
			project: { select: { id: true, name: true, organizationId: true } },
		},
	});
}

/**
 * Restore an integration to ACTIVE after a confirmed-healthy probe.
 *
 * Conditional on the row NOT being DISCONNECTED, so a concurrent disconnect
 * (which wipes tokens) that lands during the health-check probe is never
 * resurrected from the stale activity token. `updateMany` matches by id AND
 * `status != DISCONNECTED`, so a disconnected/deleted row yields `count: 0` and
 * the caller skips the restore. Returns true iff a row was actually restored.
 */
export async function restoreIntegrationActive(
	integrationId: string,
): Promise<boolean> {
	const result = await db.projectRepositoryIntegration.updateMany({
		where: { id: integrationId, status: { not: "DISCONNECTED" } },
		data: {
			status: "ACTIVE",
			lastError: null,
			lastHealthCheck: new Date(),
			// A readable repo can self-heal again — restart retirement.
			probeFailCount: 0,
			// refreshTokenRejectedAt NOT cleared here. The probe that triggers
			// a restore validates the ACCESS token; the refresh token is a
			// separate credential and can be dead while the access token still
			// works. Clearing on that evidence would drop a confirmed rejection
			// and hand the row back to the refresh loop. A successful refresh
			// clears it (that IS the proof), and so does reconnect.
		},
	});
	return result.count > 0;
}

/**
 * Disconnect integrations configured by a specific user within a project.
 * Used when the configuring user is removed from the project.
 * Sets configuredByUserId to null and status to DISCONNECTED.
 */
export async function disconnectIntegrationsForUser(
	projectId: string,
	userId: string,
) {
	return db.projectRepositoryIntegration.updateMany({
		where: {
			projectId,
			configuredByUserId: userId,
		},
		data: {
			configuredByUserId: null,
			status: "DISCONNECTED",
			lastError: "Configured user removed from project",
			encryptedAccessToken: null,
			encryptedRefreshToken: null,
			encryptedPat: null,
		},
	});
}

// ============================================================================
// Audit Logging Helper
// ============================================================================

/**
 * Create a project activity log entry for repository integration events.
 */
export async function logRepoIntegrationActivity(params: {
	projectId: string;
	userId: string;
	userName: string;
	organizationId?: string | null;
	activityType: string;
	integrationId?: string;
	repositoryName?: string;
	metadata?: Prisma.InputJsonValue;
}) {
	return db.projectActivity.create({
		data: {
			projectId: params.projectId,
			userId: params.userId,
			userName: params.userName,
			activityType: params.activityType,
			resourceType: "repository_integration",
			resourceId: params.integrationId,
			resourceName: params.repositoryName,
			organizationId: params.organizationId ?? null,
			metadata: params.metadata,
		},
	});
}

// ============================================================================
// Code Search Helpers
// ============================================================================

export interface ProjectRepoForCodeSearch {
	integrationId: string;
	provider: RepositoryProvider;
	owner: string;
	repo: string;
	branch: string;
	roleTag?: string | null;
	repositoryUrl: string;
	encryptedAccessToken: string | null;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
	updatedAt: Date;
	encryptedPat: string | null;
	azureOrganization: string | null;
	authMethod: RepositoryAuthMethod;
}

/**
 * Get all active repository integrations for a project, shaped for code search.
 * Returns encrypted tokens as-is — the caller is responsible for decryption
 * (using `@repo/utils` `decryptApiKey`) and for refreshing expired tokens via
 * `refreshProjectRepoGitHubToken` from `@repo/integrations`.
 */
export async function getProjectReposForCodeSearch(
	projectId: string,
): Promise<ProjectRepoForCodeSearch[]> {
	const integrations = await db.projectRepositoryIntegration.findMany({
		where: {
			projectId,
			status: "ACTIVE",
		},
		select: {
			id: true,
			provider: true,
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			qaBranch: true,
			roleTag: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			updatedAt: true,
			encryptedPat: true,
			azureOrganization: true,
			authMethod: true,
		},
	});

	return integrations.map((i) => ({
		integrationId: i.id,
		provider: i.provider,
		owner: i.repositoryOwner,
		repo: i.repositoryName,
		// QA watches its own branch when one is set; otherwise the repo default,
		// which is what every existing row does and keeps doing.
		branch: i.qaBranch || i.defaultBranch,
		roleTag: i.roleTag,
		repositoryUrl: i.repositoryUrl,
		encryptedAccessToken: i.encryptedAccessToken,
		encryptedRefreshToken: i.encryptedRefreshToken,
		tokenExpiresAt: i.tokenExpiresAt,
		updatedAt: i.updatedAt,
		encryptedPat: i.encryptedPat,
		azureOrganization: i.azureOrganization,
		authMethod: i.authMethod,
	}));
}

/**
 * Get repository integrations for a project to PULL CI PIPELINE RESULTS.
 *
 * Deliberately NOT gated on code-search health (`status: "ACTIVE"`) the way
 * {@link getProjectReposForCodeSearch} is: pipeline-results and code-indexing
 * are independent concerns. A repo whose code-index clone failed (worker
 * network, oversized repo, a transient health-check blip) gets flipped to
 * `ERROR` / "reconnect to restore access", but its CI-read credential can be
 * perfectly valid — gating the pull on the code-search status silently stops
 * pipeline results for a repo we can still read CI from. So this includes every
 * connected integration except `DISCONNECTED`, and lets the sync's own
 * per-source token resolution + fetch surface a genuinely-bad credential
 * (`recordPipelineSyncFailure`) rather than dropping the source before it tries.
 */
export async function getProjectReposForPipelineSync(
	projectId: string,
): Promise<ProjectRepoForCodeSearch[]> {
	const integrations = await db.projectRepositoryIntegration.findMany({
		where: {
			projectId,
			status: { not: "DISCONNECTED" },
		},
		select: {
			id: true,
			provider: true,
			repositoryUrl: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			qaBranch: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			updatedAt: true,
			encryptedPat: true,
			azureOrganization: true,
			authMethod: true,
		},
	});

	return integrations.map((i) => ({
		integrationId: i.id,
		provider: i.provider,
		owner: i.repositoryOwner,
		repo: i.repositoryName,
		// QA watches its own branch when one is set; otherwise the repo default,
		// which is what every existing row does and keeps doing.
		branch: i.qaBranch || i.defaultBranch,
		repositoryUrl: i.repositoryUrl,
		encryptedAccessToken: i.encryptedAccessToken,
		encryptedRefreshToken: i.encryptedRefreshToken,
		tokenExpiresAt: i.tokenExpiresAt,
		updatedAt: i.updatedAt,
		encryptedPat: i.encryptedPat,
		azureOrganization: i.azureOrganization,
		authMethod: i.authMethod,
	}));
}

/**
 * Clean up code search artifacts when a repository integration is unlinked.
 *
 * 1. Deletes all `ProjectContext` records where `metadata.provider = "CODE_ANALYSIS"`
 *    and `metadata.repo` matches the `owner/name` parsed from the repository URL.
 * 2. If no active repository integrations remain for the project, disables
 *    `codeSearchEnabled` in `ProjectRagSettings`.
 */
/**
 * Clean up code search artifacts when a repository integration is unlinked.
 *
 * 1. Finds all CODE_ANALYSIS ProjectContext records matching the repo.
 * 2. Deletes them from the database.
 * 3. Disables codeSearchEnabled if no active repo integrations remain.
 *
 * Returns the deleted context IDs so the caller can also remove
 * the corresponding Qdrant vectors.
 */
export async function cleanupCodeSearchOnRepoUnlink(
	projectId: string,
	repositoryUrl: string,
	options?: {
		/** When true, skip disabling codeSearchEnabled (used during repo replacement) */
		preserveCodeSearchSetting?: boolean;
	},
): Promise<{
	deletedContextIds: string[];
	deletedContextQdrantIds: Array<{ id: string; qdrantId: string }>;
	organizationId: string | null;
	activeIndexingWorkflowId: string | null;
}> {
	// 1. Parse repo URL to extract owner/name
	const parsed = parseRepoUrl(repositoryUrl);
	if (!parsed) {
		return {
			deletedContextIds: [],
			deletedContextQdrantIds: [],
			organizationId: null,
			activeIndexingWorkflowId: null,
		};
	}

	const repoSlug = `${parsed.owner}/${parsed.name}`;

	// 2. Find CODE_ANALYSIS contexts for this repo (need IDs for Qdrant cleanup)
	const contexts = await db.projectContext.findMany({
		where: {
			projectId,
			metadata: {
				path: ["provider"],
				equals: "CODE_ANALYSIS",
			},
			AND: {
				metadata: {
					path: ["repo"],
					equals: repoSlug,
				},
			},
		},
		select: { id: true, organizationId: true, qdrantId: true },
	});

	const deletedContextIds = contexts.map((c) => c.id);
	const deletedContextQdrantIds = contexts.flatMap((context) =>
		context.qdrantId
			? [{ id: context.id, qdrantId: context.qdrantId }]
			: [],
	);
	const organizationId = contexts[0]?.organizationId ?? null;

	// 3. Delete from database
	if (deletedContextIds.length > 0) {
		await db.projectContext.deleteMany({
			where: { id: { in: deletedContextIds } },
		});
	}

	// 4. Check if any active repo integrations remain for the project
	const remainingCount = await db.projectRepositoryIntegration.count({
		where: {
			projectId,
			status: "ACTIVE",
		},
	});

	// 5. If none remain and not a replacement, disable code search and reset code analysis status
	if (remainingCount === 0 && !options?.preserveCodeSearchSetting) {
		await db.projectRagSettings.updateMany({
			where: { projectId },
			data: { codeSearchEnabled: false },
		});
	}

	// Always reset code analysis status so the new repo gets a fresh scan
	await db.project.update({
		where: { id: projectId },
		data: {
			codeAnalysisStatus: null,
			codeAnalysisWorkflowId: null,
		},
	});

	// The Phase 2 ProjectCodeIndex row + its vectors are now per-repo and are
	// torn down by the caller (scoped to the specific repository integration, or
	// the legacy null row) so that removing one repo never wipes another's index.
	return {
		deletedContextIds,
		deletedContextQdrantIds,
		organizationId,
		activeIndexingWorkflowId: null,
	};
}

// ============================================================================
// Webhook Lookup
// ============================================================================

/**
 * Find an ACTIVE project repository integration by repository URL.
 * Used by webhooks (no user session) to resolve tenant context from the repo.
 *
 * Returns the integration with its project (for userId/organizationId)
 * and encrypted credential fields (for workflow token resolution).
 */
/**
 * EVERY active integration for a repository URL, not just the first one.
 *
 * `findByRepoUrl` answers with one row, which is right for a push: reindexing a
 * repository twice buys nothing. It is wrong for a pull-request review, where
 * each project decided independently whether it wants one — a webhook that
 * reviews for whichever project the database happened to return first is
 * non-deterministic in a way nobody can see or debug.
 *
 * Ordered by creation so a delivery behaves the same way twice.
 */
export async function findAllByRepoUrl(repositoryUrls: string[]) {
	if (repositoryUrls.length === 0) {
		return [];
	}
	return db.projectRepositoryIntegration.findMany({
		where: { repositoryUrl: { in: repositoryUrls }, status: "ACTIVE" },
		orderBy: { createdAt: "asc" },
		include: {
			project: {
				select: { id: true, userId: true, organizationId: true },
			},
		},
	});
}

export async function findByRepoUrl(repositoryUrl: string) {
	return db.projectRepositoryIntegration.findFirst({
		where: { repositoryUrl, status: "ACTIVE" },
		include: {
			project: {
				select: {
					id: true,
					userId: true,
					organizationId: true,
				},
			},
		},
	});
}

// ============================================================================
// URL Parsing Utilities
// ============================================================================

interface ParsedRepoUrl {
	provider: RepositoryProvider;
	owner: string;
	name: string;
	/**
	 * Azure DevOps only: the project segment between the org and `_git`
	 * (`dev.azure.com/{org}/{project}/_git/{repo}`). Undefined for GitHub/GitLab
	 * and for ADO URLs that omit the project. The ADO Test Runs API is
	 * project-scoped, so the pipeline-results sync needs this.
	 */
	project?: string;
}

/**
 * Parse a repository URL into provider, owner, name (and, for Azure DevOps, the
 * project segment).
 */
export function parseRepoUrl(url: string): ParsedRepoUrl | null {
	const trimmed = url.trim();
	if (!trimmed) {
		return null;
	}

	const scpStyle = trimmed.match(/^git@([^:]+):(.+)$/i);
	const candidate = scpStyle
		? `https://${scpStyle[1]}/${scpStyle[2]}`
		: /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)
			? trimmed
			: `https://${trimmed}`;

	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		return null;
	}
	if (
		(parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
		parsed.username ||
		parsed.password
	) {
		return null;
	}

	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	const path = parsed.pathname.split("/").filter(Boolean);
	const name = path.at(-1)?.replace(/\.git$/i, "");
	const firstPathSegment = path[0];
	if (!name || !firstPathSegment) {
		return null;
	}

	if (hostname === "github.com" && path.length === 2) {
		return {
			provider: "GITHUB",
			owner: firstPathSegment,
			name,
		};
	}

	const gitIndex = path.findIndex(
		(segment) => segment.toLowerCase() === "_git",
	);
	if (
		hostname === "dev.azure.com" &&
		(path.length === 3 || path.length === 4) &&
		(gitIndex === 1 || gitIndex === 2)
	) {
		return {
			provider: "AZURE_DEVOPS",
			owner: firstPathSegment,
			...(gitIndex === 2 ? { project: path[1] } : {}),
			name,
		};
	}

	const adoHost = hostname.match(/^([^.]+)\.visualstudio\.com$/);
	const adoOwner = adoHost?.[1];
	if (
		adoOwner &&
		(path.length === 2 || path.length === 3) &&
		(gitIndex === 0 || gitIndex === 1)
	) {
		return {
			provider: "AZURE_DEVOPS",
			owner: adoOwner,
			...(gitIndex === 1 ? { project: path[0] } : {}),
			name,
		};
	}

	if (hostname === "gitlab.com" && path.length >= 2) {
		return {
			provider: "GITLAB",
			owner: path.slice(0, -1).join("/"),
			name,
		};
	}

	return null;
}

/** A connected repo as a QA pipeline source, with the branch QA watches. */
export interface ProjectQaPipelineSource {
	integrationId: string;
	provider: string;
	owner: string;
	repo: string;
	/** The repo's own default branch — what QA falls back to. */
	defaultBranch: string;
	/** Explicit QA override; null means "follow defaultBranch". */
	qaBranch: string | null;
	/** The branch QA actually syncs (the override, else the default). */
	effectiveBranch: string;
}

/**
 * The connected repos QA can pull CI results from, for the Testing settings
 * branch picker. Deliberately returns NO credentials — this one is rendered in
 * the browser, unlike {@link getProjectReposForPipelineSync} which the worker
 * uses. Scoped by projectId; the caller's project access is the tenant boundary.
 */
export async function listProjectQaPipelineSources(input: {
	projectId: string;
}): Promise<ProjectQaPipelineSource[]> {
	const integrations = await db.projectRepositoryIntegration.findMany({
		where: { projectId: input.projectId, status: { not: "DISCONNECTED" } },
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			defaultBranch: true,
			qaBranch: true,
		},
		orderBy: { createdAt: "asc" },
	});

	return integrations.map((i) => ({
		integrationId: i.id,
		provider: i.provider,
		owner: i.repositoryOwner,
		repo: i.repositoryName,
		defaultBranch: i.defaultBranch,
		qaBranch: i.qaBranch,
		effectiveBranch: i.qaBranch || i.defaultBranch,
	}));
}

/**
 * A connected repo as a CI *trigger* target, with the routing metadata a
 * provider call needs but the browser-facing source list has no business
 * carrying (the GitLab API host, the ADO organization).
 */
export interface ProjectQaTriggerTarget
	extends Omit<ProjectQaPipelineSource, "provider"> {
	/**
	 * The real enum rather than the widened `string` the browser-facing source
	 * list carries, so the provider dispatch that starts a run is exhaustive: a
	 * fourth provider fails to compile until it is handled.
	 */
	provider: RepositoryProvider;
	/** Drives the GitLab API host and the ADO project segment. */
	repositoryUrl: string;
	/** Explicitly stored ADO organization; falls back to the parsed repo URL. */
	azureOrganization: string | null;
}

/**
 * The connected repos a CI run can be STARTED in. Like
 * {@link listProjectQaPipelineSources} this returns no credentials — the caller
 * resolves those through `resolveFreshRepoToken`, which self-heals expiry — but
 * unlike it, this projection is consumed server-side and carries the routing
 * fields a provider call needs.
 *
 * Scoped by projectId, so an integration id belonging to another project simply
 * is not in the result and cannot be triggered.
 */
export async function listProjectQaTriggerTargets(input: {
	projectId: string;
	integrationId?: string;
}): Promise<ProjectQaTriggerTarget[]> {
	const integrations = await db.projectRepositoryIntegration.findMany({
		where: {
			projectId: input.projectId,
			// Mirrors the sync path: a repo flipped to ERROR or TOKEN_EXPIRED by a
			// code-INDEXING failure still holds a valid CI credential (#2271), so
			// only an explicit disconnect removes it as a target.
			status: { not: "DISCONNECTED" },
			...(input.integrationId ? { id: input.integrationId } : {}),
		},
		select: {
			id: true,
			provider: true,
			repositoryOwner: true,
			repositoryName: true,
			repositoryUrl: true,
			defaultBranch: true,
			qaBranch: true,
			azureOrganization: true,
		},
		orderBy: { createdAt: "asc" },
	});

	return integrations.map((i) => ({
		integrationId: i.id,
		provider: i.provider,
		owner: i.repositoryOwner,
		repo: i.repositoryName,
		repositoryUrl: i.repositoryUrl,
		azureOrganization: i.azureOrganization,
		defaultBranch: i.defaultBranch,
		qaBranch: i.qaBranch,
		effectiveBranch: i.qaBranch || i.defaultBranch,
	}));
}

/**
 * Point QA at a specific branch for one connected repo, or clear the override
 * (blank/null) to go back to following the repo default.
 *
 * The `projectId` in the WHERE is the tenant guard: an integration id alone
 * would let a caller with access to project A retarget project B's repo, so the
 * update is scoped to both and reports whether it actually matched.
 */
export async function setProjectRepoQaBranch(input: {
	projectId: string;
	integrationId: string;
	qaBranch: string | null;
}): Promise<{ updated: boolean }> {
	const trimmed = input.qaBranch?.trim();
	const { count } = await db.projectRepositoryIntegration.updateMany({
		where: { id: input.integrationId, projectId: input.projectId },
		data: { qaBranch: trimmed ? trimmed : null },
	});
	return { updated: count > 0 };
}
