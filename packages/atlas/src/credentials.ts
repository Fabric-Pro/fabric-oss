/**
 * On-demand project-repo credential refresh for the Atlas feature.
 *
 * A GitHub OAuth integration whose access token lapsed between scheduled
 * health checks should self-heal the moment a user touches Atlas — analysing
 * or simply reading status — instead of dead-ending into "credentials
 * expired". This module orchestrates that refresh:
 *
 *  - It REUSES `refreshProjectRepoGitHubToken` from `@repo/integrations`
 *    (CAS-protected via `expectedUpdatedAt`); it never implements its own
 *    OAuth exchange.
 *  - Status reads are throttled with a persisted cooldown on
 *    `lastHealthCheck` (bumped by every refresh outcome and by the scheduled
 *    health check) plus an in-process lock so concurrent calls share one
 *    attempt. User-initiated paths pass `force: true` to bypass the cooldown.
 *  - Failures on a hard-expired token are recorded via `setIntegrationStatus`
 *    (which arms the cooldown). When that write reports a genuine transition
 *    INTO the expired state, the same credential-expiry notification the
 *    scheduled health check sends fires here too (best-effort) — the health
 *    check notifies on transition only, so a request-path failure that
 *    consumes the ACTIVE→TOKEN_EXPIRED transition must not swallow the
 *    notification with it. The helper's per-integration dedupe key prevents
 *    double rows if both paths race.
 *  - It NEVER throws and NEVER returns token material; callers re-read
 *    credentials via `resolveRepoCredentials` after a successful refresh.
 */
import {
	createRepoIntegrationCredentialNotification,
	db,
	setIntegrationStatus,
} from "@repo/database";
import { refreshProjectRepoGitHubToken } from "@repo/integrations";
import { logger } from "@repo/logs";

/** Minimum gap between lazy (non-forced) refresh attempts per integration. */
const ATLAS_REFRESH_COOLDOWN_MS = 5 * 60_000;

/**
 * Proactive-refresh buffer: a token expiring within this window counts as
 * near-expiry (mirrors the code-search route's 60 s buffer).
 */
const TOKEN_NEAR_EXPIRY_BUFFER_MS = 60_000;

/** Concurrent callers in one process share a single refresh attempt. */
const inflightRefreshes = new Map<string, Promise<EnsureFreshResult>>();

export interface EnsureFreshResult {
	/** Row status after the attempt ("ACTIVE" when usable). */
	status: string;
	/** GITHUB+OAUTH with a stored refresh token — drives UI affordances. */
	canAutoRefresh: boolean;
}

export interface EnsureFreshRepoCredentialsInput {
	integrationId: string;
	userId: string;
	organizationId?: string | null;
	/** true = user-initiated (requestAnalysis / updateBranch): bypass cooldown. */
	force?: boolean;
}

interface IntegrationRefreshRow {
	provider: string;
	authMethod: string;
	status: string;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
	lastHealthCheck: Date | null;
	updatedAt: Date;
}

async function readIntegrationForRefresh(
	integrationId: string,
): Promise<IntegrationRefreshRow | null> {
	return db.projectRepositoryIntegration.findUnique({
		where: { id: integrationId },
		select: {
			provider: true,
			authMethod: true,
			status: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			lastHealthCheck: true,
			updatedAt: true,
		},
	});
}

/** Only GitHub OAuth rows with a stored refresh token can self-heal. */
function isAutoRefreshable(row: IntegrationRefreshRow): boolean {
	return (
		row.provider === "GITHUB" &&
		row.authMethod === "OAUTH" &&
		row.encryptedRefreshToken != null
	);
}

function isNearExpiry(row: IntegrationRefreshRow): boolean {
	return (
		row.tokenExpiresAt != null &&
		row.tokenExpiresAt.getTime() <= Date.now() + TOKEN_NEAR_EXPIRY_BUFFER_MS
	);
}

/** True only when the stored access token is actually past its expiry. */
function isHardExpired(row: IntegrationRefreshRow): boolean {
	return (
		row.tokenExpiresAt != null && row.tokenExpiresAt.getTime() <= Date.now()
	);
}

function isCooldownActive(row: IntegrationRefreshRow): boolean {
	return (
		row.lastHealthCheck != null &&
		Date.now() - row.lastHealthCheck.getTime() < ATLAS_REFRESH_COOLDOWN_MS
	);
}

/**
 * Ensure a project-repo integration's credentials are usable, refreshing the
 * GitHub OAuth access token on demand when possible. Resolves the post-attempt
 * state; see the module doc for throttling/locking semantics. Never throws.
 */
