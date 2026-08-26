import { logger } from "@repo/logs";
import { getDatabricksConfig } from "./config";

export interface DatabricksTokenProvider {
	/**
	 * Resolve a bearer token. When `signal` is provided and fires, the CALLER
	 * stops waiting (rejects with the abort reason) — but a shared in-flight
	 * token fetch is NOT cancelled, so concurrent callers coalescing on the
	 * same fetch are unaffected and the cache stays warm.
	 */
	getToken(signal?: AbortSignal): Promise<string>;
	invalidate(): void;
}

function abortReason(signal: AbortSignal): unknown {
	return (
		signal.reason ??
		new DOMException("This operation was aborted", "AbortError")
	);
}

/**
 * Wait on `promise`, but stop waiting (reject) when `signal` fires. The
 * underlying promise is left running — used to make waits on SHARED
 * single-flight promises abortable without poisoning them for other waiters.
 */
function waitAbortable<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

// How many ms before expiry to consider the token stale and proactively refresh.
const REFRESH_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

/** Token lifetime assumed when the response omits `expires_in`. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * Ceiling on a cached token's assumed lifetime (24h). Databricks tokens are
 * far shorter-lived than this, so the cap never binds in practice; it exists so
 * an absurd `expires_in` cannot push the expiry beyond the range where
 * arithmetic stays finite, and so a wildly optimistic value cannot keep a
 * revoked token cached indefinitely.
 */
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Hard ceiling on a single token exchange.
 *
 * Production callers pass no signal, so without this a stalled request would
 * leave the single-flight promise pending forever — and because every later
 * caller coalesces onto that promise, one hung exchange would wedge all token
 * acquisition for the process lifetime rather than failing and retrying.
 */
const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Thrown when the OAuth token endpoint rejects a client-credentials exchange.
 *
 * Carries the HTTP status as a typed field so callers can branch on it without
 * parsing the message. Deliberately carries NO response body — see the throw
 * site for why.
 */
export class DatabricksTokenFetchError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Databricks OAuth token fetch failed with status ${status}`);
		this.name = "DatabricksTokenFetchError";
		this.status = status;
	}
}

/**
 * Thrown when the token endpoint answers successfully but the payload is not a
 * usable token response — unparseable JSON, or JSON without `access_token`.
 *
 * Messages are STATIC by construction. A 200 body is no more trustworthy than
 * an error body, and the native `JSON.parse` failure quotes the input, so
 * neither the body nor the parser's message may be carried here: the
 * vector-search verification path returns `error.message` straight to its
 * caller.
 */
export class DatabricksTokenProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DatabricksTokenProtocolError";
	}
}

/**
 * Thrown when a token exchange exceeds the intrinsic request ceiling. Carries
 * the timeout for diagnostics and, like every error on this path, no response
 * content.
 */
export class DatabricksTokenTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Databricks OAuth token fetch timed out after ${timeoutMs}ms`);
		this.name = "DatabricksTokenTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

// ---------------------------------------------------------------------------
// PAT (Personal Access Token) provider
// ---------------------------------------------------------------------------

function createPatProvider(token: string): DatabricksTokenProvider {
	return {
		getToken(): Promise<string> {
			return Promise.resolve(token);
		},
		invalidate(): void {
			// no-op: static token cannot be refreshed
		},
	};
}

// ---------------------------------------------------------------------------
// OAuth M2M provider
// ---------------------------------------------------------------------------

interface TokenCache {
	accessToken: string;
	expiresAtMs: number;
}

