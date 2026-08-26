/**
 * FabricHttpClient — low-level fetch wrapper used by all resource classes.
 *
 * Responsibilities:
 *   - Resolve API key + base URL from options or FABRIC_* env vars.
 *   - Inject default org/personal context into request URLs when the caller
 *     hasn't already set them.
 *   - Retry on transient failures (network errors, 408/425/429/5xx) with
 *     capped exponential backoff.
 *   - Enforce a per-request timeout via AbortController.
 *   - Add Idempotency-Key headers to mutating requests so retries are safe.
 *   - Emit telemetry events at every lifecycle stage (no bodies, no key).
 */

import type {
	FabricClientOptions,
	FabricRetryOptions,
	FabricTelemetryEvent,
} from "./types.js";
import {
	FabricAuthError,
	FabricError,
	FabricForbiddenError,
	FabricNotFoundError,
} from "./types.js";

const DEFAULT_BASE_URL = "https://app.fabricai.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY: Required<FabricRetryOptions> = {
	maxRetries: 2,
	initialDelayMs: 250,
	multiplier: 2,
	maxDelayMs: 5_000,
};
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export type { FabricClientOptions };

export interface ContextDefaults {
	org?: string;
	personal?: boolean;
	project?: string;
}

export interface RequestOptions {
	body?: unknown;
	/**
	 * Optional Idempotency-Key. Auto-generated for mutating requests if not
	 * provided. Reused across retries of the same logical call so the server
	 * can deduplicate.
	 */
	idempotencyKey?: string;
}

/** Read an env var safely across Node / edge / browser. */
function env(name: string): string | undefined {
	if (typeof process === "undefined" || !process.env) {
		return undefined;
	}
	return process.env[name];
}

function envBool(name: string): boolean | undefined {
	const v = env(name);
	if (v === undefined) {
		return undefined;
	}
	return v === "1" || v.toLowerCase() === "true";
}

