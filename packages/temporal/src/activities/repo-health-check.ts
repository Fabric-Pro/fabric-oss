/**
 * Repository Integration Health Check Activities
 *
 * Activities for checking the health of project-level repository integrations:
 * - Fetch active integrations that need health checks
 * - Validate tokens by making lightweight API calls
 * - Refresh expired tokens with optimistic locking
 * - Log rate limit headers for monitoring
 * - Detect PAT expiry for Azure DevOps
 */

import {
	integrationStatusForRepoAccess,
	verifyRepositoryAccess,
} from "@repo/connectors";
import {
	createRepoIntegrationCredentialNotification,
	db,
	getActiveIntegrations,
	logRepoIntegrationActivity,
	type RepositoryIntegrationStatus,
	restoreIntegrationActive,
	setIntegrationStatus,
} from "@repo/database";
import { refreshProjectRepoGitHubTokenWithOutcome } from "@repo/integrations";
import {
	GitLabApiError,
	getValidGitLabAccessToken,
	gitlabRequest,
	refreshGitLabToken,
} from "@repo/integrations/gitlab";
import { decryptApiKey } from "@repo/utils";

// ============================================================================
// Types
// ============================================================================

export interface FetchActiveIntegrationsOutput {
	integrations: Array<{
		id: string;
		provider: string;
		authMethod: string;
		repositoryUrl: string;
		repositoryOwner: string;
		repositoryName: string;
		encryptedAccessToken: string | null;
		encryptedRefreshToken: string | null;
		encryptedPat: string | null;
		tokenExpiresAt: Date | null;
		updatedAt: Date;
		configuredByUserId: string | null;
		projectId: string;
		projectName: string;
		organizationId: string | null;
	}>;
}

export interface CheckIntegrationHealthInput {
	integrationId: string;
	provider: string;
	authMethod: string;
	/**
	 * Only the ADO probe needs it (org/project/repo come from the stored URL);
	 * optional so the legacy replay body — which predates the field and must
	 * stay verbatim — still type-checks.
	 */
	repositoryUrl?: string | null;
	encryptedAccessToken: string | null;
	encryptedRefreshToken: string | null;
	encryptedPat: string | null;
	tokenExpiresAt: Date | null;
	updatedAt: Date;
	configuredByUserId: string | null;
	projectId: string;
	projectName: string;
	organizationId: string | null;
	repositoryOwner: string;
	repositoryName: string;
}

export interface CheckIntegrationHealthOutput {
	integrationId: string;
	healthy: boolean;
	statusChanged: boolean;
	newStatus?: string;
	rateLimitRemaining?: number;
	rateLimitTotal?: number;
}

export interface ValidatePatInput {
	encryptedPat: string;
	azureOrganization?: string | null;
}

export interface ValidatePatOutput {
	valid: boolean;
	error?: string;
}

// ============================================================================
// Activities
// ============================================================================

/**
 * Fetch all active integrations that need health checks.
 */
export async function fetchActiveRepoIntegrations(): Promise<FetchActiveIntegrationsOutput> {
	const integrations = await getActiveIntegrations();

	return {
		integrations: integrations.map((i) => ({
			id: i.id,
			provider: i.provider,
			authMethod: i.authMethod,
			repositoryUrl: i.repositoryUrl,
			repositoryOwner: i.repositoryOwner,
			repositoryName: i.repositoryName,
			encryptedAccessToken: i.encryptedAccessToken,
			encryptedRefreshToken: i.encryptedRefreshToken,
			encryptedPat: i.encryptedPat,
			tokenExpiresAt: i.tokenExpiresAt,
			updatedAt: i.updatedAt,
			configuredByUserId: i.configuredByUserId,
			projectId: i.project.id,
			projectName: i.project.name,
			organizationId: i.project.organizationId,
		})),
	};
}

/**
 * Check the health of a single repository integration.
 * Makes a lightweight API call to verify the token is valid.
 * Captures rate limit headers for monitoring.
 */
