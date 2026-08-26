import { timingSafeEqual } from "node:crypto";
import {
	extractServiceToken,
	extractSignedContextFromHeaders,
} from "./headers";
import { SignatureVerificationError, verifyTenantContext } from "./signing";

export type VerifySignedTenantRequestResult =
	| { ok: true; userId: string; organizationId?: string }
	| { ok: false; status: number; error: string };

/**
 * Framework-agnostic validator for inbound requests that carry an HMAC-signed
 * tenant context (X-Service-Token + X-Tenant-Payload + X-Tenant-Signature +
 * X-Tenant-Timestamp). Returns a discriminated union so Next.js route
 * handlers and other non-Hono callers can translate it into their own
 * response format.
 *
 * The Hono middleware `serviceAuth` uses the same primitives under the
 * hood — this helper exists for environments that don't mount middleware.
 */
export function verifySignedTenantRequest(
	headers: Headers | Record<string, string | undefined>,
): VerifySignedTenantRequestResult {
	const expectedToken = process.env.AGENT_SERVICE_SECRET;
	if (!expectedToken) {
		return {
			ok: false,
			status: 500,
			error: "AGENT_SERVICE_SECRET not configured on server",
		};
	}

	const providedToken = extractServiceToken(headers);
	if (!providedToken) {
		return { ok: false, status: 401, error: "Missing service token" };
	}

	if (
		providedToken.length !== expectedToken.length ||
		!timingSafeEqual(Buffer.from(providedToken), Buffer.from(expectedToken))
	) {
		return { ok: false, status: 401, error: "Invalid service token" };
	}

	const signed = extractSignedContextFromHeaders(headers);
	if (!signed) {
		return {
			ok: false,
			status: 400,
			error: "Missing signed tenant context headers",
		};
	}

	try {
		const tenant = verifyTenantContext(signed, expectedToken);
		return {
			ok: true,
			userId: tenant.userId,
			organizationId: tenant.organizationId ?? undefined,
		};
	} catch (error) {
		if (error instanceof SignatureVerificationError) {
			return { ok: false, status: 401, error: error.message };
		}
		throw error;
	}
}
