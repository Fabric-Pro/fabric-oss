/**
 * HMAC-signed invitation token wrapper for organisation invitation emails.
 *
 * Format: delegates entirely to `signed-token.ts`, which produces a two-part
 * `base64url(json).base64url(hmac-sha256)` string. The payload carries
 * `invitationId` and `email`; the HMAC covers both fields plus the embedded
 * expiry, so neither can be tampered with independently.
 *
 * TTL: 7 days — long enough to survive a weekend of ignored inboxes.
 *
 * Usage:
 *   - `buildInvitationToken({ invitationId, email })` — call in `auth.ts`
 *     when constructing the invitation URL.
 *   - `parseInvitationToken(token)` — call in the receiving Next.js route
 *     server component to decode and validate before rendering the form.
 *
 * The tokens are not encrypted; `invitationId` and `email` are readable by
 * anyone who holds the URL. That is intentional: they are not secrets, and
 * the HMAC only guarantees integrity (the server issued this token for this
 * invitationId+email pair) not confidentiality.
 */

import { signToken, verifyToken } from "./signed-token";

const TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export interface InvitationPayload {
	invitationId: string;
	email: string;
}

export function buildInvitationToken(payload: InvitationPayload): string {
	return signToken(payload, { ttlSec: TTL_SEC });
}

export function parseInvitationToken(token: string) {
	return verifyToken<InvitationPayload>(token);
}
