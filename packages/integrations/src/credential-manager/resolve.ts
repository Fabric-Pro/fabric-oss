/**
 * The one way to turn a credential id into something that authenticates a
 * request.
 *
 * Every call checks, in order: the row exists in the caller's organization,
 * the actor may use it, it satisfies the consumer's requirement, and then
 * produces a token — minted for an app installation, refreshed under the
 * per-credential lock when a stored grant is near expiry, or read as stored.
 * Temporal activities call it too, with a `system` actor carrying the
 * consumer's organization, so a background read fails closed exactly where a
 * request would.
 */

import {
	type CredentialActor,
	type CredentialMetadata,
	type CredentialSecret,
	canUseCredential,
	getCredentialMetadata,
	markCredentialStatusIfGeneration,
	readCredentialSecret,
	replaceCredentialSecretIfGeneration,
	touchCredentialUsed,
} from "@repo/database";
import { withRefreshLock } from "@repo/database/prisma/queries/lib/refresh-lock";
import { credentialLockKey } from "@repo/database/prisma/queries/lib/refresh-lock-key";
import {
	type CredentialProviderName,
	type CredentialRequirement,
	checkCredentialRequirement,
	type RequirementFailure,
} from "./requirement";

/** Refresh a stored grant this long before it expires. */
export const CREDENTIAL_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type RefreshOutcome =
	| {
			ok: true;
			secret: CredentialSecret;
			expiresAt: Date | null;
			scopes?: string[];
	  }
	/** The provider rejected the grant itself; only a reconnect recovers. */
	| { ok: false; reason: "rejected" }
	/** Network or platform fault; the stored token may still work. */
	| { ok: false; reason: "unavailable" };

export type CredentialAdapter = {
	provider: CredentialProviderName;
	/** Exchange the stored refresh token. Must use `secret.issuer`'s client. */
	refresh?: (input: {
		credential: CredentialMetadata;
		secret: CredentialSecret;
	}) => Promise<RefreshOutcome>;
	/** Mint a short-lived token for an `APP_INSTALLATION` row. */
	mintInstallationToken?: (input: {
		credential: CredentialMetadata;
		requirement: CredentialRequirement;
	}) => Promise<{ token: string; expiresAt: Date } | null>;
};

const adapters = new Map<CredentialProviderName, CredentialAdapter>();

export function registerCredentialAdapter(adapter: CredentialAdapter): void {
	adapters.set(adapter.provider, adapter);
}

/** Test seam. */
export function __resetCredentialAdaptersForTest(): void {
	adapters.clear();
}

export type ResolveActor =
	| ({ type: "user" } & CredentialActor)
	/** A background job acting for a consumer that already bound the row. */
	| { type: "system"; organizationId: string };

export type ResolvedCredential = {
	credential: CredentialMetadata;
	token: string;
	/** Set for BASIC credentials (e.g. Jira Cloud email + API token). */
	username?: string;
	expiresAt: Date | null;
};

export type ResolveFailure =
	| { code: "not-found" }
	| { code: "forbidden" }
	| { code: "requirement"; failures: RequirementFailure[] }
	| { code: "app-unavailable" }
	| { code: "no-secret" }
	| { code: "needs-reauth" };

export type ResolveResult =
	| { ok: true; value: ResolvedCredential }
	| { ok: false; failure: ResolveFailure };

function tokenFromSecret(secret: CredentialSecret): string | null {
	const token = secret.accessToken ?? secret.token;
	return typeof token === "string" && token.length > 0 ? token : null;
}

function isNearExpiry(expiresAt: Date | null, now: number): boolean {
	return (
		expiresAt !== null &&
		expiresAt.getTime() - now <= CREDENTIAL_REFRESH_SKEW_MS
	);
}

