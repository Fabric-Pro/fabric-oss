import type { DatabricksTokenProvider } from "./auth";
import { getDatabricksTokenProvider } from "./auth";
import { getDatabricksHost } from "./config";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class DatabricksApiError extends Error {
	constructor(
		readonly status: number,
		readonly body: string,
		message?: string,
	) {
		super(message ?? `Databricks API error ${status}: ${body}`);
		this.name = "DatabricksApiError";
	}
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

export interface DatabricksApiClientOptions {
	/** Workspace origin (no path, query or credentials). Defaults to getDatabricksHost(). */
	host?: string;
	/** Token provider. Defaults to getDatabricksTokenProvider(). */
	tokenProvider?: DatabricksTokenProvider;
	/** Custom fetch implementation (useful in tests). */
	fetchImpl?: typeof fetch;
	/** Maximum number of 429/503 retries for GET/HEAD only. Defaults to 3. */
	maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspaceRequestUrl(host: string, path: string): string {
	// WHATWG URL parsing accepts network-path references and normalizes
	// backslashes/control characters. Refuse those before attaching any token.
	if (
		typeof path !== "string" ||
		!path.startsWith("/") ||
		path.startsWith("//") ||
		/[\p{Cc}\\]/u.test(path)
	) {
		throw new TypeError(
			"Databricks API paths must start with a single slash and contain no backslashes or control characters.",
		);
	}
	let workspace: URL;
	try {
		workspace = new URL(host);
	} catch {
		throw new TypeError("Databricks API host must be a workspace origin.");
	}
	if (
		!/^https?:$/.test(workspace.protocol) ||
		host.trim() !== host ||
		/[\p{Cc}\\]/u.test(host) ||
		workspace.username ||
		workspace.password ||
		workspace.pathname !== "/" ||
		workspace.search ||
		workspace.hash
	) {
		throw new TypeError(
			"Databricks API host must be an HTTP(S) workspace origin without credentials.",
		);
	}
	const url = new URL(path, workspace);
	if (url.origin !== workspace.origin || url.username || url.password) {
		throw new TypeError(
			"Databricks API request must remain in its workspace origin.",
		);
	}
	return url.href;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(
				signal.reason ??
					new DOMException(
						"This operation was aborted",
						"AbortError",
					),
			);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(
				signal?.reason ??
					new DOMException(
						"This operation was aborted",
						"AbortError",
					),
			);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class DatabricksApiClient {
	private readonly options: DatabricksApiClientOptions;

	// Lazily resolved at first request so module load has no side effects.
	private _host: string | null = null;
	private _tokenProvider: DatabricksTokenProvider | null = null;
	private _fetchImpl: typeof fetch | null = null;
	private _maxRetries: number | null = null;

	constructor(options?: DatabricksApiClientOptions) {
		this.options = options ?? {};
	}

	// ---------------------------------------------------------------------------
	// Lazy defaults
	// ---------------------------------------------------------------------------

	private get host(): string {
		if (this._host === null) {
			this._host = this.options.host ?? getDatabricksHost();
		}
		return this._host;
	}

	private get tokenProvider(): DatabricksTokenProvider {
		if (!this._tokenProvider) {
			this._tokenProvider =
				this.options.tokenProvider ?? getDatabricksTokenProvider();
		}
		return this._tokenProvider;
	}

	private get fetchImpl(): typeof fetch {
		if (!this._fetchImpl) {
			this._fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
		}
		return this._fetchImpl;
	}

	private get maxRetries(): number {
		if (this._maxRetries === null) {
			this._maxRetries = this.options.maxRetries ?? 3;
		}
		return this._maxRetries;
	}

	// ---------------------------------------------------------------------------
	// Core request logic
	// ---------------------------------------------------------------------------

	/**
	 * Makes an authenticated request and parses the JSON response body.
	 * Returns undefined for 204/empty responses.
	 *
	 * `options.signal` aborts the underlying HTTP request(s) (including
	 * backoff waits), not just the caller's promise — a slow workspace must
	 * not accumulate orphaned in-flight requests after the caller times out.
	 * Only GET/HEAD are retried automatically. Effectful requests require an
	 * operation-specific receipt/idempotency contract before a caller retries.
	 */
	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		options?: { signal?: AbortSignal; retryable?: boolean },
	): Promise<T> {
		const init: RequestInit = {
			method,
			headers: {
				...(body !== undefined
					? { "Content-Type": "application/json" }
					: {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: options?.signal,
		};

		const response = await this._requestWithRetries(path, init, {
			retryable: options?.retryable,
		});

		// 204 or genuinely empty body → return undefined
		if (
			response.status === 204 ||
			response.headers.get("content-length") === "0"
		) {
			await response.body?.cancel().catch(() => undefined);
			return undefined as T;
		}

		const text = await response.text();
		if (!text) {
			return undefined as T;
		}

		return JSON.parse(text) as T;
	}

	/**
	 * Makes an authenticated request and returns the raw Response.
	 * Applies the same method-aware auth/retry semantics as request(),
	 * but does not parse the body. Merges any caller-provided headers.
	 */
	async requestRaw(
		method: string,
		path: string,
		init?: RequestInit,
	): Promise<Response> {
		const mergedInit: RequestInit = {
			...init,
			method,
			headers: new Headers(init?.headers),
		};

		return this._requestWithRetries(path, mergedInit);
	}

	// ---------------------------------------------------------------------------
	// Internal: auth + 401 + 429/503 retry logic
	// ---------------------------------------------------------------------------

	private async _requestWithRetries(
		path: string,
		init: RequestInit,
		options?: { retryable?: boolean },
	): Promise<Response> {
		init.signal?.throwIfAborted();
		const url = workspaceRequestUrl(this.host, path);
		const canRetry =
			options?.retryable ??
			["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
		let authRetried = false;

		// A generic transport cannot prove whether an effectful operation was
		// admitted before an error. Invalidate its token for the next deliberate
		// request, but never silently repeat the operation, including on 401.
		let response = await this._requestWithAuth(url, init);

		if (response.status === 401) {
			this.tokenProvider.invalidate();
			if (canRetry) {
				authRetried = true;
				await response.body?.cancel().catch(() => undefined);
				response = await this._requestWithAuth(url, init);
			}
		}

		// Exponential backoff for safe reads only. Network/body errors remain
		// visible to the caller; no implicit retries of ambiguous outcomes.
		let attempt = 0;
		while (
			canRetry &&
			(response.status === 429 || response.status === 503) &&
			attempt < this.maxRetries
		) {
			const retryAfterHeader = response.headers.get("Retry-After");
			let delayMs: number;

			if (retryAfterHeader !== null) {
				const seconds = Number(retryAfterHeader);
				delayMs = Number.isFinite(seconds)
					? seconds * 1000
					: 250 * 2 ** attempt;
			} else {
				delayMs = 250 * 2 ** attempt;
			}

			await response.body?.cancel().catch(() => undefined);
			await sleep(delayMs, init.signal ?? undefined);
			attempt++;

			response = await this._requestWithAuth(url, init);

			if (response.status === 401) {
				this.tokenProvider.invalidate();
				if (!authRetried) {
					authRetried = true;
					await response.body?.cancel().catch(() => undefined);
					response = await this._requestWithAuth(url, init);
				}
			}
		}

		if (!response.ok && response.status !== 204) {
			let bodyText = "";
			try {
				bodyText = await response.text();
			} catch {
				// best-effort
			}
			throw new DatabricksApiError(response.status, bodyText);
		}

		return response;
	}

	private async _requestWithAuth(
		url: string,
		init: RequestInit,
	): Promise<Response> {
		init.signal?.throwIfAborted();
		const token = await this.tokenProvider.getToken(
			init.signal ?? undefined,
		);
		init.signal?.throwIfAborted();
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);

		return this.fetchImpl(url, {
			...init,
			headers,
			// Follow-up locations are not approved workspace operations. Keep
			// callers from silently changing this through requestRaw options.
			redirect: "error",
		});
	}
}

// ---------------------------------------------------------------------------
// Lazy singleton
// ---------------------------------------------------------------------------

let _singleton: DatabricksApiClient | null = null;

/**
 * Returns (and lazily constructs on first call) a module-level singleton
 * DatabricksApiClient. Does NOT construct anything at module load time.
 */
export function getDatabricksClient(): DatabricksApiClient {
	if (!_singleton) {
		_singleton = new DatabricksApiClient();
	}
	return _singleton;
}
