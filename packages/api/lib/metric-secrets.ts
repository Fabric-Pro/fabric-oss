/**
 * Success-metric webhook secrets (plan Slice 8).
 *
 * The database stores only `sha256(secret)` in
 * `ProjectSuccessMetric.webhookSecretHash`; the plaintext is returned to the
 * caller exactly once at create / rotate time and never logged. Because only
 * a hash is kept, the ingress cannot verify an HMAC over the body (that
 * would need the secret itself), so the webhook uses **bearer-token auth**:
 * the sender puts the secret in `Authorization: Bearer <secret>` and the
 * route compares `sha256(presented)` against the stored hash in constant
 * time. Transport security (TLS) protects the token in flight, exactly as
 * it does for any API key.
 *
 * Shared by the oRPC procedures (packages/api) and the Next.js ingress route
 * (apps/web/app/api/metrics/webhook/[metricId]/route.ts).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 32 random bytes, base64url — ~43 chars, URL/header safe. */
export function generateMetricWebhookSecret(): string {
	return randomBytes(32).toString("base64url");
}

export function hashMetricWebhookSecret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Constant-time comparison of a presented secret against the stored hash.
 * Returns false for a missing hash so a MANUAL metric (no secret) can never
 * be fed through the webhook.
 */
export function verifyMetricWebhookSecret(
	presented: string | null | undefined,
	storedHash: string | null | undefined,
): boolean {
	if (!presented || !storedHash) {
		return false;
	}
	const a = Buffer.from(hashMetricWebhookSecret(presented), "hex");
	const b = Buffer.from(storedHash, "hex");
	if (a.length !== b.length || a.length === 0) {
		return false;
	}
	return timingSafeEqual(a, b);
}

/** Extracts the token from `Authorization: Bearer <token>` (case-insensitive scheme). */
export function extractBearerToken(
	authorizationHeader: string | null | undefined,
): string | null {
	if (!authorizationHeader) {
		return null;
	}
	const match = /^Bearer\s+(\S+)\s*$/i.exec(authorizationHeader);
	return match?.[1] ?? null;
}