export async function ensureFreshRepoCredentials(
	input: EnsureFreshRepoCredentialsInput,
): Promise<EnsureFreshResult> {
	try {
		const row = await readIntegrationForRefresh(input.integrationId);
		if (!row) {
			return { status: "DISCONNECTED", canAutoRefresh: false };
		}

		const canAutoRefresh = isAutoRefreshable(row);

		// Healthy and not inside the proactive buffer — nothing to do.
		if (row.status === "ACTIVE" && !isNearExpiry(row)) {
			return { status: row.status, canAutoRefresh };
		}
		// No refresh path (PAT, GitLab, missing refresh token) — degrade as-is.
		if (!canAutoRefresh) {
			return { status: row.status, canAutoRefresh: false };
		}
		// Lazy callers respect the persisted cooldown: a recent attempt anywhere
		// (here, another process, or the scheduled health check) suppresses retry.
		if (!input.force && isCooldownActive(row)) {
			return { status: row.status, canAutoRefresh };
		}

		const existing = inflightRefreshes.get(input.integrationId);
		if (existing) {
			return await existing;
		}
		const attempt = performRefresh(input).finally(() => {
			inflightRefreshes.delete(input.integrationId);
		});
		inflightRefreshes.set(input.integrationId, attempt);
		return await attempt;
	} catch (error) {
		// Defensive: a credential refresh must never break the calling read.
		logger.warn("[atlas] credential refresh failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "ERROR", canAutoRefresh: false };
	}
}

async function performRefresh(
	input: EnsureFreshRepoCredentialsInput,
): Promise<EnsureFreshResult> {
	let row: IntegrationRefreshRow | null = null;
	try {
		// Fresh read inside the lock: a concurrent caller (or the health check)
		// may have refreshed while we awaited — short-circuit instead of burning
		// a second OAuth exchange, and pick up the current `updatedAt` for CAS.
		row = await readIntegrationForRefresh(input.integrationId);
		if (!row) {
			return { status: "DISCONNECTED", canAutoRefresh: false };
		}
		if (row.status === "ACTIVE" && !isNearExpiry(row)) {
			return {
				status: row.status,
				canAutoRefresh: isAutoRefreshable(row),
			};
		}
		if (!isAutoRefreshable(row) || !row.encryptedRefreshToken) {
			return { status: row.status, canAutoRefresh: false };
		}

		logger.info("[atlas] credential refresh attempted", {
			integrationId: input.integrationId,
		});
		const token = await refreshProjectRepoGitHubToken({
			integrationId: input.integrationId,
			encryptedRefreshToken: row.encryptedRefreshToken,
			expectedUpdatedAt: row.updatedAt,
			userId: input.userId,
			organizationId: input.organizationId ?? undefined,
		});
		if (token) {
			logger.info("[atlas] credential refresh succeeded", {
				integrationId: input.integrationId,
			});
			return { status: "ACTIVE", canAutoRefresh: true };
		}

		logger.warn("[atlas] credential refresh failed", {
			integrationId: input.integrationId,
		});
		if (isHardExpired(row) || row.status !== "ACTIVE") {
			// Record the failed attempt (this bumps `lastHealthCheck`, arming
			// the cooldown).
			const statusResult = await setIntegrationStatus(
				input.integrationId,
				"TOKEN_EXPIRED",
				"Automatic token refresh failed; re-authentication required.",
			);
			// The scheduled health check notifies on TRANSITION only — if this
			// request-path failure consumed the ACTIVE→TOKEN_EXPIRED flip, the
			// configuring user would otherwise never hear about it. Fire the
			// same notification the health check uses (it carries its own
			// per-integration dedupe key), gated identically on a genuine
			// transition into the expired state.
			if (
				statusResult.statusChanged &&
				statusResult.previousStatus !== "TOKEN_EXPIRED"
			) {
				await notifyCredentialExpiry(input.integrationId);
			}
			return { status: "TOKEN_EXPIRED", canAutoRefresh: true };
		}
		// Refresh failed but the stored token has not actually expired yet (we
		// were only inside the proactive buffer) — keep the row usable, matching
		// the code-search grace-window behaviour.
		return { status: row.status, canAutoRefresh: true };
	} catch (error) {
		logger.warn("[atlas] credential refresh failed", {
			integrationId: input.integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			status: row?.status ?? "ERROR",
			canAutoRefresh: row ? isAutoRefreshable(row) : false,
		};
	}
}

/**
 * Best-effort credential-expiry notification to the configuring user —
 * mirrors `notifyCredentialExpiry` in the repo health-check activity (same
 * recipient, same deep link, same dedupe-keyed helper). The notification
 * fields live outside the lean refresh row, so this rare failure path pays
 * for its own targeted read. Never throws.
 */
async function notifyCredentialExpiry(integrationId: string): Promise<void> {
	try {
		const integration = await db.projectRepositoryIntegration.findUnique({
			where: { id: integrationId },
			select: {
				projectId: true,
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				configuredByUserId: true,
				project: { select: { name: true, organizationId: true } },
			},
		});
		// No configuring user (removed) ⇒ no actionable recipient; the helper
		// would skip too — short-circuit the work.
		if (!integration?.configuredByUserId) {
			return;
		}
		await createRepoIntegrationCredentialNotification({
			recipientUserId: integration.configuredByUserId,
			organizationId: integration.project.organizationId ?? null,
			integrationId,
			projectId: integration.projectId,
			projectName: integration.project.name,
			provider: integration.provider,
			repositoryOwner: integration.repositoryOwner,
			repositoryName: integration.repositoryName,
			status: "TOKEN_EXPIRED",
			// Context-relative deep link to the project's Settings tab — the
			// same target the health-check notification uses.
			link: `projects/${integration.projectId}?tab=settings`,
		});
	} catch (error) {
		logger.warn("[atlas] credential-expiry notification dispatch failed", {
			integrationId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
