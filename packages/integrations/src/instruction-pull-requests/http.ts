/**
 * The one HTTP helper the three adapters share (Fizzy #2563 spec §10): fixed
 * origin, no redirect followed to another origin, a per-request timeout
 * combined with the activity's cancellation, and a sanitized error for every
 * failure. Independent of the GitHub and GitLab tool handlers' transports
 * (plan R6).
 */
import { type AdapterOperation, adapterError, statusError } from "./classify";
import type { Target } from "./types";

export type JsonResponse = { status: number; headers: Headers; body: unknown };

/** Same-origin redirects a GET may follow (a renamed repository); never for a write. */
const MAX_REDIRECTS = 3;
/** Bytes of an error body read to recognise a duplicate refusal; never kept. */
const MAX_ERROR_BODY_CHARS = 16 * 1024;

function sameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/** The activity's cancellation propagates as itself; everything else is sanitized. */
function rethrowIfCancelled(target: Target, error: unknown): void {
	if (target.signal.aborted) {
		throw target.signal.reason ?? error;
	}
}

export async function requestJson(input: {
	target: Target;
	operation: AdapterOperation;
	method: "GET" | "POST" | "PATCH" | "PUT";
	url: string;
	origin: string;
	headers: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
	/** Given only for `open`: whether a refusal's body says the pull request already exists. */
	isDuplicate?: (status: number, text: string) => boolean;
}): Promise<JsonResponse> {
	const { target, operation, origin } = input;
	const signal = AbortSignal.any([
		target.signal,
		AbortSignal.timeout(input.timeoutMs),
	]);
	let url = input.url;
	for (let hop = 0; ; hop++) {
		if (!sameOrigin(url, origin)) {
			throw adapterError(operation, "unknown");
		}
		let res: Response;
		try {
			res = await fetch(url, {
				method: input.method,
				headers: {
					...input.headers,
					...(input.body === undefined
						? {}
						: { "Content-Type": "application/json" }),
				},
				...(input.body === undefined
					? {}
					: { body: JSON.stringify(input.body) }),
				redirect: "manual",
				signal,
			});
		} catch (error) {
			rethrowIfCancelled(target, error);
			// A timeout or a network failure: the request may or may not
			// have reached the provider.
			throw adapterError(operation, "transient");
		}
		if (res.url !== "" && !sameOrigin(res.url, origin)) {
			throw adapterError(operation, "unknown");
		}
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (
				input.method === "GET" &&
				location !== null &&
				hop < MAX_REDIRECTS
			) {
				const next = new URL(location, url);
				if (next.origin === origin) {
					url = next.toString();
					continue;
				}
			}
			throw adapterError(operation, "unknown");
		}
		if (res.status === 203) {
			// Azure DevOps answers a rejected PAT with 203 and a sign-in page.
			throw adapterError(operation, "auth");
		}
		if (!res.ok) {
			let duplicate = false;
			if (input.isDuplicate) {
				const text = await res.text().catch(() => "");
				duplicate = input.isDuplicate(
					res.status,
					text.slice(0, MAX_ERROR_BODY_CHARS),
				);
			}
			throw statusError(
				operation,
				res.status,
				res.headers,
				duplicate ? { duplicate: true } : {},
			);
		}
		let text: string;
		try {
			text = await res.text();
		} catch (error) {
			rethrowIfCancelled(target, error);
			throw adapterError(operation, "transient");
		}
		try {
			return {
				status: res.status,
				headers: res.headers,
				body: text === "" ? null : (JSON.parse(text) as unknown),
			};
		} catch {
			throw adapterError(operation, "unknown");
		}
	}
}

/** Encodes one path segment exactly once, whether it arrives decoded or already percent-encoded (Review Focus 3). */
export function encodeSegment(value: string): string {
	let decoded = value;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		// Not valid percent-encoding: the value is its own decoded form.
	}
	return encodeURIComponent(decoded);
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

export const str = (v: unknown): string | undefined =>
	typeof v === "string" && v !== "" ? v : undefined;

export const num = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isFinite(v) ? v : undefined;