export async function checkRepoIntegrationHealth(
	input: CheckIntegrationHealthInput,
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId, provider, authMethod } = input;

	// Status at cycle start — the single source of truth for restore/expiry
	// transitions. Captured BEFORE any refresh, which may write ACTIVE itself.
	const current = await db.projectRepositoryIntegration.findUnique({
		where: { id: integrationId },
		select: { status: true },
	});

	// Disconnect-during-cycle guard: fetchActiveRepoIntegrations handed us a
	// now-stale token; if the user disconnected (tokens wiped → DISCONNECTED) or
	// deleted the row in the meantime, NEVER probe/restore — the stale token may
	// still 200 at the provider and would otherwise resurrect a row the user
	// intentionally removed.
	if (!current || current.status === "DISCONNECTED") {
		return {
			integrationId,
			healthy: false,
			statusChanged: false,
			newStatus: current?.status,
		};
	}

	const originalStatus = current.status as RepositoryIntegrationStatus;
	const wasActive = originalStatus === "ACTIVE";

	try {
		if (provider === "GITHUB" && authMethod === "OAUTH") {
			return await checkGitHubHealth(input, originalStatus);
		}

		if (provider === "GITLAB" && authMethod === "OAUTH") {
			return await checkGitLabHealth(input, originalStatus);
		}

		if (provider === "AZURE_DEVOPS" && authMethod === "PAT") {
			return await checkAzureDevOpsPatHealth(input, originalStatus);
		}

		// GitHub and GitLab can also be connected with a PAT, not just OAuth.
		// Without these branches both fell through to the "unknown combination"
		// ERROR below, so every PAT-connected GitHub/GitLab repo flipped to
		// "Connection error — reconnect to restore access" on the next 30-minute
		// cycle even though its credential was perfectly good and had just
		// cloned and indexed the repository.
		if (provider === "GITHUB" && authMethod === "PAT") {
			return await checkGitHubPatHealth(input, originalStatus);
		}

		if (provider === "GITLAB" && authMethod === "PAT") {
			return await checkGitLabPatHealth(input, originalStatus);
		}

		// Unknown provider/method combination — flag as error to surface misconfigurations
		const statusResult = await setIntegrationStatus(
			integrationId,
			"ERROR",
			`Unknown provider/authMethod combination: ${provider}/${authMethod}`,
		);
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	} catch (error) {
		console.error(
			`[RepoHealthCheck] Error checking ${integrationId}:`,
			error,
		);

		const statusResult = await setIntegrationStatus(
			integrationId,
			"ERROR",
			error instanceof Error ? error.message : "Health check failed",
		);

		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(
				input,
				"repo_integration_health_check_error",
			);
		}

		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}
}

/**
 * Validate an Azure DevOps PAT by making a test API call.
 * Used as a Temporal activity during the connect flow.
 */
export async function validateAzureDevOpsPat(
	input: ValidatePatInput,
): Promise<ValidatePatOutput> {
	try {
		const pat = decryptApiKey(input.encryptedPat);
		const org = input.azureOrganization;

		if (!org) {
			return { valid: false, error: "Azure organization is required" };
		}

		const response = await fetch(
			`https://dev.azure.com/${org}/_apis/connectionData`,
			{
				headers: {
					Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
				},
				signal: AbortSignal.timeout(10_000),
			},
		);

		if (response.ok) {
			return { valid: true };
		}

		if (response.status === 401 || response.status === 403) {
			return {
				valid: false,
				error: "Invalid PAT or insufficient permissions",
			};
		}

		return { valid: false, error: `Unexpected status: ${response.status}` };
	} catch (error) {
		return {
			valid: false,
			error:
				error instanceof Error
					? error.message
					: "PAT validation failed",
		};
	}
}

// ============================================================================
// Provider-Specific Health Checks
// ============================================================================

/**
 * Shared "confirmed clean 200" success handler used by every provider. Restores
 * ACTIVE only via the disconnect-safe conditional helper; logs the transition
 * only on a genuine restore. `extra` carries provider-specific result fields
 * (e.g. GitHub rate-limit counters); GitLab/ADO pass `{}`.
 */
async function handleHealthyProbe(
	input: CheckIntegrationHealthInput,
	wasActive: boolean,
	extra: Partial<CheckIntegrationHealthOutput> = {},
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId } = input;
	if (!wasActive) {
		const restored = await restoreIntegrationActive(integrationId);
		if (restored) {
			await logHealthActivity(input, "repo_integration_restored");
			return {
				integrationId,
				healthy: true,
				statusChanged: true,
				newStatus: "ACTIVE",
				...extra,
			};
		}
		// Concurrently disconnected/deleted — do not resurrect or log.
		return { integrationId, healthy: true, statusChanged: false, ...extra };
	}
	await db.projectRepositoryIntegration.update({
		where: { id: integrationId },
		// Deliberately does NOT clear `refreshTokenRejectedAt`. A 200 from
		// `/user` proves the ACCESS token works; it says nothing about the
		// REFRESH token, which is a separate credential. An on-demand refresh
		// can confirm the grant is dead while the access token still has hours
		// left on it, and erasing that confirmation here would let the dead
		// grant rejoin the 30-minute refresh loop the moment the access token
		// expires — reintroducing exactly the bug the marker exists to stop.
		// Only a successful refresh or a reconnect proves the marker obsolete,
		// and both already clear it.
		data: { lastHealthCheck: new Date(), lastError: null },
	});
	return { integrationId, healthy: true, statusChanged: false, ...extra };
}

/**
 * After the account-level probe has confirmed the credential is alive, ask the
 * repository itself whether this credential can read it — the question the
 * badge actually answers. A token with no access to the repository answers
 * `/user` with 200 forever, so without this probe a repo the app was never
 * installed on stayed Active while every read of it failed.
 *
 * Returns `null` when the row is confirmed fully healthy and the caller should
 * proceed to `handleHealthyProbe`; otherwise it has already written the verdict
 * (or deliberately made no transition) and the returned output is final.
 */
