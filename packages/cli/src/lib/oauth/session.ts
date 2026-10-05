/**
 * Keeping a browser sign-in alive: refreshing the access token and revoking it.
 *
 * Refresh tokens ROTATE, and the server treats a reused one as theft and ends
 * the whole token family. Two CLI processes that start together — the
 * session-start hook of two checkouts, say — must therefore never both spend
 * the same refresh token. Refreshing takes an exclusive lock file beside the
 * profile, and re-reads the profile after taking it: a process that waited finds
 * the other's fresh tokens and does no refresh of its own.
 */

import {
	getConfigPath,
	getOAuth,
	type OAuthCredentials,
	saveOAuth,
} from "../config.js";
import {
	ExclusiveLockBusyError,
	withExclusiveLock,
} from "../exclusive-lock.js";
import { fabricCommand } from "../launcher.js";
import { type AuthFailure, recordAuthFailure } from "./auth-failure.js";
import {
	type FetchLike,
	parseTokenResponse,
	postTokenRequest,
} from "./flow.js";

/** A token that expires this soon is refreshed before it is used. */
export const REFRESH_WINDOW_MS = 60_000;

/** A lock older than this is taken to belong to a process that died. */
export const LOCK_STALE_MS = 30_000;

const LOCK_POLL_MS = 100;
/**
 * The longest a waiter waits. Past the stale age a dead holder's lock has been
 * removed, so reaching this means the lock keeps being renewed by someone, and
 * refreshing without it is exactly what must not happen.
 */
const LOCK_WAIT_MS = LOCK_STALE_MS + 5_000;

export class OAuthSessionExpiredError extends Error {
	/**
	 * `origin` names the deployment whose sign-in it is, when the caller knows
	 * it, and `projectId` the project when it is a project's.
	 */
	constructor(origin?: string, projectId?: string) {
		super(
			`The sign-in has expired. Run: ${fabricCommand(
				projectId === undefined
					? "auth login"
					: `auth login --project ${projectId}`,
				origin,
			)}`,
		);
		this.name = "OAuthSessionExpiredError";
	}
}

/**
 * A request for one origin was about to carry a sign-in issued by another.
 * Thrown before anything is sent: a bearer token goes only where it was
 * issued.
 */
export class OAuthIssuerMismatchError extends Error {
	constructor(
		readonly requestOrigin: string,
		readonly issuerOrigin: string,
	) {
		super(
			`This sign-in was issued by ${issuerOrigin} and is not sent to ${requestOrigin}.`,
		);
		this.name = "OAuthIssuerMismatchError";
	}
}

export class OAuthRefreshBusyError extends Error {
	constructor() {
		super(
			"Another fabric process is renewing the sign-in and did not finish. Try again.",
		);
		this.name = "OAuthRefreshBusyError";
	}
}

/**
 * Run `work` while holding the profile's refresh lock.
 *
 * The lock is `exclusive-lock.ts`'s: `O_EXCL` creation, with a holder that
 * crashed removed once its file is older than `LOCK_STALE_MS`. `work` never
 * runs without the lock: a waiter that cannot take it within `LOCK_WAIT_MS`,
 * or whose `signal` aborts, gives up instead, because two refreshes of one
 * rotating token end the whole sign-in.
 */
export async function withRefreshLock<T>(
	work: () => Promise<T>,
	options: { lockPath?: string; signal?: AbortSignal; waitMs?: number } = {},
): Promise<T> {
	try {
		return await withExclusiveLock(work, {
			lockPath: options.lockPath ?? `${getConfigPath()}.refresh.lock`,
			staleMs: LOCK_STALE_MS,
			waitMs: options.waitMs ?? LOCK_WAIT_MS,
			pollMs: LOCK_POLL_MS,
			signal: options.signal,
		});
	} catch (error) {
		throw error instanceof ExclusiveLockBusyError
			? new OAuthRefreshBusyError()
			: error;
	}
}

interface RefreshDeps {
	fetch: FetchLike;
	now: () => number;
	lockPath?: string;
	/** The deployment whose profile holds the sign-in; the active one when omitted. */
	origin?: string;
	/** The project the sign-in is for, when it is one project's and not the deployment's. */
	projectId?: string;
}

function defaults(deps: Partial<RefreshDeps>): RefreshDeps {
	return {
		fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
		now: deps.now ?? Date.now,
		lockPath: deps.lockPath,
		origin: deps.origin,
		projectId: deps.projectId,
	};
}

/** The origin a request is for, from whatever `fetch` was given. */
function requestOrigin(input: Parameters<typeof fetch>[0]): string | null {
	try {
		return new URL(
			typeof input === "string" || input instanceof URL
				? input
				: input.url,
		).origin;
	} catch {
		return null;
	}
}

/**
 * The access token to use right now, refreshing it first when `needsRefresh`
 * says the stored one will not do. Safe to call from any number of processes.
 *
 * `needsRefresh` is evaluated against the profile as read AFTER the lock is
 * taken, which is the whole point: it is how a waiter learns the holder
 * already did the work.
 */
