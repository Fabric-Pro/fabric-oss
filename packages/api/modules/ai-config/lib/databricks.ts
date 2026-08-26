/**
 * Databricks Model Serving / Unity AI Gateway helpers.
 *
 * Databricks exposes OpenAI-compatible inference two ways:
 *  - Classic Model Serving (GA): `<host>/serving-endpoints` — endpoints are
 *    listed via the native admin API `GET <host>/api/2.0/serving-endpoints`
 *    (there is no OpenAI `/models` route on this surface).
 *  - Unity AI Gateway (Beta): a full path like `<host>/ai-gateway/mlflow/v1`
 *    — OpenAI-compatible; model discovery, when available, is `GET <base>/models`.
 *
 * Credential validity and model listing are DECOUPLED on purpose: listing
 * serving endpoints (or gateway model services) can require more privilege than
 * actually querying a model, so a connection test must not hard-fail when a
 * valid, inference-capable token simply cannot enumerate models. Use
 * `validateDatabricksToken` for "is this token valid + can it reach the
 * workspace" and `listDatabricksModels` (best-effort) to populate model pickers.
 */

import {
	hasDatabricksExplicitPath,
	toDatabricksServingBaseUrl,
} from "@repo/ai";

const DEFAULT_TIMEOUT_MS = 10_000;

export type DatabricksListResult =
	| { ok: true; models: string[] }
	| { ok: false; status: number; message: string };

export type DatabricksAuthResult =
	| { ok: true }
	| { ok: false; status: number; message: string };

/**
 * Normalize a stored Databricks base URL to the workspace API host (origin).
 * The native REST APIs (`/api/2.0/...`) always live at the workspace root,
 * regardless of any inference path the tenant stored (`/serving-endpoints`,
 * `/ai-gateway/mlflow/v1`, …).
 */
export function toDatabricksApiHost(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	try {
		return new URL(trimmed).origin;
	} catch {
		// Unparseable (shouldn't happen for a validated https URL): strip known
		// inference path suffixes as a best effort.
		return trimmed
			.replace(/\/serving-endpoints$/, "")
			.replace(/\/ai-gateway\/.*$/, "");
	}
}

/**
 * True when the stored base URL carries a path beyond the workspace root.
 * Re-exported from `@repo/ai` so the inference-path contract has one owner.
 */
export const hasExplicitPath = hasDatabricksExplicitPath;

/**
 * Resolve the OpenAI-compatible inference base URL. A bare workspace host
 * defaults to the GA classic path `<host>/serving-endpoints`; a URL that
 * already carries a path (e.g. the Unity AI Gateway) is respected verbatim.
 * Re-exported from `@repo/ai` so the inference-path contract has one owner.
 */
export const toDatabricksInferenceBaseUrl = toDatabricksServingBaseUrl;

async function authedGet(
	url: string,
	apiKey: string,
	timeoutMs: number,
): Promise<{ response: Response } | { networkError: string }> {
	try {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { response };
	} catch (error) {
		return {
			networkError:
				error instanceof Error && error.name === "TimeoutError"
					? "Request timed out"
					: "Could not reach the Databricks workspace",
		};
	}
}

/**
 * Validate a Databricks token with least privilege: the SCIM "current user"
 * endpoint returns the caller's own identity and is reachable by any
 * authenticated principal with workspace access, so it confirms the token is
 * valid WITHOUT requiring permission to list serving endpoints or model
 * services.
 */
export async function validateDatabricksToken(
	baseUrl: string,
	apiKey: string,
	opts?: { timeoutMs?: number },
): Promise<DatabricksAuthResult> {
	const host = toDatabricksApiHost(baseUrl);
	if (!host) {
		return {
			ok: false,
			status: 0,
			message: "Missing Databricks workspace URL",
		};
	}

	const result = await authedGet(
		`${host}/api/2.0/preview/scim/v2/Me`,
		apiKey,
		opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	if ("networkError" in result) {
		return { ok: false, status: 0, message: result.networkError };
	}
	const { response } = result;
	if (response.status === 401) {
		return { ok: false, status: 401, message: "Invalid credentials" };
	}
	if (response.status === 403) {
		return {
			ok: false,
			status: 403,
			message: "The token is valid but lacks access to this workspace",
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			message: `Databricks returned an error (HTTP ${response.status})`,
		};
	}
	return { ok: true };
}

/**
 * List the model names available to a token — best-effort, and path-aware:
 *  - Unity AI Gateway base (has a path) → OpenAI-compatible `GET <base>/models`.
 *  - Classic serving (bare host) → native `GET <host>/api/2.0/serving-endpoints`.
 *
 * Callers should treat a non-ok result as "could not enumerate models" (e.g. the
 * token can query but not list, or the gateway exposes no /models route) rather
 * than a hard connection failure — pair with `validateDatabricksToken`.
 */
export async function listDatabricksModels(
	baseUrl: string,
	apiKey: string,
	opts?: { timeoutMs?: number },
): Promise<DatabricksListResult> {
	const host = toDatabricksApiHost(baseUrl);
	if (!host) {
		return {
			ok: false,
			status: 0,
			message: "Missing Databricks workspace URL",
		};
	}
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const usesGateway = hasExplicitPath(baseUrl);
	const url = usesGateway
		? `${toDatabricksInferenceBaseUrl(baseUrl)}/models`
		: `${host}/api/2.0/serving-endpoints`;

	const result = await authedGet(url, apiKey, timeoutMs);
	if ("networkError" in result) {
		return { ok: false, status: 0, message: result.networkError };
	}
	const { response } = result;
	if (response.status === 401) {
		return { ok: false, status: 401, message: "Invalid credentials" };
	}
	if (response.status === 403) {
		return { ok: false, status: 403, message: "Insufficient permissions" };
	}
	if (!response.ok) {
		return {
			ok: false,
			status: response.status,
			message: `Databricks returned an error (HTTP ${response.status})`,
		};
	}

	// Gateway → OpenAI `{ data: [{ id }] }`; classic → `{ endpoints: [{ name }] }`.
	const data = (await response.json()) as {
		data?: Array<{ id?: string }>;
		endpoints?: Array<{ name?: string }>;
	};
	const models = usesGateway
		? (data.data ?? [])
				.map((m) => m.id)
				.filter((id): id is string => Boolean(id))
		: (data.endpoints ?? [])
				.map((e) => e.name)
				.filter((name): name is string => Boolean(name));

	return { ok: true, models };
}
