/**
 * Shared helpers for v1 API routes
 */
import { db, resolveUserOrganization } from "@repo/database";
import type { ExternalApiContext } from "../external-api/types";

export interface V1TenantContext {
	userId: string;
	organizationId: string | null;
}

/**
 * Resolve which organization a v1 request runs in.
 *
 * Four inputs, and only two of them were ever safe. An organization key carries
 * its tenant on the key record, and `?org=<slug>` is looked up and
 * membership-checked. The other two — `?personal=1`, and sending nothing —
 * both resolved to no organization at all, which is the context being removed
 * (Fizzy #1875, PO-9).
 *
 * They are now no-ops that resolve like every other key-authenticated caller,
 * through the shared helper the protocol servers use. `?personal=1` is kept
 * ACCEPTED rather than rejected on purpose: the command-line client persists a
 * chosen context and keeps sending the flag until its user upgrades, so
 * refusing the parameter outright would break installed clients at the moment
 * the server changed. It is accepted, ignored, and resolves to an organization
 * — which is what "no-op" has to mean for a flag that is already in the field.
 *
 * The refusals match the protocol servers so a caller meets one rule across
 * every entry point: several organizations and none named is answerable by
 * naming one, and gets 400; belonging to none is not answerable at all, and
 * gets 403.
 */
export async function resolveV1Context(
	apiCtx: ExternalApiContext,
	orgSlug?: string,
	personal?: boolean,
): Promise<V1TenantContext | { error: string; status: 400 | 403 | 404 }> {
	// An organization key names its own tenant, so asking for another context
	// with it is incoherent however it is asked. Kept as it was.
	if (personal && apiCtx.keyType === "organization") {
		return {
			error: "Cannot use personal context with an organization API key",
			status: 403,
		};
	}

	// Org key always scopes to that org.
	if (apiCtx.keyType === "organization" && apiCtx.organizationId) {
		return { userId: apiCtx.userId, organizationId: apiCtx.organizationId };
	}

	// Personal key with an explicit organization: looked up, and membership
	// verified before it is honoured.
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

	// Nothing named — including `?personal=1`, which no longer names anything.
	const resolution = await resolveUserOrganization(apiCtx.userId);

	switch (resolution.kind) {
		case "resolved":
			return {
				userId: apiCtx.userId,
				organizationId: resolution.organizationId,
			};
		case "ambiguous":
			return {
				error: `This key's owner belongs to ${resolution.organizationIds.length} organizations and this request named none. Retry with ?org=<slug>.`,
				status: 400,
			};
		case "no_membership":
			return {
				error: "This key resolves to no organization, because its owner belongs to none. Joining or creating one is the only thing that changes that.",
				status: 403,
			};
	}
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
