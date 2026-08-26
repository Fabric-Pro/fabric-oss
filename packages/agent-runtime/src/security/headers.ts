/**
 * Security Headers Utilities
 *
 * Constants and utilities for security-related HTTP headers
 * used in inter-agent communication.
 */

import type { TenantContext } from "../types";
import { type SignedTenantContext, signTenantContext } from "./signing";

/**
 * Header names for inter-agent security
 */
export const SECURITY_HEADERS = {
	/** Service-to-service authentication token */
	SERVICE_TOKEN: "X-Service-Token",
	/** Base64 encoded tenant context payload */
	TENANT_PAYLOAD: "X-Tenant-Payload",
	/** HMAC signature of the tenant payload */
	TENANT_SIGNATURE: "X-Tenant-Signature",
	/** Timestamp when the context was signed */
	TENANT_TIMESTAMP: "X-Tenant-Timestamp",
	/** Request ID for tracing */
	REQUEST_ID: "X-Request-ID",
	/** Source agent ID */
	SOURCE_AGENT: "X-Source-Agent",
} as const;

/**
 * Create security headers for inter-agent requests
 *
 * @param tenantContext - The tenant context to include
 * @param options - Additional options
 * @returns Headers object to include in requests
 */
export function createSecurityHeaders(
	tenantContext: TenantContext,
	options?: {
		serviceToken?: string;
		sourceAgent?: string;
		requestId?: string;
	},
): Record<string, string> {
	const serviceToken =
		options?.serviceToken || process.env.AGENT_SERVICE_SECRET;

	if (!serviceToken) {
		throw new Error(
			"Service token is required. Set AGENT_SERVICE_SECRET or pass serviceToken option.",
		);
	}

	const signed = signTenantContext(tenantContext);

	const headers: Record<string, string> = {
		[SECURITY_HEADERS.SERVICE_TOKEN]: serviceToken,
		[SECURITY_HEADERS.TENANT_PAYLOAD]: signed.payload,
		[SECURITY_HEADERS.TENANT_SIGNATURE]: signed.signature,
		[SECURITY_HEADERS.TENANT_TIMESTAMP]: signed.timestamp.toString(),
	};

	if (options?.sourceAgent) {
		headers[SECURITY_HEADERS.SOURCE_AGENT] = options.sourceAgent;
	}

	if (options?.requestId) {
		headers[SECURITY_HEADERS.REQUEST_ID] = options.requestId;
	}

	return headers;
}

/**
 * Extract signed tenant context from request headers
 *
 * @param headers - Request headers (can be Headers object or plain object)
 * @returns SignedTenantContext if all required headers present, null otherwise
 */
export function extractSignedContextFromHeaders(
	headers: Headers | Record<string, string | undefined>,
): SignedTenantContext | null {
	const getHeader = (name: string): string | undefined => {
		if (headers instanceof Headers) {
			return headers.get(name) ?? undefined;
		}
		return headers[name];
	};

	const payload = getHeader(SECURITY_HEADERS.TENANT_PAYLOAD);
	const signature = getHeader(SECURITY_HEADERS.TENANT_SIGNATURE);
	const timestampStr = getHeader(SECURITY_HEADERS.TENANT_TIMESTAMP);

	if (!payload || !signature || !timestampStr) {
		return null;
	}

	const timestamp = Number.parseInt(timestampStr, 10);
	if (Number.isNaN(timestamp)) {
		return null;
	}

	return { payload, signature, timestamp };
}

/**
 * Extract service token from request headers
 */
export function extractServiceToken(
	headers: Headers | Record<string, string | undefined>,
): string | null {
	if (headers instanceof Headers) {
		return headers.get(SECURITY_HEADERS.SERVICE_TOKEN);
	}
	return headers[SECURITY_HEADERS.SERVICE_TOKEN] ?? null;
}

/**
 * Extract request ID from headers
 */
export function extractRequestId(
	headers: Headers | Record<string, string | undefined>,
): string | null {
	if (headers instanceof Headers) {
		return headers.get(SECURITY_HEADERS.REQUEST_ID);
	}
	return headers[SECURITY_HEADERS.REQUEST_ID] ?? null;
}

/**
 * Extract source agent from headers
 */
export function extractSourceAgent(
	headers: Headers | Record<string, string | undefined>,
): string | null {
	if (headers instanceof Headers) {
		return headers.get(SECURITY_HEADERS.SOURCE_AGENT);
	}
	return headers[SECURITY_HEADERS.SOURCE_AGENT] ?? null;
}