async function settleRepoAccess(
	input: CheckIntegrationHealthInput,
	wasActive: boolean,
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS",
	token: string,
	extra: Partial<CheckIntegrationHealthOutput> = {},
	opts: {
		azureOrganization?: string | null;
		/**
		 * Snapshot of `updatedAt` taken BEFORE any credential-using call in
		 * this cycle. When provided, the verdict write is pinned to it: if
		 * attachPat/reconnect flipped the credential mid-cycle, a verdict
		 * drawn from the old credential never lands on the new one. Leave
		 * undefined when an earlier step in the same cycle may already have
		 * written (e.g. a successful refresh) — the snapshot would be stale
		 * by design and every verdict would spuriously miss.
		 */
		snapshotUpdatedAt?: Date;
		/**
		 * The status the row held at cycle start. A transition into
		 * REPO_UNAVAILABLE from anything OTHER than itself is worth one
		 * notification even when the row was not ACTIVE (e.g.
		 * TOKEN_EXPIRED → REPO_UNAVAILABLE changes the remedy from
		 * "reconnect" to "grant access") — the per-status dedupe key keeps
		 * repeats suppressed while a notice is unread.
		 */
		originalStatus?: RepositoryIntegrationStatus;
	} = {},
): Promise<CheckIntegrationHealthOutput | null> {
	const { integrationId } = input;
	const { outcome } = await verifyRepositoryAccess({
		provider,
		token,
		repositoryUrl:
			provider === "AZURE_DEVOPS"
				? (input.repositoryUrl ?? "")
				: `https://${provider === "GITHUB" ? "github.com" : "gitlab.com"}/${input.repositoryOwner}/${input.repositoryName}`,
		owner: input.repositoryOwner,
		repo: input.repositoryName,
		azureOrganization: opts.azureOrganization,
	});
	if (outcome === "accessible") {
		return null;
	}
	const verdict = integrationStatusForRepoAccess(outcome, provider);
	if (verdict.status === "ACTIVE") {
		// Inconclusive (network/5xx): no transition — stamp the sweep and let
		// the next cycle retry, mirroring the rate-limit-wall handling.
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date() },
		});
		return { integrationId, healthy: true, statusChanged: false, ...extra };
	}
	const statusResult = await setIntegrationStatus(
		integrationId,
		verdict.status,
		verdict.lastError ?? undefined,
		undefined,
		opts.snapshotUpdatedAt,
	);
	if (!statusResult.written) {
		// Disconnected/deleted mid-cycle, or the row's credentials changed
		// after our snapshot — never resurrect or log stale evidence.
		return {
			integrationId,
			healthy: false,
			statusChanged: false,
			...extra,
		};
	}
	if (verdict.status === "REPO_UNAVAILABLE") {
		// Count consecutive definitive negatives so permanently unreadable
		// repos retire from the sweep instead of being probed forever. The
		// counter resets on any successful probe, reconnect, or attachPat.
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { probeFailCount: { increment: 1 } },
		});
	}
	if (
		statusResult.statusChanged &&
		(wasActive || opts.originalStatus !== "REPO_UNAVAILABLE")
	) {
		await logHealthActivity(
			input,
			verdict.status === "REPO_UNAVAILABLE"
				? "repo_integration_unavailable"
				: "repo_integration_token_expired",
		);
		await notifyCredentialExpiry(input, verdict.status);
	}
	return {
		integrationId,
		healthy: false,
		statusChanged: statusResult.statusChanged,
		newStatus: statusResult.status,
		...extra,
	};
}

