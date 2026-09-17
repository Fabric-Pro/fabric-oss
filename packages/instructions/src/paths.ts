import { SNAPSHOT_LIMITS } from "./limits";

export type PathRejectReason =
	| "empty"
	| "absolute"
	| "traversal"
	| "drive"
	| "unc"
	| "too_long"
	| "too_deep"
	| "control_char";

export type PathValidation =
	| { ok: true; path: string }
	| { ok: false; reason: PathRejectReason };

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;
const DRIVE_LETTER = /^[A-Za-z]:[\\/]/;
const LEADING_DOT_SLASH = /^(\.\/)+/;

export function validateRelativePath(input: string): PathValidation {
	if (input.length === 0) {
		return { ok: false, reason: "empty" };
	}
	if (CONTROL_CHAR.test(input)) {
		return { ok: false, reason: "control_char" };
	}
	if (input.startsWith("\\\\")) {
		return { ok: false, reason: "unc" };
	}
	if (DRIVE_LETTER.test(input)) {
		return { ok: false, reason: "drive" };
	}
	let normalized = input.replace(/\\/g, "/");
	if (normalized.startsWith("/")) {
		return { ok: false, reason: "absolute" };
	}
	normalized = normalized
		.replace(LEADING_DOT_SLASH, "")
		.replace(/\/{2,}/g, "/");
	const segments = normalized.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) {
		return { ok: false, reason: "empty" };
	}
	if (segments.some((s) => s === "." || s === "..")) {
		return { ok: false, reason: "traversal" };
	}
	const joined = segments.join("/");
	if (
		new TextEncoder().encode(joined).length > SNAPSHOT_LIMITS.maxPathBytes
	) {
		return { ok: false, reason: "too_long" };
	}
	if (segments.length > SNAPSHOT_LIMITS.maxDepth) {
		return { ok: false, reason: "too_deep" };
	}
	return { ok: true, path: joined };
}