export async function refreshAccessToken(
	needsRefresh: (current: OAuthCredentials) => boolean,
	partial: Partial<RefreshDeps> = {},
	signal?: AbortSignal,
): Promise<string> {
	const deps = defaults(partial);

	return withRefreshLock(
		async () => {
			const current = getOAuth(deps.origin, deps.projectId);
			if (!current) {
				throw new OAuthSessionExpiredError(deps.origin, deps.projectId);
			}
			if (!needsRefresh(current)) {
				return current.accessToken;
			}
			if (!current.refreshToken) {
				throw new OAuthSessionExpiredError(deps.origin, deps.projectId);
			}

			const response = await postTokenRequest(
				deps.fetch,
				current.tokenEndpoint,
				{
					grant_type: "refresh_token",
					refresh_token: current.refreshToken,
					client_id: current.clientId,
				},
				signal,
			);
			if (!response.ok) {
				throw new OAuthSessionExpiredError(deps.origin, deps.projectId);
			}

			const tokens = parseTokenResponse(
				await response.json().catch(() => null),
				deps.now(),
			);
			saveOAuth(
				{
					...current,
					accessToken: tokens.accessToken,
					// Rotation: the old refresh token is spent. A response without a
					// new one leaves the profile with none rather than a dead one.
					refreshToken: tokens.refreshToken,
					expiresAt: tokens.expiresAt,
				},
				{
					origin: deps.origin,
					...(deps.projectId === undefined
						? {}
						: { projectId: deps.projectId }),
				},
			);
			return tokens.accessToken;
		},
		{ lockPath: deps.lockPath, signal },
	);
}

/**
 * A `fetch` that signs requests with the profile's access token.
 *
 * Refreshes ahead of expiry (`REFRESH_WINDOW_MS`) and once more on a 401, for a
 * token revoked or rotated since it was read. The retry replays the request, so
 * it is only attempted for a body that can be replayed; the SDK sends JSON
 * strings. The request's own `signal` also bounds the refresh, so a caller's
 * deadline — the session-start hook's, say — covers waiting for the lock.
 */
export function createOAuthFetch(
	partial: Partial<RefreshDeps> = {},
	apiFetch: typeof fetch = (input, init) => fetch(input, init),
): typeof fetch {
	const deps = defaults(partial);

	const send = (
		input: Parameters<typeof fetch>[0],
		init: RequestInit | undefined,
		token: string,
	): Promise<Response> => {
		const headers = new Headers(init?.headers);
		headers.set("Authorization", `Bearer ${token}`);
		return apiFetch(input, { ...init, headers });
	};

	const expired = (origin: string): AuthFailure => ({
		kind: "expired",
		origin,
		...(deps.projectId === undefined ? {} : { project: deps.projectId }),
	});

	return async (input, init) => {
		const target = requestOrigin(input);
		const stored = getOAuth(deps.origin, deps.projectId);
		if (!stored) {
			recordAuthFailure(expired(deps.origin ?? target ?? ""));
			throw new OAuthSessionExpiredError(
				deps.origin ?? target ?? undefined,
				deps.projectId,
			);
		}
		// Before anything is refreshed or sent: a sign-in belongs to the
		// deployment that issued it, and to no other.
		const issuer = requestOrigin(stored.issuer);
		if (target === null || issuer === null || target !== issuer) {
			recordAuthFailure({
				kind: "wrong-deployment",
				origin: target ?? "",
			});
			throw new OAuthIssuerMismatchError(
				target ?? "an unknown origin",
				issuer ?? stored.issuer,
			);
		}
		const signal = init?.signal ?? undefined;

		let token = stored.accessToken;
		if (stored.expiresAt - deps.now() <= REFRESH_WINDOW_MS) {
			try {
				token = await refreshAccessToken(
					(current) =>
						current.expiresAt - deps.now() <= REFRESH_WINDOW_MS,
					deps,
					signal,
				);
			} catch (error) {
				if (error instanceof OAuthSessionExpiredError) {
					recordAuthFailure(expired(target));
				}
				throw error;
			}
		}

		const response = await send(input, init, token);
		if (
			response.status !== 401 ||
			(init?.body !== undefined &&
				init.body !== null &&
				typeof init.body !== "string")
		) {
			return response;
		}

		try {
			const spent = token;
			const renewed = await refreshAccessToken(
				(current) => current.accessToken === spent,
				deps,
				signal,
			);
			return await send(input, init, renewed);
		} catch (error) {
			// The 401 is the truthful answer when the token cannot be renewed.
			if (
				error instanceof OAuthSessionExpiredError ||
				error instanceof OAuthRefreshBusyError
			) {
				if (error instanceof OAuthSessionExpiredError) {
					recordAuthFailure(expired(target));
				}
				return response;
			}
			throw error;
		}
	};
}

/**
 * End the sign-in at the server, best effort. Revoking the refresh token is
 * enough: the server deletes every access token issued under it in the same
 * step, after which a second call naming the access token can only fail (it
 * no longer exists), so it is made only when there is no refresh token or its
 * revocation failed. True when the server confirmed either.
 */
export async function revokeOAuthSession(
	credentials: OAuthCredentials,
	fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<boolean> {
	const endpoint = credentials.revocationEndpoint;
	if (!endpoint) {
		return false;
	}

	const revoke = async (
		token: string,
		hint: "refresh_token" | "access_token",
	): Promise<boolean> => {
		try {
			const response = await postTokenRequest(fetchImpl, endpoint, {
				token,
				token_type_hint: hint,
				client_id: credentials.clientId,
			});
			return response.ok;
		} catch {
			return false;
		}
	};

	if (
		credentials.refreshToken &&
		(await revoke(credentials.refreshToken, "refresh_token"))
	) {
		return true;
	}
	return revoke(credentials.accessToken, "access_token");
}