async function checkGitHubHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId, encryptedAccessToken, encryptedRefreshToken } =
		input;
	const wasActive = originalStatus === "ACTIVE";

	if (!encryptedAccessToken) {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"TOKEN_EXPIRED",
			"No access token configured",
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_token_expired");
			await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	const accessToken = decryptApiKey(encryptedAccessToken);

	// Lightweight API call: GET /user. Bounded so one hung provider response
	// cannot stall this integration (and the serial sweep behind it) until the
	// multi-minute activity timeout.
	const response = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/vnd.github.v3+json",
			"User-Agent": "Fabric-Platform",
		},
		signal: AbortSignal.timeout(10_000),
	});

	// Capture rate limit headers
	const rateLimitRemaining = Number.parseInt(
		response.headers.get("x-ratelimit-remaining") ?? "0",
		10,
	);
	const rateLimitTotal = Number.parseInt(
		response.headers.get("x-ratelimit-limit") ?? "0",
		10,
	);

	console.log(
		`[RepoHealthCheck] GitHub rate limit for ${integrationId}: ${rateLimitRemaining}/${rateLimitTotal}`,
	);

	if (response.ok) {
		const settled = await settleRepoAccess(
			input,
			wasActive,
			"GITHUB",
			accessToken,
			{ rateLimitRemaining, rateLimitTotal },
			// No earlier write this cycle — the cycle-start snapshot is exact
			// for the CAS pin against mid-cycle credential rebinding.
			{
				snapshotUpdatedAt: input.updatedAt,
				originalStatus: originalStatus,
			},
		);
		if (settled) {
			return settled;
		}
		return await handleHealthyProbe(input, wasActive, {
			rateLimitRemaining,
			rateLimitTotal,
		});
	}
	// Check if 403 is actually rate limiting, not auth failure
	if (response.status === 403 && rateLimitRemaining === 0) {
		console.warn(
			`[RepoHealthCheck] GitHub rate limited for ${integrationId}, treating as healthy`,
		);
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date(), lastError: null },
		});
		return {
			integrationId,
			healthy: true,
			statusChanged: false,
			rateLimitRemaining,
			rateLimitTotal,
		};
	}

	// 401/403 with a stored refresh token: refresh under the existing
	// per-integration advisory lock (refreshProjectRepoGitHubTokenWithOutcome is built for
	// both this activity and the request path — no race), then RE-PROBE. Refresh
	// success alone is not a confirmed repo round-trip (AC-2), so only a 200 from
	// the re-probe restores ACTIVE.
	if (
		(response.status === 401 || response.status === 403) &&
		encryptedRefreshToken
	) {
		// Outcome-aware variant, NOT the `string | null` wrapper: a bare null
		// cannot distinguish "the provider rejected the customer's grant" from
		// "our own refresh path failed" from "we cannot tell", and those need
		// different handling — see the branches after the re-probe below.
		const {
			token: refreshed,
			grantRejected,
			rejectedRefreshToken,
		} = await refreshProjectRepoGitHubTokenWithOutcome({
			integrationId,
			encryptedRefreshToken,
			expectedUpdatedAt: input.updatedAt,
			userId: input.configuredByUserId ?? undefined,
			organizationId: input.organizationId ?? undefined,
		});

		if (refreshed) {
			const reprobe = await fetch("https://api.github.com/user", {
				headers: {
					Authorization: `Bearer ${refreshed}`,
					Accept: "application/vnd.github.v3+json",
					"User-Agent": "Fabric-Platform",
				},
				signal: AbortSignal.timeout(10_000),
			});
			const reprobeRemaining = Number.parseInt(
				reprobe.headers.get("x-ratelimit-remaining") ?? "0",
				10,
			);

			// Confirmed clean 200 → restore via the same disconnect-safe handler as
			// the initial probe (only a real 200 restores ACTIVE — AC-2). The repo
			// probe gates the restore: /user succeeding for a token that still
			// cannot read the repository must not resurrect an unreachable row.
			if (reprobe.ok) {
				const settled = await settleRepoAccess(
					input,
					wasActive,
					"GITHUB",
					refreshed,
					{ rateLimitRemaining, rateLimitTotal },
				);
				if (settled) {
					return settled;
				}
				return await handleHealthyProbe(input, wasActive, {
					rateLimitRemaining,
					rateLimitTotal,
				});
			}

			// Genuine auth/permission failure after refresh (partial success) →
			// TOKEN_EXPIRED (AC-2). A 403 rate-limit wall (remaining 0) is NOT an
			// auth failure and falls through to the inconclusive branch below.
			// Refresh's optimistic ACTIVE is overwritten here.
			if (
				reprobe.status === 401 ||
				(reprobe.status === 403 && reprobeRemaining > 0)
			) {
				const statusResult = await setIntegrationStatus(
					integrationId,
					"TOKEN_EXPIRED",
					`GitHub API returned ${reprobe.status} after token refresh`,
				);
				if (wasActive && statusResult.statusChanged) {
					await logHealthActivity(
						input,
						"repo_integration_token_expired",
					);
					await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
				}
				return {
					integrationId,
					healthy: false,
					statusChanged: statusResult.statusChanged,
					newStatus: statusResult.status,
					rateLimitRemaining,
					rateLimitTotal,
				};
			}

			// Inconclusive: 403 rate-limit wall (remaining 0) OR transient 5xx /
			// other non-auth response. Refresh succeeded (credentials valid), so make
			// NO expiry transition. The refresh already wrote ACTIVE
			// optimistically; neutralize it by reasserting the cycle-start status so
			// this cycle makes no transition. Retry next cycle.
			if (!wasActive) {
				// originalStatus is never DISCONNECTED here (we bailed earlier) and
				// is non-ACTIVE, so this cannot resurrect a usable connection.
				await setIntegrationStatus(integrationId, originalStatus);
			} else {
				await db.projectRepositoryIntegration.update({
					where: { id: integrationId },
					data: { lastHealthCheck: new Date() },
				});
			}
			return {
				integrationId,
				healthy: true,
				statusChanged: false,
				rateLimitRemaining,
				rateLimitTotal,
			};
		}

		// Refresh failed WITHOUT the provider rejecting the grant. Two cases
		// land here and both defer exactly as this branch always did:
		//
		//   - a platform fault — no deployment OAuth client credentials, the
		//     token endpoint unreachable, our own database throwing. Every
		//     expired integration on the deployment hits these at the same
		//     moment, so flipping status would tell every tenant to reconnect a
		//     credential that is fine.
		//   - an ambiguous or request-side code — a bare 4xx, `invalid_request`
		//     and friends — where blaming the customer is a guess.
		//
		// A rejection whose credential a concurrent reconnect already replaced
		// also arrives here, which is what keeps this sweep from expiring a
		// connection the user has just repaired.
		if (!grantRejected) {
			return {
				integrationId,
				healthy: true,
				statusChanged: false,
				rateLimitRemaining,
				rateLimitTotal,
			};
		}

		// The provider rejected the grant, against the credential that is still
		// stored. Retrying can never recover that — only a user reconnect can —
		// so take the same terminal path as the no-refresh-token case below
		// rather than deferring forever. Where the provider named the refresh
		// token itself, the refresh has also stamped `refreshTokenRejectedAt`,
		// retiring the row from this sweep until the user reconnects.
		// Pinned to the credential the provider actually rejected. `grantRejected`
		// was true when the refresh transaction committed, but a reconnect can
		// land in the gap before this write — and without the pin this would
		// expire the connection the user had just repaired and tell them to
		// repair it again. On a miss the row now holds a different credential,
		// so our evidence is stale: defer and let the next cycle probe it.
		const rejectedResult = await setIntegrationStatus(
			integrationId,
			"TOKEN_EXPIRED",
			"GitHub rejected the stored refresh token — reconnect required",
			rejectedRefreshToken,
		);
		if (!rejectedResult.written) {
			return {
				integrationId,
				healthy: true,
				statusChanged: false,
				rateLimitRemaining,
				rateLimitTotal,
			};
		}
		if (wasActive && rejectedResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_token_expired");
			await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: rejectedResult.statusChanged,
			newStatus: rejectedResult.status,
			rateLimitRemaining,
			rateLimitTotal,
		};
	}

	// No refresh path (PAT / missing refresh token).
	// A genuine expiry is ONLY a definitive negative: 401, or 403 where the
	// quota wall / retry-after checks have already run above. 429 and 5xx say
	// nothing about the credential (AC2) — stamp the sweep and let the next
	// cycle retry rather than telling the user to reconnect on a provider
	// hiccup.
	if (response.status === 429 || response.status >= 500) {
		console.warn(
			`[RepoHealthCheck] GitHub returned ${response.status} for ${integrationId}; leaving status unchanged`,
		);
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date() },
		});
		return { integrationId, healthy: true, statusChanged: false };
	}
	const statusResult = await setIntegrationStatus(
		integrationId,
		"TOKEN_EXPIRED",
		`GitHub API returned ${response.status}`,
	);
	if (wasActive && statusResult.statusChanged) {
		await logHealthActivity(input, "repo_integration_token_expired");
		await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
	}
	return {
		integrationId,
		healthy: false,
		statusChanged: statusResult.statusChanged,
		newStatus: statusResult.status,
		rateLimitRemaining,
		rateLimitTotal,
	};
}

