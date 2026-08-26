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
	/** Base host URL. Defaults to getDatabricksHost(). */
	host?: string;
	/** Token provider. Defaults to getDatabricksTokenProvider(). */
	tokenProvider?: DatabricksTokenProvider;
	/** Custom fetch implementation (useful in tests). */
	fetchImpl?: typeof fetch;
	/** Maximum number of 429/503 retries. Defaults to 3. */
	maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
	 */
	async request<T>(
		method: string,
		path: string,
		body?: unknown,
		options?: { signal?: AbortSignal },
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

		const response = await this._requestWithRetries(path, init);

		// 204 or genuinely empty body → return undefined
		if (
			response.status === 204 ||
			response.headers.get("content-length") === "0"
		) {
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
	 * Applies the same auth + 401-retry-once semantics as request(),
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
			headers: {
				...(init?.headers ?? {}),
			},
		};

		return this._requestWithRetries(path, mergedInit);
	}

	// ---------------------------------------------------------------------------
	// Internal: auth + 401 + 429/503 retry logic
	// ---------------------------------------------------------------------------

	private async _requestWithRetries(
		path: string,
		init: RequestInit,
	): Promise<Response> {
		const url = `${this.host}${path}`;

		// First attempt (with potential 401 retry-once).
		let response = await this._requestWithAuth(url, init);

		if (response.status === 401) {
			// Invalidate cached token and retry exactly once.
			this.tokenProvider.invalidate();
			response = await this._requestWithAuth(url, init);
		}

		// Exponential backoff on 429/503 up to maxRetries.
		let attempt = 0;
		while (
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

			await sleep(delayMs, init.signal ?? undefined);
			attempt++;

			response = await this._requestWithAuth(url, init);

			if (response.status === 401) {
				this.tokenProvider.invalidate();
				response = await this._requestWithAuth(url, init);
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
		const token = await this.tokenProvider.getToken(
			init.signal ?? undefined,
		);
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${token}`);

		return this.fetchImpl(url, {
			...init,
			headers,
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