export function createOAuthM2MProvider(
	host: string,
	clientId: string,
	clientSecret: string,
	fetchImpl: typeof fetch = globalThis.fetch,
): DatabricksTokenProvider {
	let cache: TokenCache | null = null;
	let inflight: Promise<string> | null = null;

	function isStale(): boolean {
		if (!cache) {
			return true;
		}
		return Date.now() >= cache.expiresAtMs - REFRESH_MARGIN_MS;
	}

	async function fetchToken(): Promise<string> {
		const tokenUrl = `${host}/oidc/v1/token`;
		const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
			"base64",
		);
		const body = new URLSearchParams({
			grant_type: "client_credentials",
			scope: "all-apis",
		});

		// The intrinsic timeout is deliberately NOT combined with the caller's
		// signal. This fetch is SHARED by every coalesced caller (see
		// `waitAbortable`), so honouring one caller's abort here would cancel
		// the exchange for all of them. Caller signals abort only that caller's
		// wait; this ceiling is what bounds the shared request itself.
		let response: Response;
		try {
			response = await fetchImpl(tokenUrl, {
				method: "POST",
				headers: {
					Authorization: `Basic ${credentials}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
				body: body.toString(),
				signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			// A timeout and a transport failure are both terminal for this
			// attempt. Rejecting clears the single-flight slot (see the
			// `.finally` on `inflight`), so the next caller starts a fresh
			// exchange instead of joining a dead promise.
			if (
				error instanceof Error &&
				(error.name === "TimeoutError" || error.name === "AbortError")
			) {
				logger.warn(
					`[databricks] OAuth token fetch timed out after ${TOKEN_REQUEST_TIMEOUT_MS}ms`,
				);
				throw new DatabricksTokenTimeoutError(TOKEN_REQUEST_TIMEOUT_MS);
			}
			throw error;
		}

		if (!response.ok) {
			// The response body is NEVER read on this path, let alone logged.
			// This request carries `Authorization: Basic
			// base64(clientId:clientSecret)`, and a workspace edge, debugging
			// proxy or upstream error handler can echo request headers back in
			// its diagnostic body — which would put the service principal's
			// credentials into centralized logs. Even a truncated excerpt is
			// enough to leak them, so only the status is recorded, and the
			// thrown error carries the status and nothing else.
			logger.warn(
				`[databricks] OAuth token fetch failed with status ${response.status}`,
			);
			throw new DatabricksTokenFetchError(response.status);
		}

		// A 200 with an unparseable body is still an untrusted body. `json()`'s
		// native SyntaxError quotes a snippet of the input — e.g. `Unexpected
		// token 's', "secret-mar"... is not valid JSON` — and that message is
		// returned verbatim to callers by the vector-search verification path,
		// so it must never escape. Fail with a static, body-free message.
		let json: unknown;
		try {
			json = await response.json();
		} catch {
			logger.warn(
				"[databricks] OAuth token response was not valid JSON despite a success status",
			);
			throw new DatabricksTokenProtocolError(
				"Databricks OAuth response was not valid JSON",
			);
		}

		// VALIDATE, don't cast. A cast would let a malformed payload through to
		// the cache: a non-numeric `expires_in` makes `expiresAtMs` NaN, every
		// NaN comparison in `isStale` is false, and the token is then treated as
		// permanently fresh — so a bad response would pin a stale token for the
		// process lifetime instead of failing loudly.
		const payload = (json ?? {}) as {
			access_token?: unknown;
			expires_in?: unknown;
		};

		if (
			typeof payload.access_token !== "string" ||
			payload.access_token.length === 0
		) {
			throw new DatabricksTokenProtocolError(
				"Databricks OAuth response did not include access_token",
			);
		}

		let expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS;
		if (payload.expires_in !== undefined && payload.expires_in !== null) {
			if (
				typeof payload.expires_in !== "number" ||
				!Number.isFinite(payload.expires_in) ||
				payload.expires_in <= 0
			) {
				throw new DatabricksTokenProtocolError(
					"Databricks OAuth response had an invalid expires_in",
				);
			}
			// CLAMP rather than reject: an implausibly long lifetime is odd but
			// not a protocol violation, and capping it only shortens our cache
			// freshness. It also keeps `* 1000` from overflowing — a finite but
			// absurd value like 1e308 passes the checks above yet becomes
			// Infinity in milliseconds, which makes every `isStale` comparison
			// false and pins the token for the process lifetime.
			expiresInSeconds = Math.min(
				payload.expires_in,
				MAX_TOKEN_LIFETIME_SECONDS,
			);
		}

		// Validate the COMPUTED values, not just the input: this is the pair
		// `isStale` actually compares, so a non-finite result here is what would
		// silently disable refresh.
		const expiresInMs = expiresInSeconds * 1000;
		const expiresAtMs = Date.now() + expiresInMs;
		if (!Number.isFinite(expiresInMs) || !Number.isFinite(expiresAtMs)) {
			throw new DatabricksTokenProtocolError(
				"Databricks OAuth response had an invalid expires_in",
			);
		}

		cache = {
			accessToken: payload.access_token,
			expiresAtMs,
		};

		return cache.accessToken;
	}

	return {
		async getToken(signal?: AbortSignal): Promise<string> {
			const current = cache;
			if (current && !isStale()) {
				return current.accessToken;
			}

			// Single-flight: share the in-flight promise across concurrent callers.
			// The caller's signal only aborts THEIR wait — the shared fetch is
			// never cancelled, so other waiters and the cache are unaffected.
			if (inflight) {
				return waitAbortable(inflight, signal);
			}

			inflight = fetchToken().finally(() => {
				inflight = null;
			});

			return waitAbortable(inflight, signal);
		},

		invalidate(): void {
			cache = null;
			// Note: we intentionally do NOT cancel the in-flight promise if one
			// exists — callers waiting on it will still get a fresh token after
			// the request completes. Clearing the cache ensures the next call
			// after inflight resolves will refetch if needed.
		},
	};
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export function createDatabricksTokenProvider(opts?: {
	env?: NodeJS.ProcessEnv;
	fetchImpl?: typeof fetch;
}): DatabricksTokenProvider {
	const env = opts?.env ?? process.env;
	const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;

	const config = getDatabricksConfig(env);

	// PAT takes precedence over OAuth M2M.
	if (config?.token) {
		return createPatProvider(config.token);
	}

	if (!config?.clientId || !config.clientSecret) {
		throw new Error(
			"Databricks is not configured. Set DATABRICKS_HOST and either DATABRICKS_TOKEN or DATABRICKS_CLIENT_ID + DATABRICKS_CLIENT_SECRET.",
		);
	}

	return createOAuthM2MProvider(
		config.host,
		config.clientId,
		config.clientSecret,
		fetchImpl,
	);
}

// ---------------------------------------------------------------------------
// Lazy module-level singleton
// ---------------------------------------------------------------------------

let _singleton: DatabricksTokenProvider | null = null;

/**
 * Returns (and lazily constructs on first call) a module-level singleton
 * token provider using process.env. Does NOT construct anything at module
 * load time.
 */
export function getDatabricksTokenProvider(): DatabricksTokenProvider {
	if (!_singleton) {
		_singleton = createDatabricksTokenProvider({ env: process.env });
	}
	return _singleton;
}
