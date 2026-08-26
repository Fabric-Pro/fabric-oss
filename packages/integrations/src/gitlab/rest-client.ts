const GITLAB_API_BASE = "https://gitlab.com/api/v4";
const MAX_RATE_LIMIT_WAIT_MS = 2_000;

export class GitLabApiError extends Error {
	override name = "GitLabApiError";
	public readonly status: number;
	public readonly requestId: string | null;
	public readonly code: string | null;
	public readonly retryAfterMs: number | null;

	constructor(
		status: number,
		message: string,
		requestId: string | null = null,
		code: string | null = null,
		retryAfterMs: number | null = null,
		options?: { cause?: unknown },
	) {
		super(message, options);
		if (!Number.isInteger(status)) {
			throw new Error(
				`GitLabApiError: status must be an integer, got ${String(status)}`,
			);
		}
		this.status = status;
		this.requestId = requestId;
		this.code = code;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface GitLabRequestOptions {
	path: string;
	token: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	onRefreshToken?: () => Promise<string>;
	signal?: AbortSignal;
}

export interface GitLabRequestResult<T> {
	status: number;
	body: T;
	headers: Headers;
}

function buildUrl(path: string, query?: GitLabRequestOptions["query"]): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	const url = new URL(`${GITLAB_API_BASE}${normalized}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined) {
				url.searchParams.set(k, String(v));
			}
		}
	}
	return url.toString();
}

async function readErrorMessage(response: Response): Promise<string> {
	try {
		const data = (await response.clone().json()) as {
			error_description?: unknown;
			error?: unknown;
			message?: unknown;
		};
		if (typeof data.error_description === "string") {
			return data.error_description;
		}
		if (typeof data.error === "string") {
			return data.error;
		}
		if (typeof data.message === "string") {
			return data.message;
		}
		return `HTTP ${response.status}`;
	} catch {
		try {
			const text = await response.clone().text();
			if (!text) {
				return `HTTP ${response.status}`;
			}
			const truncated = text.length > 200 ? text.slice(0, 200) : text;
			return `HTTP ${response.status}: ${truncated}`;
		} catch {
			return `HTTP ${response.status}`;
		}
	}
}

function computeRetryAfterMs(response: Response): number | null {
	const resetHeader = response.headers.get("RateLimit-Reset");
	if (!resetHeader) {
		return null;
	}
	const resetSec = Number(resetHeader);
	if (!Number.isFinite(resetSec)) {
		return null;
	}
	const nowSec = Math.floor(Date.now() / 1000);
	return Math.max(0, (resetSec - nowSec) * 1000);
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new GitLabApiError(
			0,
			`Network error contacting GitLab: ${message}`,
			null,
			"NETWORK_ERROR",
			null,
			{ cause: err },
		);
	}
}

export async function gitlabRequest<T = unknown>(
	options: GitLabRequestOptions,
): Promise<GitLabRequestResult<T>> {
	const url = buildUrl(options.path, options.query);
	const init: RequestInit = {
		method: options.method ?? "GET",
		headers: {
			Authorization: `Bearer ${options.token}`,
			Accept: "application/json",
			"User-Agent": "Fabric-App",
			...(options.body ? { "Content-Type": "application/json" } : {}),
			...options.headers,
		},
		body: options.body ? JSON.stringify(options.body) : undefined,
		signal: options.signal,
	};

	let response = await safeFetch(url, init);

	if (response.status === 401 && options.onRefreshToken) {
		let newToken: string;
		try {
			newToken = await options.onRefreshToken();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new GitLabApiError(
				401,
				`Token refresh failed: ${message}`,
				null,
				"REFRESH_FAILED",
				null,
				{ cause: err },
			);
		}
		(init.headers as Record<string, string>).Authorization =
			`Bearer ${newToken}`;
		response = await safeFetch(url, init);
	}

	if (response.status === 429) {
		const resetHeader = response.headers.get("RateLimit-Reset");
		const nowSec = Math.floor(Date.now() / 1000);
		const waitMs = resetHeader
			? Math.min(
					Math.max(0, (Number(resetHeader) - nowSec) * 1000),
					MAX_RATE_LIMIT_WAIT_MS,
				)
			: 500;
		await new Promise((r) => setTimeout(r, waitMs));
		response = await safeFetch(url, init);
	}

	if (!response.ok) {
		const message = await readErrorMessage(response);
		const retryAfterMs =
			response.status === 429 ? computeRetryAfterMs(response) : null;
		throw new GitLabApiError(
			response.status,
			message,
			response.headers.get("X-Request-Id"),
			response.headers.get("X-Gitlab-Error-Code"),
			retryAfterMs,
		);
	}

	const contentType = response.headers.get("Content-Type") ?? "";
	const body = (
		contentType.includes("application/json") ? await response.json() : null
	) as T;

	return { status: response.status, body, headers: response.headers };
}
