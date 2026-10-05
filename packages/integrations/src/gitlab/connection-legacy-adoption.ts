/**
 * One-off adoption of legacy GitLab MCP credential copies — for
 * `packages/api/scripts/backfill-gitlab-connections.ts` ONLY.
 *
 * REMOVE THIS MODULE (and the script's import of it) once migration
 * `20261004120000_gitlab_mcp_config_drop_token_copies` has applied in
 * production. That migration nulls every credential copy on the `gitlab` /
 * `gitlab-official` MCPConfig rows (OAuth token columns and API key), after
 * which there is nothing left here to adopt or compare against.
 *
 * Why it still exists: the migration nulls a copy with no personal GitLab
 * connection row behind it, and its owner then reconnects GitLab. Running the
 * backfill script first is optional and adopts each such copy into the
 * person's connection instead; it has to work against the code it ships with,
 * so the adoption path ships in the same release.
 *
 * Nothing at request time or in a worker reaches this module: the connection
 * service (`./connection`) no longer adopts on read, and this file is exported
 * only through its own package subpath (`@repo/integrations/gitlab/
 * connection-legacy-adoption`), not through `@repo/integrations/gitlab`.
 *
 * Adoption reads the copies and never writes them. It reads EVERY
 * `gitlab` / `gitlab-official` config the person owns in the tenant (a person
 * can have several), never just the first a query returns. Where it has to
 * pick one copy it does so deterministically: a `gitlab-official` copy with a
 * token and its own registration on an allowed address, most recently
 * updated first, then lowest id; an API key copy, `gitlab-official` first,
 * then most recently updated, then lowest id. What it decides, from stored
 * evidence only (never by trying a refresh or calling GitLab):
 *   - no connection row (or one without a token that the person did not
 *     disconnect), and a `gitlab-official` copy with its own dynamic client
 *     registration: create the connection from the copy, with that
 *     registration as its issuer (production's case);
 *   - the same, with no such copy but a personal access token saved as the
 *     API key of a `gitlab` / `gitlab-official` config: connect that token as
 *     a PAT through the connection service's own connect path, on the
 *     instance the config names;
 *   - an inactive row WITH a token, and a different `gitlab-official` token
 *     written after it was deactivated (a later reconnect from the MCP
 *     Servers page): take the copy into that row;
 *   - an active row without an issuer whose access or refresh token is the
 *     one on ANY `gitlab-official` copy with its own registration: it may have
 *     been minted by that registration or copied there from the app flow, so
 *     it is marked reconnect-required (`shared-with-mcp-registration`), never
 *     classified as the integration app's;
 *   - otherwise, the connection service's own classification of an existing
 *     row without an issuer (`planGitLabClassification`).
 */

import {
	applyGitLabClassification,
	connectGitLab,
	decryptOrNull,
	GITLAB_DEFAULT_ORIGIN,
	type GitLabClassificationPlan,
	type GitLabClassificationSnapshot,
	type GitLabConnectionDb,
	type GitLabConnectionDeps,
	type GitLabTenant,
	gitlabConnectionInternals,
	loadGitLabClassificationSnapshot,
	mcpRowOrigin,
	planGitLabClassification,
	resolveGitLabConnectionDeps,
	type StoredGitLabCredential,
	selectCanonicalConnection,
	viewConnection,
} from "./connection";
import { parseGitLabOrigin } from "./outbound";

const { readRows, lockKeys, encryptCredential, toMs, isPatShape } =
	gitlabConnectionInternals;

/** One of the person's `gitlab-official` MCPConfigs, token copy included. */
export type LegacyOfficialCopy = {
	id: string;
	baseUrl: string | null;
	oauthClientId: string | null;
	encryptedAccessToken: string | null;
	encryptedRefreshToken: string | null;
	tokenExpiresAt: Date | null;
	needsReauth: boolean;
	updatedAt?: Date | string;
	mcpServer?: { key?: string | null; defaultUrl?: string | null } | null;
};

/** A `gitlab` / `gitlab-official` MCPConfig holding an API key. */
export type LegacyApiKeyCopy = {
	id: string;
	baseUrl: string | null;
	encryptedApiKey: string | null;
	updatedAt?: Date | string;
	mcpServer?: { key?: string | null; defaultUrl?: string | null } | null;
};