async function checkGitLabHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId, encryptedAccessToken, encryptedRefreshToken } =
		input;
	const wasActive = originalStatus === "ACTIVE";

	if (!encryptedAccessToken) {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"TOKEN_EXPIRED",
			"No access token configured",
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_token_expired");
			await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	let accessToken: string;
	try {
		accessToken = decryptApiKey(encryptedAccessToken);
	} catch (_err) {
		// Auth-reason ERROR: the stored credential is unusable and the user
		// must reconnect — surface it like an expiry.
		const statusResult = await setIntegrationStatus(
			integrationId,
			"ERROR",
			"Stored GitLab credentials cannot be decrypted. Please reconnect your GitLab integration.",
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_decrypt_failed");
			await notifyCredentialExpiry(input, "ERROR");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	// Wire token refresh so a stale access-token (GitLab tokens expire ~2h)
	// doesn't flap us to TOKEN_EXPIRED when a valid refresh_token exists.
	// Requires both an encrypted refresh_token AND env-configured OAuth
	// client creds; otherwise we skip refresh and let 401 surface (degraded).
	const clientId = process.env.GITLAB_CLIENT_ID;
	const clientSecret = process.env.GITLAB_CLIENT_SECRET;
	const onRefreshToken =
		encryptedRefreshToken && clientId && clientSecret
			? async () =>
					getValidGitLabAccessToken({
						// Cast matches the convention at the other production call
						// sites (e.g. packages/api/.../gitlab-oauth.ts) — the
						// structural db type in get-valid-access-token.ts uses
						// `args: unknown` accessors that the real PrismaClient
						// doesn't satisfy without help.
						db: db as never,
						integrationId,
						clientId,
						clientSecret,
						source: "project",
						refresh: refreshGitLabToken,
					})
			: undefined;

	try {
		await gitlabRequest({
			path: "/user",
			token: accessToken,
			onRefreshToken,
		});
		// The account-level probe above may have lazily refreshed the stored
		// token; ask the repository with whatever credential is valid NOW, not
		// the possibly-stale decrypted copy.
		let tokenForProbe = accessToken;
		if (onRefreshToken) {
			try {
				tokenForProbe = await onRefreshToken();
			} catch {
				tokenForProbe = accessToken;
			}
		}
		const settled = await settleRepoAccess(
			input,
			wasActive,
			"GITLAB",
			tokenForProbe,
			{},
			{ originalStatus: originalStatus },
		);
		if (settled) {
			return settled;
		}
		return await handleHealthyProbe(input, wasActive);
	} catch (error) {
		if (error instanceof GitLabApiError && error.status === 401) {
			// 401 → TOKEN_EXPIRED. We already attempted token refresh via
			// onRefreshToken; if we still see 401 (or REFRESH_FAILED), the
			// refresh token is also expired/revoked and the user must reconnect.
			const statusResult = await setIntegrationStatus(
				integrationId,
				"TOKEN_EXPIRED",
				`GitLab API returned ${error.status}`,
			);
			if (wasActive && statusResult.statusChanged) {
				await logHealthActivity(
					input,
					"repo_integration_token_expired",
				);
				await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
			}
			return {
				integrationId,
				healthy: false,
				statusChanged: statusResult.statusChanged,
				newStatus: statusResult.status,
			};
		}
		if (error instanceof GitLabApiError && error.status === 429) {
			// Rate-limited — treat as healthy. The shared rest-client already
			// attempts an internal retry; if we still see 429 here, the token
			// is valid and we just hit a quota wall.
			console.warn(
				`[RepoHealthCheck] GitLab rate limited for ${integrationId}, treating as healthy`,
			);
			await db.projectRepositoryIntegration.update({
				where: { id: integrationId },
				data: { lastHealthCheck: new Date(), lastError: null },
			});
			return {
				integrationId,
				healthy: true,
				statusChanged: false,
			};
		}
		if (error instanceof GitLabApiError && error.status >= 500) {
			// A provider-side 5xx says nothing about the credential (AC2) — the
			// old outer-catch ERROR flip told the user to reconnect on a GitLab
			// incident. Stamp the sweep and let the next cycle retry instead.
			console.warn(
				`[RepoHealthCheck] GitLab returned ${error.status} for ${integrationId}; leaving status unchanged`,
			);
			await db.projectRepositoryIntegration.update({
				where: { id: integrationId },
				data: { lastHealthCheck: new Date() },
			});
			return {
				integrationId,
				healthy: true,
				statusChanged: false,
			};
		}
		throw error;
	}
}

/**
 * Probe a PAT-connected repository.
 *
 * The probe is REPOSITORY-scoped (`GET /repos/{owner}/{repo}` for GitHub, the
 * project endpoint for GitLab), not account-level: a scoped PAT can be perfectly
 * valid at the account level yet unable to read this one repository, and that
 * distinction decides the remedy. 401 means the credential itself was rejected —
 * TOKEN_EXPIRED, reconnect with a new token. 403/404 mean the credential works
 * but cannot see THIS repository — REPO_UNAVAILABLE, where reconnecting fixes
 * nothing. A quota wall or a 5xx makes no transition at all.
 */
async function checkPatHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
	provider: "GITHUB" | "GITLAB",
	providerLabel: string,
	probe: (
		input: CheckIntegrationHealthInput,
		pat: string,
	) => Promise<Response>,
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId, encryptedPat } = input;
	const wasActive = originalStatus === "ACTIVE";

	if (!encryptedPat) {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"TOKEN_EXPIRED",
			"No PAT configured",
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_token_expired");
			await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	let pat: string;
	try {
		pat = decryptApiKey(encryptedPat);
	} catch {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"ERROR",
			`Stored ${providerLabel} PAT cannot be decrypted. Please reconnect the repository.`,
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_decrypt_failed");
			await notifyCredentialExpiry(input, "ERROR");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	const response = await probe(input, pat);
	if (response.ok) {
		return await handleHealthyProbe(input, wasActive);
	}

	// A quota wall is not a dead credential. GitHub answers 403 when rate
	// limited (with `x-ratelimit-remaining: 0`) and both providers answer 429;
	// treating either as TOKEN_EXPIRED would flip a perfectly good PAT to
	// "reconnect required" and notify the user, purely because the org was busy.
	// The OAuth GitHub branch above already guards against this — the PAT branch
	// did not, which reintroduced that false positive for PAT-connected repos.
	const rateLimitRemaining = Number.parseInt(
		response.headers.get("x-ratelimit-remaining") ?? "-1",
		10,
	);
	const rateLimited =
		response.status === 429 ||
		(response.status === 403 &&
			(rateLimitRemaining === 0 ||
				response.headers.get("retry-after") !== null));
	if (rateLimited) {
		console.warn(
			`[RepoHealthCheck] ${providerLabel} rate limited for ${integrationId} (HTTP ${response.status}); leaving status unchanged`,
		);
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date(), lastError: null },
		});
		return { integrationId, healthy: true, statusChanged: false };
	}

	// Map the repo-scoped answer through the SAME outcome→status mapping the
	// connect path uses, so both lanes tell one story about what a code host's
	// non-2xx means.
	const outcome =
		response.status === 401
			? ("unauthorized" as const)
			: response.status === 403
				? ("forbidden" as const)
				: response.status === 404
					? ("not-found" as const)
					: null;
	if (!outcome) {
		// Inconclusive (5xx and oddballs): no transition — a provider hiccup
		// must not expire a good credential. Stamp the sweep and retry next
		// cycle.
		console.warn(
			`[RepoHealthCheck] ${providerLabel} returned HTTP ${response.status} for ${integrationId}; leaving status unchanged`,
		);
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date() },
		});
		return { integrationId, healthy: true, statusChanged: false };
	}
	const verdict = integrationStatusForRepoAccess(outcome, provider);
	const statusResult = await setIntegrationStatus(
		integrationId,
		verdict.status,
		verdict.lastError ?? undefined,
	);
	if (!statusResult.written) {
		return { integrationId, healthy: false, statusChanged: false };
	}
	if (verdict.status === "REPO_UNAVAILABLE") {
		// Same retirement budget as the OAuth lanes: a deleted repo connected
		// by PAT must also stop being probed forever. The counter resets on
		// any successful probe, reconnect, or attachPat.
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { probeFailCount: { increment: 1 } },
		});
	}
	if (wasActive && statusResult.statusChanged) {
		await logHealthActivity(
			input,
			verdict.status === "REPO_UNAVAILABLE"
				? "repo_integration_unavailable"
				: "repo_integration_token_expired",
		);
		await notifyCredentialExpiry(input, verdict.status);
	}
	return {
		integrationId,
		healthy: false,
		statusChanged: statusResult.statusChanged,
		newStatus: statusResult.status,
	};
}

function checkGitHubPatHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
): Promise<CheckIntegrationHealthOutput> {
	return checkPatHealth(input, originalStatus, "GITHUB", "GitHub", (i, pat) =>
		fetch(
			`https://api.github.com/repos/${encodeURIComponent(i.repositoryOwner)}/${encodeURIComponent(i.repositoryName)}`,
			{
				headers: {
					Authorization: `Bearer ${pat}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "Fabric-Platform",
				},
				signal: AbortSignal.timeout(5000),
			},
		),
	);
}

function checkGitLabPatHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
): Promise<CheckIntegrationHealthOutput> {
	// GitLab PATs authenticate with PRIVATE-TOKEN, not a Bearer header; the
	// project endpoint is the repo-scoped read the badge should reflect.
	return checkPatHealth(input, originalStatus, "GITLAB", "GitLab", (i, pat) =>
		fetch(
			`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${i.repositoryOwner}/${i.repositoryName}`)}`,
			{
				headers: { "PRIVATE-TOKEN": pat },
				signal: AbortSignal.timeout(5000),
			},
		),
	);
}

async function checkAzureDevOpsPatHealth(
	input: CheckIntegrationHealthInput,
	originalStatus: RepositoryIntegrationStatus,
): Promise<CheckIntegrationHealthOutput> {
	const { integrationId, encryptedPat } = input;
	const wasActive = originalStatus === "ACTIVE";

	if (!encryptedPat) {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"TOKEN_EXPIRED",
			"No PAT configured",
		);
		if (wasActive && statusResult.statusChanged) {
			await logHealthActivity(input, "repo_integration_token_expired");
			await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
		}
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	const pat = decryptApiKey(encryptedPat);

	// Look up azureOrganization from DB
	const integration = await db.projectRepositoryIntegration.findUnique({
		where: { id: integrationId },
		select: { azureOrganization: true },
	});

	const org = integration?.azureOrganization;
	if (!org) {
		const statusResult = await setIntegrationStatus(
			integrationId,
			"ERROR",
			"Azure organization not configured",
		);
		return {
			integrationId,
			healthy: false,
			statusChanged: statusResult.statusChanged,
			newStatus: statusResult.status,
		};
	}

	const response = await fetch(
		`https://dev.azure.com/${org}/_apis/connectionData`,
		{
			headers: {
				Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
			},
			signal: AbortSignal.timeout(10_000),
		},
	);

	if (response.ok) {
		// The account-level connectionData call proves the PAT is alive; only
		// the repository itself answers whether THIS credential can read THIS
		// repo (Fizzy #2252 AC4) — a scope-limited PAT passes connectionData
		// while every repo read 403s.
		const settled = await settleRepoAccess(
			input,
			wasActive,
			"AZURE_DEVOPS",
			pat,
			{},
			{
				azureOrganization: org,
				snapshotUpdatedAt: input.updatedAt,
				originalStatus: originalStatus,
			},
		);
		if (settled) {
			return settled;
		}
		return await handleHealthyProbe(input, wasActive);
	}

	// PAT expired or invalid — but only on definitive answers. A 5xx says
	// nothing about the credential (AC2): stamp the sweep and retry next cycle.
	if (response.status >= 500) {
		console.warn(
			`[RepoHealthCheck] Azure DevOps returned ${response.status} for ${integrationId}; leaving status unchanged`,
		);
		await db.projectRepositoryIntegration.update({
			where: { id: integrationId },
			data: { lastHealthCheck: new Date() },
		});
		return { integrationId, healthy: true, statusChanged: false };
	}
	const statusResult = await setIntegrationStatus(
		integrationId,
		"TOKEN_EXPIRED",
		`Azure DevOps API returned ${response.status}`,
	);
	if (wasActive && statusResult.statusChanged) {
		await logHealthActivity(input, "repo_integration_token_expired");
		await notifyCredentialExpiry(input, "TOKEN_EXPIRED");
	}
	return {
		integrationId,
		healthy: false,
		statusChanged: statusResult.statusChanged,
		newStatus: statusResult.status,
	};
}

// ============================================================================
// Audit Logging Activity
// ============================================================================

export interface LogRepoContextAccessedInput {
	projectId: string;
	userId: string;
	organizationId?: string;
	repoUrls: string[];
}

/**
 * Log that a user accessed repository context via project-level credentials.
 * Called once per workflow invocation, not per repo URL.
 */
export async function logRepoContextAccessedActivity(
	input: LogRepoContextAccessedInput,
): Promise<void> {
	const user = await db.user.findUnique({
		where: { id: input.userId },
		select: { name: true },
	});

	// Get project for org context
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { organizationId: true },
	});

	await logRepoIntegrationActivity({
		projectId: input.projectId,
		userId: input.userId,
		userName: user?.name ?? "Unknown",
		organizationId: input.organizationId ?? project?.organizationId,
		activityType: "repo_context_accessed",
		metadata: {
			repoUrls: input.repoUrls,
			action: "code_analysis",
		},
	});
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Fire a one-time "repository credentials expired" user notification.
 *
 * Callers gate this on `wasActive` — only called when the row was genuinely
 * ACTIVE before this cycle, ensuring no per-cycle re-notification for rows
 * that are already in an expired state.
 *
 * Best-effort: wrap in try/catch so a notification failure can never fail the
 * health check. `configuredByUserId` may be null; we short-circuit early to
 * avoid unnecessary work.
 */
async function notifyCredentialExpiry(
	input: CheckIntegrationHealthInput,
	newStatus: "TOKEN_EXPIRED" | "ERROR" | "REPO_UNAVAILABLE",
): Promise<void> {
	const userId = input.configuredByUserId;
	if (!userId) {
		return;
	}

	try {
		await createRepoIntegrationCredentialNotification({
			recipientUserId: userId,
			organizationId: input.organizationId,
			integrationId: input.integrationId,
			projectId: input.projectId,
			projectName: input.projectName,
			provider: input.provider,
			repositoryOwner: input.repositoryOwner,
			repositoryName: input.repositoryName,
			status: newStatus,
			// Context-relative deep link to the project's Settings tab (where the
			// repository integration lives, under the Execution sub-tab). No
			// leading slash: the inbox prepends the active workspace base via
			// `resolveNotificationLink`. The Settings SUB-tab is client-side
			// localStorage state, not a URL param, so we link the top-level
			// Settings tab — the same target the existing "PM credentials
			// expired" CTAs use (`buildProjectSettingsRoute`).
			link: `projects/${input.projectId}?tab=settings`,
		});
	} catch (error) {
		console.error(
			`[RepoHealthCheck] Failed to send credential-expiry notification for ${input.integrationId}:`,
			error,
		);
	}
}

async function logHealthActivity(
	input: CheckIntegrationHealthInput,
	activityType: string,
) {
	// configuredByUserId may be null if the original user was removed
	const userId = input.configuredByUserId;
	if (!userId) {
		console.warn(
			`[RepoHealthCheck] Cannot log activity for ${input.integrationId}: no configuredByUserId`,
		);
		return;
	}

	try {
		// Get user name for the activity log
		const user = await db.user.findUnique({
			where: { id: userId },
			select: { name: true },
		});

		await logRepoIntegrationActivity({
			projectId: input.projectId,
			userId,
			userName: user?.name ?? "System",
			organizationId: input.organizationId,
			activityType,
			integrationId: input.integrationId,
			repositoryName: `${input.repositoryOwner}/${input.repositoryName}`,
			metadata: {
				provider: input.provider,
				projectName: input.projectName,
				trigger: "health_check",
			},
		});
	} catch (error) {
		console.error(
			`[RepoHealthCheck] Failed to log activity for ${input.integrationId}:`,
			error,
		);
	}
}
