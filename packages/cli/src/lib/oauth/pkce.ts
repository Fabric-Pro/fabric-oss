/**
 * PKCE (RFC 7636) and the opaque `state` value, from the platform's CSPRNG.
 */

import { createHash, randomBytes } from "node:crypto";

function base64Url(bytes: Buffer): string {
	return bytes.toString("base64url");
}

export function createCodeVerifier(): string {
	// 32 bytes encode to 43 characters, the minimum length RFC 7636 allows.
	return base64Url(randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
	return base64Url(createHash("sha256").update(verifier).digest());
}

export function createState(): string {
	return base64Url(randomBytes(16));
}