export type GitLabAdoptionSnapshot = GitLabClassificationSnapshot & {
	/**
	 * EVERY `gitlab-official` MCPConfig the person owns in this tenant: a
	 * person can have several, and the evidence (a registration, a token
	 * copy) may be on any of them, not on whichever a query returns first.
	 */
	officialCopies: LegacyOfficialCopy[];
	/** Every `gitlab` / `gitlab-official` MCPConfig holding an API key. */
	apiKeyCopies: LegacyApiKeyCopy[];
};

type ReconnectReason =
	| Extract<
			GitLabClassificationPlan,
			{ action: "reconnect-required" }
	  >["reason"]
	| "shared-with-mcp-registration";

export type GitLabAdoptionPlan =
	| Exclude<GitLabClassificationPlan, { action: "reconnect-required" }>
	| { action: "reconnect-required"; rowId: string; reason: ReconnectReason }
	| {
			action: "adopt-mcp";
			targetRowId: string | null;
			/** The `gitlab-official` copy adopted (see `adoptableOfficialCopy`). */
			mcpConfigId: string;
	  }
	| {
			action: "adopt-pat";
			targetRowId: string | null;
			mcpConfigId: string;
			origin: string;
			/** The connection generation the plan was made against. */
			expectedGeneration: number;
	  };

export type GitLabAdoptionResult = {
	plan: GitLabAdoptionPlan;
	applied: boolean;
	integrationId?: string;
};

function officialCanBeAdopted(official: LegacyOfficialCopy): boolean {
	return Boolean(
		official.encryptedAccessToken &&
			official.oauthClientId &&
			// A copy whose config points at a refused address is not adopted:
			// its token would be sent there.
			mcpRowOrigin(official) !== null,
	);
}

/** Byte-order comparison of ids (the migration's `COLLATE "C"` order). */
function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The `gitlab-official` copy to adopt, chosen deterministically among those
 * that can be (a token copy, its own registration, an allowed address): the
 * most recently updated, then the lowest id. `also` narrows the candidates
 * further (the reconnected-later case).
 */
function adoptableOfficialCopy(
	copies: readonly LegacyOfficialCopy[],
	also: (copy: LegacyOfficialCopy) => boolean = () => true,
): LegacyOfficialCopy | null {
	const candidates = copies
		.filter((copy) => officialCanBeAdopted(copy) && also(copy))
		.sort(
			(a, b) =>
				toMs(b.updatedAt) - toMs(a.updatedAt) || compareIds(a.id, b.id),
		);
	return candidates[0] ?? null;
}

/**
 * The GitLab instance an API key saved on a GitLab MCP config belongs to. A
 * `gitlab-official` config names its instance (`mcpRowOrigin`). A `gitlab`
 * config names one only through its own `baseUrl`: that server's default URL
 * is Fabric's former in-process shim, not a GitLab instance, so without a
 * `baseUrl` the key is a gitlab.com token — the same default a PAT entered
 * with no address gets. Null when the address named is refused.
 */
function apiKeyCopyOrigin(copy: LegacyApiKeyCopy): string | null {
	if (copy.mcpServer?.key === "gitlab-official") {
		return mcpRowOrigin(copy);
	}
	if (!copy.baseUrl?.trim()) {
		return GITLAB_DEFAULT_ORIGIN;
	}
	const checked = parseGitLabOrigin(copy.baseUrl);
	return checked.ok ? checked.origin : null;
}

/**
 * The API key copy to adopt, if any, among ALL the person's copies: a
 * readable key on a config whose instance is allowed, preferring
 * `gitlab-official`, then the most recently updated, then the lowest id.
 */
function adoptableApiKeyCopy(
	copies: readonly LegacyApiKeyCopy[],
): { copy: LegacyApiKeyCopy; token: string; origin: string } | null {
	const ordered = [...copies].sort((a, b) => {
		const official =
			Number(b.mcpServer?.key === "gitlab-official") -
			Number(a.mcpServer?.key === "gitlab-official");
		return official !== 0
			? official
			: toMs(b.updatedAt) - toMs(a.updatedAt) || compareIds(a.id, b.id);
	});
	for (const copy of ordered) {
		const token = decryptOrNull(copy.encryptedApiKey)?.trim();
		const origin = apiKeyCopyOrigin(copy);
		if (token && origin) {
			return { copy, token, origin };
		}
	}
	return null;
}

