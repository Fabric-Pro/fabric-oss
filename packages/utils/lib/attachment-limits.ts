/**
 * Server-authoritative attachment limits (#1702 Part 1).
 *
 * Lives here, not in `attachment.ts`: that module is deliberately pure so the
 * client can share it, and this one reads `process.env`. It lives in
 * @repo/utils rather than @repo/api because BOTH the API upload path and the
 * Temporal PM pull path (Fizzy #1745, AC-9) have to enforce the same numbers,
 * and @repo/temporal cannot depend on @repo/api — the dependency runs the
 * other way. Two copies of a limit is how the two paths drift apart.
 */
import {
	DEFAULT_ATTACHMENT_MIME_ALLOWLIST,
	DEFAULT_MAX_ATTACHMENT_BYTES,
	DEFAULT_MAX_ATTACHMENTS_PER_STORY,
} from "./attachment";

const MAX_BYTES_CEILING = 2_000_000_000; // sizeBytes is Int (int4); stay under ~2.14 GB

export interface AttachmentLimits {
	maxBytes: number;
	maxPerStory: number;
	allowlist: readonly string[];
}

function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
	ceiling?: number,
): number {
	if (raw === undefined) {
		return fallback;
	}
	const n = Number.parseInt(raw.trim(), 10);
	if (!Number.isFinite(n) || n <= 0) {
		return fallback;
	}
	return ceiling !== undefined ? Math.min(n, ceiling) : n;
}

/**
 * Env values are operator-trusted server config (NOT request input). Fails
 * closed: byte cap clamps to <= 2 GB; a present-but-empty allowlist env
 * rejects all types.
 */
export function resolveAttachmentLimits(): AttachmentLimits {
	const allowlistEnv = process.env.FABRIC_ATTACHMENT_MIME_ALLOWLIST;
	let allowlist: readonly string[];
	if (allowlistEnv === undefined) {
		allowlist = DEFAULT_ATTACHMENT_MIME_ALLOWLIST;
	} else {
		allowlist = allowlistEnv
			.split(",")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}

	return {
		maxBytes: parsePositiveInt(
			process.env.FABRIC_ATTACHMENT_MAX_BYTES,
			DEFAULT_MAX_ATTACHMENT_BYTES,
			MAX_BYTES_CEILING,
		),
		maxPerStory: parsePositiveInt(
			process.env.FABRIC_ATTACHMENT_MAX_PER_STORY,
			DEFAULT_MAX_ATTACHMENTS_PER_STORY,
		),
		allowlist,
	};
}
