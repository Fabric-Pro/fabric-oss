/**
 * How this CLI introduces itself to a deployment, and the one thing a
 * deployment can say back about it.
 *
 * The `User-Agent` names the build and its instruction-download capability
 * (`fabric-cli/0.5.0 (node/22.11.0; linux; instructions-stream-v1)`),
 * so a server that no longer supports an old CLI can say so. It answers with
 * an `X-Fabric-Cli-Upgrade` header carrying the exact line to show, which the
 * SDK hands over. This module keeps the first one a run sees; the command
 * boundary prints it once. Only the copy a session hook keeps updates itself
 * (`lib/instructions/self-update.ts`), and not because of this line.
 */
import packageJson from "../../package.json";
import { sanitizeDisplayText } from "./instructions/checks.js";

const INSTRUCTIONS_STREAMING_CAPABILITY = "instructions-stream-v1";

export function cliUserAgent(
	version: string = packageJson.version,
	nodeVersion: string = process.versions.node,
	platform: string = process.platform,
): string {
	return `fabric-cli/${version} (node/${nodeVersion}; ${platform}; ${INSTRUCTIONS_STREAMING_CAPABILITY})`;
}

const MAX_NOTICE_CHARS = 300;

let notice: string | null = null;

/** The marks, embeddings, overrides and isolates that reorder text on a screen. */
function reordersText(code: number): boolean {
	return (
		code === 0x061c ||
		code === 0x200e ||
		code === 0x200f ||
		(code >= 0x202a && code <= 0x202e) ||
		(code >= 0x2066 && code <= 0x2069)
	);
}

/**
 * What a server's header may carry into a terminal or an agent's context:
 * control characters (C0, DEL, C1 and the line separators) and the characters
 * that reorder text become spaces, and the length is bounded.
 */
function printable(line: string): string {
	let out = "";
	for (const character of sanitizeDisplayText(line, MAX_NOTICE_CHARS)) {
		out += reordersText(character.codePointAt(0) ?? 0) ? " " : character;
	}
	return out.trim();
}

/** Keep the first upgrade line this run sees. */
export function recordUpgradeNotice(line: string): void {
	if (notice === null) {
		const clean = printable(line);
		notice = clean === "" ? null : clean;
	}
}

/** The upgrade line recorded since the last call, if any; asking clears it. */
export function takeUpgradeNotice(): string | null {
	const line = notice;
	notice = null;
	return line;
}