/**
 * Whether an active row's grant is the one on ANY of the person's
 * `gitlab-official` copies that has its own registration (same access token,
 * or same refresh token). Every copy is checked: a decoy without a
 * registration, or with another grant, must not hide the one that matches.
 */
function sharesGrantWithOfficial(
	view: { accessToken: string | null; refreshToken: string | null },
	officialCopies: readonly LegacyOfficialCopy[],
): boolean {
	return officialCopies.some((official) => {
		if (!official.oauthClientId) {
			return false;
		}
		const officialAccess = decryptOrNull(official.encryptedAccessToken);
		const officialRefresh = decryptOrNull(official.encryptedRefreshToken);
		return (
			(officialAccess !== null && officialAccess === view.accessToken) ||
			(officialRefresh !== null &&
				view.refreshToken !== null &&
				officialRefresh === view.refreshToken)
		);
	});
}

/**
 * Decide, from stored evidence only, what adoption should do. Pure: no I/O,
 * no exchange.
 */
export function planGitLabAdoption(
	snapshot: GitLabAdoptionSnapshot,
): GitLabAdoptionPlan {
	const canonical = selectCanonicalConnection(snapshot.rows);
	const view = canonical ? viewConnection(canonical) : null;

	// No usable row the person kept: adopt a copy into it, the DCR copy first
	// (production's case), else an API key.
	const nothingToKeep =
		!view || (!view.disconnected && !view.unreadable && !view.accessToken);
	if (nothingToKeep) {
		const official = adoptableOfficialCopy(snapshot.officialCopies);
		if (official) {
			return {
				action: "adopt-mcp",
				targetRowId: view?.row.id ?? null,
				mcpConfigId: official.id,
			};
		}
		const apiKey = adoptableApiKeyCopy(snapshot.apiKeyCopies);
		if (apiKey) {
			return {
				action: "adopt-pat",
				targetRowId: view?.row.id ?? null,
				mcpConfigId: apiKey.copy.id,
				origin: apiKey.origin,
				expectedGeneration: view?.generation ?? 0,
			};
		}
		return view
			? { action: "none", reason: "holds no token and no MCP copy" }
			: { action: "none", reason: "no connection and no MCP copy" };
	}
	if (view && !view.disconnected && !view.unreadable && !view.row.isActive) {
		if (!adoptableOfficialCopy(snapshot.officialCopies)) {
			return { action: "none", reason: "inactive and no MCP copy" };
		}
		// Inactive WITH a token: a legacy disconnect left it there. Adopt only
		// on evidence of a later reconnect from the MCP Servers page — a
		// different token written to an official row after the deactivation
		// (any of the person's official rows; the same order picks one).
		const reconnected = adoptableOfficialCopy(
			snapshot.officialCopies,
			(copy) => {
				const token = decryptOrNull(copy.encryptedAccessToken);
				return (
					token !== null &&
					token !== view.accessToken &&
					toMs(copy.updatedAt) > toMs(view.row.updatedAt)
				);
			},
		);
		return reconnected
			? {
					action: "adopt-mcp",
					targetRowId: view.row.id,
					mcpConfigId: reconnected.id,
				}
			: {
					action: "none",
					reason: "inactive; respecting the earlier disconnect",
				};
	}
	// Disconnected, unreadable, or an active row with a token: the connection
	// service's own classification — except that a grant the row shares with
	// the `gitlab-official` copy's registration is ambiguous (that
	// registration may have minted it, or the app flow may have), which the
	// service can no longer see once the copies are gone. Checked where the
	// pre-migration planner checked it: after a refused instance, a PAT-shaped
	// credential and a grant shared with a repository link have been decided,
	// and before a bare token is called a PAT or a refreshable grant the
	// app's.
	const base = planGitLabClassification(snapshot);
	const undecided =
		base.action === "classify" ||
		(base.action === "reconnect-required" &&
			base.reason === "issuer-unknown");
	if (
		undecided &&
		view &&
		!isPatShape(view.credential) &&
		sharesGrantWithOfficial(view, snapshot.officialCopies)
	) {
		return {
			action: "reconnect-required",
			rowId: view.row.id,
			reason: "shared-with-mcp-registration",
		};
	}
	return base;
}

