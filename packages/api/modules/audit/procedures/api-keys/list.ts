/**
 * `audit.apiKeys.list` — list audit-log API keys for the caller's
 * tenant context.
 *
 *   - Personal (organizationId null/undefined): returns the caller's
 *     own `UserApiKey` rows whose scopes include `audit_log:read` OR
 *     `audit_log:export`.
 *   - Organization: returns the org's `OrganizationApiKey` rows with
 *     the same scope filter. Owner/admin only (mirrors the wider
 *     audit-log read permission gate).
 *
 * Raw key values are NEVER returned — the database only stores the
 * SHA-256 hash. Callers see prefix, name, scopes, expiration, last-used,
 * and active state.
 */

import { ORPCError } from "@orpc/server";
import {
	getOrganizationMembership,
	listOrganizationApiKeys,
	listUserApiKeys,
} from "@repo/database";
import { z } from "zod";
import { ALL_OBSERVABILITY_SCOPES } from "../../../../lib/observability-scopes";
import {
	protectedProcedure,
	resolveOrganizationId,
} from "../../../../orpc/procedures";

/**
 * Does a key's scope array include any read-only observability scope (or the
 * wildcard)?
 *
 * Widened alongside the create surface: a key minted from this drawer for
 * platform status alone must still be listed and revocable here, or it would
 * become invisible to the customer who created it.
 */
function isAuditScoped(scopes: readonly string[]): boolean {
	if (scopes.includes("*")) return true;
	return ALL_OBSERVABILITY_SCOPES.some((scope) => scopes.includes(scope));
}

const auditApiKeyShape = z.object({
	id: z.string(),
	name: z.string(),
	keyPrefix: z.string(),
	scopes: z.array(z.string()),
	expiresAt: z.coerce.date().nullable(),
	lastUsedAt: z.coerce.date().nullable(),
	usageCount: z.number().int().nonnegative(),
	isActive: z.boolean(),
	createdAt: z.coerce.date(),
	createdByEmail: z.string().nullable(),
});

export const listAuditApiKeysProcedure = protectedProcedure
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.array(auditApiKeyShape))
	.handler(async ({ input, context }) => {
		const orgId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Personal context — list the caller's own keys.
		if (input.organizationId === null || !orgId) {
			const keys = await listUserApiKeys({
				userId: context.user.id,
				includeInactive: true,
			});
			return keys
				.filter((k) => isAuditScoped(k.scopes))
				.map((k) => ({
					id: k.id,
					name: k.name,
					keyPrefix: k.keyPrefix,
					scopes: k.scopes,
					expiresAt: k.expiresAt,
					lastUsedAt: k.lastUsedAt,
					usageCount: k.usageCount,
					isActive: k.isActive,
					createdAt: k.createdAt,
					createdByEmail: context.user.email,
				}));
		}

		// Org context — check membership (owner/admin).
		const resolvedOrgId: string = orgId;
		const membership = await getOrganizationMembership(
			resolvedOrgId,
			context.user.id,
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be a member of this organization",
			});
		}
		if (membership.role !== "owner" && membership.role !== "admin") {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can manage audit-log API keys",
			});
		}

		const keys = await listOrganizationApiKeys({
			organizationId: resolvedOrgId,
			includeInactive: true,
		});

		return keys
			.filter((k) => isAuditScoped(k.scopes))
			.map((k) => ({
				id: k.id,
				name: k.name,
				keyPrefix: k.keyPrefix,
				scopes: k.scopes,
				expiresAt: k.expiresAt,
				lastUsedAt: k.lastUsedAt,
				usageCount: k.usageCount,
				isActive: k.isActive,
				createdAt: k.createdAt,
				createdByEmail: k.createdBy.email,
			}));
	});

/**
 * Convenience helper used by `rotate` + `revoke` to resolve the
 * tenant context once. Centralised here so the membership/permission
 * check is identical across the three write procedures.
 */
export async function resolveAuditApiKeyTenant(
	context: {
		user: { id: string; email: string };
		session: { activeOrganizationId?: string | null };
	},
	organizationId: string | null | undefined,
): Promise<{ kind: "user"; userId: string } | { kind: "org"; orgId: string }> {
	if (organizationId === null || organizationId === undefined) {
		return { kind: "user", userId: context.user.id };
	}
	const orgId = resolveOrganizationId(organizationId, context.session);
	if (!orgId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "Organization could not be resolved",
		});
	}
	const membership = await getOrganizationMembership(orgId, context.user.id);
	if (!membership) {
		throw new ORPCError("FORBIDDEN", {
			message: "You must be a member of this organization",
		});
	}
	if (membership.role !== "owner" && membership.role !== "admin") {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Only organization owners and admins can manage audit-log API keys",
		});
	}
	return { kind: "org", orgId };
}