function randomId(): string {
	if (
		typeof globalThis.crypto !== "undefined" &&
		typeof globalThis.crypto.randomUUID === "function"
	) {
		return globalThis.crypto.randomUUID();
	}
	// Fallback for older Node — non-cryptographic but stable enough for an
	// idempotency key shape.
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FabricHttpClient {
	readonly baseUrl: string;
	readonly defaults: ContextDefaults;
	private readonly apiKey: string;
	private readonly fetchImpl: typeof fetch;
	private readonly timeoutMs: number;
	private readonly retry: Required<FabricRetryOptions>;
	private readonly onEvent?: (event: FabricTelemetryEvent) => void;

	constructor(options: FabricClientOptions = {}) {
		const apiKey = options.apiKey ?? env("FABRIC_API_KEY");
		if (!apiKey) {
			throw new FabricAuthError(
				"No API key provided. Pass apiKey to FabricClient or set FABRIC_API_KEY.",
			);
		}

		const org = options.org ?? env("FABRIC_ORG");
		const personalFromEnv = envBool("FABRIC_PERSONAL");
		const personal = options.personal ?? personalFromEnv;
		if (org && personal) {
			throw new FabricError(
				"Cannot set both `org` and `personal` context — they are mutually exclusive.",
				0,
				"INVALID_CONTEXT",
			);
		}

		this.apiKey = apiKey;
		this.baseUrl =
			options.baseUrl ?? env("FABRIC_BASE_URL") ?? DEFAULT_BASE_URL;
		this.defaults = {
			org,
			personal,
			project: options.project ?? env("FABRIC_PROJECT"),
		};
		this.fetchImpl = options.fetch ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
		this.onEvent = options.onEvent;
	}

	/** Build a sibling client with patched context defaults (immutable; original untouched). */
	withDefaults(patch: ContextDefaults): FabricHttpClient {
		const merged: ContextDefaults = { ...this.defaults, ...patch };
		// Enforce XOR: setting org clears personal (and vice-versa) when the patch
		// explicitly sets one of the two. `undefined` in the patch means "keep".
		if (patch.org !== undefined) {
			merged.personal = undefined;
		}
		if (patch.personal !== undefined) {
			merged.org = undefined;
		}

		const clone = Object.create(
			FabricHttpClient.prototype,
		) as FabricHttpClient;
		Object.assign(clone, {
			apiKey: this.apiKey,
			baseUrl: this.baseUrl,
			defaults: merged,
			fetchImpl: this.fetchImpl,
			timeoutMs: this.timeoutMs,
			retry: this.retry,
			onEvent: this.onEvent,
		});
		return clone;
	}

	/**
	 * Inject default `org` / `personal` query params if the path doesn't already
	 * carry one. Resources that explicitly pass `?org=other` are untouched.
	 */
	private buildUrl(path: string): string {
		const url = `${this.baseUrl}/api/v1${path}`;
		const hasOrg = /[?&]org=/.test(path);
		const hasPersonal = /[?&]personal=/.test(path);

		if (hasOrg || hasPersonal) {
			return url;
		}

		const additions: string[] = [];
		if (this.defaults.org) {
			additions.push(`org=${encodeURIComponent(this.defaults.org)}`);
		} else if (this.defaults.personal) {
			additions.push("personal=1");
		}
		if (additions.length === 0) {
			return url;
		}
		const sep = path.includes("?") ? "&" : "?";
		return `${url}${sep}${additions.join("&")}`;
	}

	async request<T>(
		method: string,
		path: string,
		options: RequestOptions = {},
	): Promise<T> {
		const url = this.buildUrl(path);
		const isMutating = MUTATING_METHODS.has(method);
		const idempotencyKey =
			options.idempotencyKey ?? (isMutating ? randomId() : undefined);
		const maxAttempts = this.retry.maxRetries + 1;

		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const start = Date.now();
			this.emit({ kind: "request", method, path, attempt });

			try {
				const result = await this.executeOnce<T>(
					method,
					url,
					options,
					idempotencyKey,
				);
				this.emit({
					kind: "response",
					method,
					path,
					attempt,
					status: 200,
					durationMs: Date.now() - start,
				});
				return result;
			} catch (err) {
				lastError = err;
				const status =
					err instanceof FabricError ? err.status : undefined;
				const retriable =
					attempt < maxAttempts && this.shouldRetry(method, err);
				this.emit({
					kind: retriable ? "retry" : "error",
					method,
					path,
					attempt,
					status,
					durationMs: Date.now() - start,
					error:
						err instanceof Error
							? {
									message: err.message,
									code: (err as FabricError).code,
								}
							: { message: String(err) },
				});
				if (!retriable) {
					throw err;
				}
				const delay = Math.min(
					this.retry.initialDelayMs *
						this.retry.multiplier ** (attempt - 1),
					this.retry.maxDelayMs,
				);
				await sleep(delay);
			}
		}

		// Should be unreachable — the loop either returns or throws — but keeps TS happy.
		throw lastError instanceof Error
			? lastError
			: new Error(String(lastError));
	}

	private async executeOnce<T>(
		method: string,
		url: string,
		options: RequestOptions,
		idempotencyKey: string | undefined,
	): Promise<T> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};
		if (idempotencyKey) {
			headers["Idempotency-Key"] = idempotencyKey;
		}

		const controller = new AbortController();
		const timeoutHandle = setTimeout(
			() => controller.abort(),
			this.timeoutMs,
		);

		let res: Response;
		try {
			res = await this.fetchImpl(url, {
				method,
				headers,
				body:
					options.body !== undefined
						? JSON.stringify(options.body)
						: undefined,
				signal: controller.signal,
			});
		} catch (err) {
			clearTimeout(timeoutHandle);
			if (err instanceof Error && err.name === "AbortError") {
				throw new FabricError(
					`Request timed out after ${this.timeoutMs}ms`,
					0,
					"TIMEOUT",
				);
			}
			throw new FabricError(
				err instanceof Error ? err.message : String(err),
				0,
				"NETWORK_ERROR",
			);
		}
		clearTimeout(timeoutHandle);

		let json: unknown;
		try {
			json = await res.json();
		} catch {
			throw new FabricError(
				`Unexpected response from server (status ${res.status})`,
				res.status,
			);
		}

		if (!res.ok) {
			const body = json as {
				error?: { message?: string; code?: string };
			};
			const message = body?.error?.message ?? `HTTP ${res.status}`;
			const code = body?.error?.code;

			if (res.status === 401) {
				throw new FabricAuthError(message);
			}
			if (res.status === 403) {
				throw new FabricForbiddenError(message);
			}
			if (res.status === 404) {
				throw new FabricNotFoundError(message);
			}
			throw new FabricError(message, res.status, code);
		}

		return (json as { data: T }).data;
	}

	private shouldRetry(method: string, err: unknown): boolean {
		if (!(err instanceof FabricError)) {
			return false;
		}
		// Auth/forbidden/not-found are deterministic — never retry.
		if (err instanceof FabricAuthError) {
			return false;
		}
		if (err instanceof FabricForbiddenError) {
			return false;
		}
		if (err instanceof FabricNotFoundError) {
			return false;
		}
		// Network errors and timeouts: retry GETs and explicitly mutating methods
		// (the latter are protected by the Idempotency-Key header).
		if (err.code === "NETWORK_ERROR" || err.code === "TIMEOUT") {
			return method === "GET" || MUTATING_METHODS.has(method);
		}
		// HTTP-level retry: only retryable status codes.
		return RETRYABLE_STATUS.has(err.status);
	}

	private emit(event: FabricTelemetryEvent): void {
		if (!this.onEvent) {
			return;
		}
		try {
			this.onEvent(event);
		} catch {
			// Telemetry must never break the request path.
		}
	}

	get<T>(path: string) {
		return this.request<T>("GET", path);
	}

	post<T>(
		path: string,
		body: unknown,
		options: { idempotencyKey?: string } = {},
	) {
		return this.request<T>("POST", path, {
			body,
			idempotencyKey: options.idempotencyKey,
		});
	}

	patch<T>(
		path: string,
		body: unknown,
		options: { idempotencyKey?: string } = {},
	) {
		return this.request<T>("PATCH", path, {
			body,
			idempotencyKey: options.idempotencyKey,
		});
	}

	delete<T>(path: string) {
		return this.request<T>("DELETE", path);
	}
}