/**
 * Why an adoption outcome counts as a FAILURE for the backfill, or null when
 * it is settled. The backfill exits non-zero on any failure, so it is
 * resolved before the migration nulls the copies:
 *   - the connection row's stored credential could not be decrypted: an
 *     issuer-less row stays unclassified and its shared-grant evidence is
 *     then destroyed (and the token-encryption key may be the wrong one);
 *   - (real run) a plan that should have written did not: the rows moved
 *     under it, and a rerun settles it.
 * A row awaiting reconnect, disconnected by the person, or already carrying
 * an issuer is settled.
 */
export function adoptionFailureReason(
	result: GitLabAdoptionResult,
	options: { dryRun: boolean },
): string | null {
	const { plan } = result;
	if (
		plan.action === "none" &&
		plan.reason === "stored credential unreadable"
	) {
		return "stored credential unreadable (check the token-encryption key)";
	}
	if (!options.dryRun && plan.action !== "none" && !result.applied) {
		return `${plan.action} was planned but not written; rerun`;
	}
	return null;
}

async function findOfficialCopies(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<LegacyOfficialCopy[]> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	return (await reader.mCPConfig.findMany({
		where: { ...tenantFilter, mcpServer: { key: "gitlab-official" } },
		select: {
			id: true,
			baseUrl: true,
			oauthClientId: true,
			encryptedAccessToken: true,
			encryptedRefreshToken: true,
			tokenExpiresAt: true,
			needsReauth: true,
			updatedAt: true,
			mcpServer: { select: { key: true, defaultUrl: true } },
		},
	} as never)) as LegacyOfficialCopy[];
}