export async function resolveCredential(input: {
	credentialId: string;
	actor: ResolveActor;
	requirement: CredentialRequirement;
	now?: () => number;
}): Promise<ResolveResult> {
	const now = input.now ?? Date.now;
	const { organizationId } = input.actor;

	const credential = await getCredentialMetadata({
		id: input.credentialId,
		organizationId,
	});
	if (!credential) {
		return { ok: false, failure: { code: "not-found" } };
	}
	if (input.actor.type === "user") {
		if (!canUseCredential(credential, input.actor)) {
			return { ok: false, failure: { code: "forbidden" } };
		}
	} else if (credential.status === "REVOKED") {
		return { ok: false, failure: { code: "forbidden" } };
	}

	const failures = checkCredentialRequirement(credential, input.requirement);
	if (failures.length > 0) {
		return { ok: false, failure: { code: "requirement", failures } };
	}

	const adapter = adapters.get(credential.provider);

	if (credential.kind === "APP_INSTALLATION") {
		const minted = await adapter?.mintInstallationToken?.({
			credential,
			requirement: input.requirement,
		});
		if (!minted) {
			return { ok: false, failure: { code: "app-unavailable" } };
		}
		await touchCredentialUsed({ id: credential.id, organizationId });
		return {
			ok: true,
			value: {
				credential,
				token: minted.token,
				expiresAt: minted.expiresAt,
			},
		};
	}

	const stored = await readCredentialSecret({
		id: credential.id,
		organizationId,
	});
	if (!stored?.secret) {
		return { ok: false, failure: { code: "no-secret" } };
	}

	let { secret, credential: current } = stored;
	if (
		isNearExpiry(current.expiresAt, now()) &&
		typeof secret.refreshToken === "string" &&
		adapter?.refresh
	) {
		const refreshed = await refreshUnderLock({
			credential: current,
			adapter,
			now,
		});
		if (refreshed === "needs-reauth") {
			return { ok: false, failure: { code: "needs-reauth" } };
		}
		if (refreshed) {
			secret = refreshed.secret;
			current = refreshed.credential;
		}
	}

	const token = tokenFromSecret(secret);
	if (!token) {
		return { ok: false, failure: { code: "no-secret" } };
	}
	await touchCredentialUsed({ id: current.id, organizationId });
	return {
		ok: true,
		value: {
			credential: current,
			token,
			username:
				typeof secret.username === "string"
					? secret.username
					: undefined,
			expiresAt: current.expiresAt,
		},
	};
}

/**
 * The only refresh exchange for a credential. Serialised per row across
 * processes; the row is re-read inside the lock so a caller that queued
 * behind a winner reuses the winner's token instead of spending the
 * (single-use, on GitHub) refresh token again. Results carry the generation
 * they started from and are dropped if a reconnect moved it.
 *
 * Returns the fresh secret, `null` to keep using the stored one (provider
 * unavailable, or someone else's reconnect won), or `"needs-reauth"`.
 */
async function refreshUnderLock(input: {
	credential: CredentialMetadata;
	adapter: CredentialAdapter;
	now: () => number;
}): Promise<
	| { credential: CredentialMetadata; secret: CredentialSecret }
	| null
	| "needs-reauth"
> {
	const { organizationId, id } = input.credential;
	return withRefreshLock(credentialLockKey(id), async (tx) => {
		// Everything under the lock goes through `tx`: a write on the outer
		// client would check out a second pooled connection while holding it.
		const latest = await readCredentialSecret({ id, organizationId }, tx);
		if (!latest?.secret || latest.credential.status === "REVOKED") {
			return null;
		}
		if (!isNearExpiry(latest.credential.expiresAt, input.now())) {
			return { credential: latest.credential, secret: latest.secret };
		}
		const outcome = await input.adapter.refresh?.({
			credential: latest.credential,
			secret: latest.secret,
		});
		if (!outcome) {
			return null;
		}
		if (!outcome.ok) {
			if (outcome.reason === "rejected") {
				await markCredentialStatusIfGeneration(
					{
						id,
						organizationId,
						generation: latest.credential.generation,
						status: "NEEDS_REAUTH",
						lastError: "refresh-rejected",
						refreshRejected: true,
					},
					tx,
				);
				return "needs-reauth";
			}
			return null;
		}
		const written = await replaceCredentialSecretIfGeneration(
			{
				id,
				organizationId,
				generation: latest.credential.generation,
				secret: outcome.secret,
				expiresAt: outcome.expiresAt,
				scopes: outcome.scopes,
			},
			tx,
		);
		if (!written) {
			return null;
		}
		return {
			credential: {
				...latest.credential,
				expiresAt: outcome.expiresAt,
				scopes: outcome.scopes ?? latest.credential.scopes,
				status: "ACTIVE",
			},
			secret: outcome.secret,
		};
	});
}
