import { PAGE_DOWNLOAD_MAX_BASE64_LENGTH } from "@repo/utils/page-limits";

export const FRAME_RUNTIME_CALL_TIMEOUT_MS = 300_000;

export function frameRuntimeCallExpiresAt(
	expiresAt?: number,
	now = Date.now(),
) {
	return Math.min(
		expiresAt ?? now + FRAME_RUNTIME_CALL_TIMEOUT_MS,
		now + FRAME_RUNTIME_CALL_TIMEOUT_MS,
	);
}

export type FrameHostToEmbedMessage =
	| {
			type: "fabric-frame:request-export-png";
			requestId: string;
	  }
	| {
			type: "fabric-frame:request-display-code";
			requestId: string;
	  };

export type FrameEmbedToHostMessage =
	| {
			type: "fabric-frame:ready";
			frameTitle?: string;
	  }
	| {
			type: "fabric-frame:set-height";
			height: number;
			frameTitle?: string;
	  }
	| {
			type: "fabric-frame:error";
			error: string;
	  }
	| {
			type: "fabric-frame:export-png-result";
			requestId: string;
			dataUrl?: string;
			error?: string;
	  }
	| {
			type: "fabric-frame:display-code";
			requestId: string;
	  };

/**
 * The page runtime: what a sandboxed page's own script (`window.fabric`) asks
 * of Fabric, and what answers it. The page cannot reach Fabric itself, so each
 * request travels page -> embed -> host page, and the answer back the same way.
 * The embed only relays; the host decides (see `frame-runtime-host`).
 */
export type FrameRuntimeRequest =
	| {
			type: "fabric-frame:call";
			requestId: string;
			name: string;
			args: Record<string, unknown>;
			expiresAt?: number;
	  }
	| { type: "fabric-frame:cancel-call"; requestId: string }
	| { type: "fabric-frame:open-agent"; prompt: string }
	| { type: "fabric-frame:navigate"; path: string }
	| {
			type: "fabric-frame:download";
			filename: string;
			mimeType: string;
			dataBase64: string;
	  };

const MAX_DOWNLOAD_NAME_LENGTH = 500;

/**
 * What a call comes back with. A failure carries the message and, when the tool
 * that refused gave them, a `reason` to branch on (`version_conflict`, `busy`,
 * `limit`, `rate_limited`, `usage_limit`) and whether the call is worth trying
 * again (`retryable`).
 */
export type FrameRuntimeCallResult = {
	type: "fabric-frame:call-result";
	requestId: string;
} & (
	| { ok: true; result: unknown }
	| { ok: false; error: string; reason?: string; retryable?: boolean }
);

/**
 * The handshake that makes a request sent at page load safe. A page's script
 * runs as soon as its document is parsed, which can be before the embed that
 * relays for it has attached its listener (the embed does that after it has
 * hydrated); a request posted into that gap reaches no one and is never
 * answered. So the page holds its requests until the embed says it is
 * listening, and either side may come up first:
 *
 * - the embed posts `host-ready` into the page once it is listening;
 * - the page posts `runtime-hello` when it starts, and the embed answers it
 *   with `host-ready`, which covers an embed that attached first.
 *
 * Neither message carries anything; both are believed only from the window
 * they must come from (the page's own iframe, and the page's parent).
 */
export const FRAME_RUNTIME_HELLO_TYPE = "fabric-frame:runtime-hello";
export const FRAME_RUNTIME_HOST_READY_TYPE = "fabric-frame:host-ready";

type FrameRuntimeHello = { type: typeof FRAME_RUNTIME_HELLO_TYPE };
export type FrameRuntimeHostReady = {
	type: typeof FRAME_RUNTIME_HOST_READY_TYPE;
};

export function isFrameRuntimeHello(
	value: unknown,
): value is FrameRuntimeHello {
	return isRecord(value) && value.type === FRAME_RUNTIME_HELLO_TYPE;
}

/**
 * The origin an embed is served from, the only one whose messages the host
 * believes or answers. `embedUrl` is app-relative today, so this is this app's
 * own origin; resolving it rather than hardcoding keeps the check right if the
 * embed is ever served from elsewhere. An address that cannot be read falls
 * back to the app's own origin.
 */
export function resolveEmbedOrigin(embedUrl: string): string {
	try {
		return new URL(embedUrl, window.location.href).origin;
	} catch {
		return window.location.origin;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function isFrameRuntimeRequest(
	value: unknown,
): value is FrameRuntimeRequest {
	if (!isRecord(value)) {
		return false;
	}
	switch (value.type) {
		case "fabric-frame:call":
			return (
				typeof value.requestId === "string" &&
				typeof value.name === "string" &&
				isRecord(value.args) &&
				!Array.isArray(value.args) &&
				(value.expiresAt === undefined ||
					(typeof value.expiresAt === "number" &&
						Number.isFinite(value.expiresAt)))
			);
		case "fabric-frame:cancel-call":
			return typeof value.requestId === "string";
		case "fabric-frame:open-agent":
			return typeof value.prompt === "string";
		case "fabric-frame:navigate":
			return typeof value.path === "string";
		case "fabric-frame:download":
			return (
				typeof value.filename === "string" &&
				value.filename.length <= MAX_DOWNLOAD_NAME_LENGTH &&
				typeof value.mimeType === "string" &&
				value.mimeType.length <= MAX_DOWNLOAD_NAME_LENGTH &&
				typeof value.dataBase64 === "string" &&
				value.dataBase64.length <= PAGE_DOWNLOAD_MAX_BASE64_LENGTH
			);
		default:
			return false;
	}
}

export function isFrameRuntimeCallResult(
	value: unknown,
): value is FrameRuntimeCallResult {
	if (
		!isRecord(value) ||
		value.type !== "fabric-frame:call-result" ||
		typeof value.requestId !== "string"
	) {
		return false;
	}
	return (
		value.ok === true ||
		(value.ok === false &&
			typeof value.error === "string" &&
			(value.reason === undefined || typeof value.reason === "string") &&
			(value.retryable === undefined ||
				typeof value.retryable === "boolean"))
	);
}

export function isFrameHostToEmbedMessage(
	value: unknown,
): value is FrameHostToEmbedMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	if (
		(value.type === "fabric-frame:request-export-png" ||
			value.type === "fabric-frame:request-display-code") &&
		typeof value.requestId === "string"
	) {
		return true;
	}

	return false;
}

export function isFrameEmbedToHostMessage(
	value: unknown,
): value is FrameEmbedToHostMessage {
	if (!isRecord(value) || typeof value.type !== "string") {
		return false;
	}

	switch (value.type) {
		case "fabric-frame:ready":
			return (
				value.frameTitle === undefined ||
				typeof value.frameTitle === "string"
			);
		case "fabric-frame:set-height":
			return (
				typeof value.height === "number" &&
				(value.frameTitle === undefined ||
					typeof value.frameTitle === "string")
			);
		case "fabric-frame:error":
			return typeof value.error === "string";
		case "fabric-frame:export-png-result":
			return (
				typeof value.requestId === "string" &&
				(value.dataUrl === undefined ||
					typeof value.dataUrl === "string") &&
				(value.error === undefined || typeof value.error === "string")
			);
		case "fabric-frame:display-code":
			return typeof value.requestId === "string";
		default:
			return false;
	}
}