async function findApiKeyCopies(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<LegacyApiKeyCopy[]> {
	const tenantFilter = tenant.organizationId
		? { organizationId: tenant.organizationId, userId: tenant.userId }
		: { organizationId: null, userId: tenant.userId };
	const rows = (await reader.mCPConfig.findMany({
		where: {
			...tenantFilter,
			mcpServer: { key: { in: ["gitlab", "gitlab-official"] } },
		},
		select: {
			id: true,
			baseUrl: true,
			encryptedApiKey: true,
			updatedAt: true,
			mcpServer: { select: { key: true, defaultUrl: true } },
		},
	} as never)) as LegacyApiKeyCopy[];
	return rows.filter((row) => Boolean(row.encryptedApiKey));
}

async function loadSnapshot(
	reader: GitLabConnectionDb,
	tenant: GitLabTenant,
): Promise<GitLabAdoptionSnapshot> {
	const [classification, officialCopies, apiKeyCopies] = await Promise.all([
		loadGitLabClassificationSnapshot(reader, tenant),
		findOfficialCopies(reader, tenant),
		findApiKeyCopies(reader, tenant),
	]);
	return { ...classification, officialCopies, apiKeyCopies };
}

/**
 * Bring a legacy connection under the connection service, idempotently. The
 * plan is decided twice: once without the lock (so a person with nothing to
 * adopt never takes it) and again under it, where it is applied. An API key
 * is connected through `connectGitLab` instead, against the generation the
 * plan saw: a connect or disconnect that lands in between moves it, and the
 * write is then dropped.
 */
export async function adoptGitLabConnection(
	tenant: GitLabTenant,
	overrides?: Partial<GitLabConnectionDeps>,
	options: { dryRun?: boolean } = {},
): Promise<GitLabAdoptionResult> {
	const deps = await resolveGitLabConnectionDeps(overrides);
	const prePlan = planGitLabAdoption(await loadSnapshot(deps.db, tenant));
	if (prePlan.action === "none" || options.dryRun) {
		return { plan: prePlan, applied: false };
	}
	if (prePlan.action === "adopt-pat") {
		const snapshot = await loadSnapshot(deps.db, tenant);
		const copy = adoptableApiKeyCopy(snapshot.apiKeyCopies);
		if (!copy || copy.copy.id !== prePlan.mcpConfigId) {
			return { plan: prePlan, applied: false };
		}
		const written = await connectGitLab(
			tenant,
			{
				accessToken: copy.token,
				refreshToken: null,
				expiresAt: null,
				scopes: [],
				issuer: { kind: "pat", origin: copy.origin },
				// Moved, not just entered: keep any reconnect state the row has.
				freshGrant: false,
				expectedGeneration: prePlan.expectedGeneration,
				settingsPatch: {
					adoptedFromMcpConfigId: copy.copy.id,
					adoptedAt: new Date(deps.now()).toISOString(),
				},
			},
			overrides,
		);
		return written.written
			? {
					plan: prePlan,
					applied: true,
					integrationId: written.integrationId,
				}
			: { plan: prePlan, applied: false };
	}
	const preRow = selectCanonicalConnection(await readRows(deps.db, tenant));
	return deps.withLock(lockKeys(tenant, preRow?.id), async (tx) => {
		const snapshot = await loadSnapshot(tx, tenant);
		const plan = planGitLabAdoption(snapshot);
		if (plan.action === "none" || plan.action === "adopt-pat") {
			// An API key is only ever adopted through `connectGitLab`, above;
			// a plan that turned into one under the lock is left for a rerun.
			return { plan, applied: false };
		}
		if (plan.action !== "adopt-mcp") {
			const written = await applyGitLabClassification(tx, snapshot, plan);
			return written
				? { plan, applied: true, integrationId: written }
				: { plan, applied: false };
		}
		// The copy the plan named, re-read under the lock.
		const official =
			snapshot.officialCopies.find(
				(copy) => copy.id === plan.mcpConfigId,
			) ?? null;
		const access = decryptOrNull(official?.encryptedAccessToken);
		const officialOrigin = official ? mcpRowOrigin(official) : null;
		if (!official?.oauthClientId || !access || !officialOrigin) {
			return { plan, applied: false };
		}
		const refresh = decryptOrNull(official.encryptedRefreshToken);
		const now = deps.now();
		const expiry = official.tokenExpiresAt
			? official.tokenExpiresAt.getTime()
			: null;
		const target = plan.targetRowId
			? (snapshot.rows.find((each) => each.id === plan.targetRowId) ??
				null)
			: null;
		const targetView = target ? viewConnection(target) : null;
		const generation = (targetView?.generation ?? 0) + 1;
		const credential: StoredGitLabCredential = {
			access_token: access,
			refresh_token: refresh,
			token_type: "bearer",
			expires_in:
				expiry !== null
					? Math.max(0, Math.round((expiry - now) / 1000))
					: undefined,
			token_obtained_at: new Date(now).toISOString(),
			issuer: {
				kind: "mcp-dcr",
				mcpConfigId: official.id,
				serverKey: "gitlab-official",
				clientId: official.oauthClientId,
				origin: officialOrigin,
			},
			connectionGeneration: generation,
		};
		const settings: Record<string, unknown> = {
			...(targetView?.settings ?? {}),
			tokenExpiresAt:
				expiry !== null ? new Date(expiry).toISOString() : null,
			hasRefreshToken: Boolean(refresh),
			needsReauth: official.needsReauth,
			adoptedFromMcpConfigId: official.id,
			adoptedAt: new Date(now).toISOString(),
		};
		delete settings.connectionState;
		delete settings.disconnectedAt;
		if (target) {
			await tx.workflowIntegration.update({
				where: { id: target.id },
				data: {
					credentials: encryptCredential(credential),
					settings,
					isActive: true,
				},
			} as never);
			return { plan, applied: true, integrationId: target.id };
		}
		const created = (await tx.workflowIntegration.create({
			data: {
				userId: tenant.userId,
				organizationId: tenant.organizationId,
				provider: "GITLAB",
				name: "GitLab",
				credentials: encryptCredential(credential),
				settings,
				isActive: true,
			},
			select: { id: true },
		} as never)) as { id: string };
		return { plan, applied: true, integrationId: created.id };
	});
}
