/**
 * Shared helpers for v1 API routes
 */
import { db } from "@repo/database";
import type { ExternalApiContext } from "../external-api/types";

export interface V1TenantContext {
	userId: string;
	organizationId: string | null;
}

/**
 * Resolves tenant context from API key + optional ?org= / ?personal=1 query params.
 * - org_ key → always uses the key's org ID
 * - fab_ key + ?org=slug → looks up org, verifies membership, uses that org ID
 * - fab_ key + ?personal=1 → explicit personal context (organizationId: null)
 * - fab_ key → personal context (organizationId: null)
 */
export async function resolveV1Context(
	apiCtx: ExternalApiContext,
	orgSlug?: string,
	personal?: boolean,
): Promise<V1TenantContext | { error: string; status: 403 | 404 }> {
	// Explicit personal context request
	if (personal) {
		if (apiCtx.keyType === "organization") {
			return {
				error: "Cannot use personal context with an organization API key",
				status: 403,
			};
		}
		return { userId: apiCtx.userId, organizationId: null };
	}

	// Org key always scopes to that org
	if (apiCtx.keyType === "organization" && apiCtx.organizationId) {
		return { userId: apiCtx.userId, organizationId: apiCtx.organizationId };
	}

	// Personal key with explicit org override
	if (orgSlug) {
		const org = await db.organization.findFirst({
			where: { slug: orgSlug },
			select: { id: true },
		});
		if (!org) {
			return { error: `Organization not found: ${orgSlug}`, status: 404 };
		}

		const member = await db.member.findFirst({
			where: { organizationId: org.id, userId: apiCtx.userId },
			select: { id: true },
		});
		if (!member) {
			return {
				error: "You are not a member of this organization",
				status: 403,
			};
		}

		return { userId: apiCtx.userId, organizationId: org.id };
	}

	// Personal context
	return { userId: apiCtx.userId, organizationId: null };
}

/** Standard v1 JSON envelope */
export function ok<T>(data: T, meta?: Record<string, unknown>) {
	return { data, ...(meta ? { meta } : {}) };
}

export function notFound(resource = "Resource") {
	return { error: { message: `${resource} not found` } };
}

export function forbidden(msg = "Forbidden") {
	return { error: { message: msg } };
}

export function badRequest(msg: string) {
	return { error: { message: msg } };
}
