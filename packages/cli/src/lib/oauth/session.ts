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

import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import {
	getConfigPath,
	getOAuth,
	type OAuthCredentials,
	saveOAuth,
} from "../config.js";
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
	constructor() {
		super("The sign-in has expired. Run: fabric auth login");
		this.name = "OAuthSessionExpiredError";
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isExistsError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "EEXIST"
	);
}

/**
 * Run `work` while holding the profile's refresh lock.
 *
 * `O_EXCL` creation is the lock. A holder that crashed leaves the file behind,
 * so one older than `LOCK_STALE_MS` (by the file's own clock) is removed and the
 * creation retried. `work` never runs without the lock: a waiter that cannot
 * take it within `LOCK_WAIT_MS`, or whose `signal` aborts, gives up instead,
 * because two refreshes of one rotating token end the whole sign-in.
 */
export async function withRefreshLock<T>(
	work: () => Promise<T>,
	options: { lockPath?: string; signal?: AbortSignal; waitMs?: number } = {},
): Promise<T> {
	const lockPath = options.lockPath ?? `${getConfigPath()}.refresh.lock`;
	const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
	let descriptor: number | undefined;

	while (descriptor === undefined) {
		options.signal?.throwIfAborted();
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			writeSync(descriptor, String(process.pid));
		} catch (error) {
			if (!isExistsError(error)) {
				throw error;
			}
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch {
				// Released between the failed create and the stat: retry now.
				continue;
			}
			if (Date.now() >= deadline) {
				throw new OAuthRefreshBusyError();
			}
			await sleep(LOCK_POLL_MS);
		}
	}

	try {
		return await work();
	} finally {
		closeSync(descriptor);
		try {
			unlinkSync(lockPath);
		} catch {
			// Already removed as stale by another process.
		}
	}
}

interface RefreshDeps {
	fetch: FetchLike;
	now: () => number;
	lockPath?: string;
}

function defaults(deps: Partial<RefreshDeps>): RefreshDeps {
	return {
		fetch: deps.fetch ?? ((input, init) => fetch(input, init)),
		now: deps.now ?? Date.now,
		lockPath: deps.lockPath,
	};
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
			const current = getOAuth();
			if (!current) {
				throw new OAuthSessionExpiredError();
			}
			if (!needsRefresh(current)) {
				return current.accessToken;
			}
			if (!current.refreshToken) {
				throw new OAuthSessionExpiredError();
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
				throw new OAuthSessionExpiredError();
			}

			const tokens = parseTokenResponse(
				await response.json().catch(() => null),
				deps.now(),
			);
			saveOAuth({
				...current,
				accessToken: tokens.accessToken,
				// Rotation: the old refresh token is spent. A response without a
				// new one leaves the profile with none rather than a dead one.
				refreshToken: tokens.refreshToken,
				expiresAt: tokens.expiresAt,
			});
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

	return async (input, init) => {
		const stored = getOAuth();
		if (!stored) {
			throw new OAuthSessionExpiredError();
		}
		const signal = init?.signal ?? undefined;

		let token = stored.accessToken;
		if (stored.expiresAt - deps.now() <= REFRESH_WINDOW_MS) {
			token = await refreshAccessToken(
				(current) =>
					current.expiresAt - deps.now() <= REFRESH_WINDOW_MS,
				deps,
				signal,
			);
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
