/**
 * `audit.apiKeys.rotate` — replace a key's hash/prefix with a fresh
 * value, returning the new raw key once.
 *
 * The old value stops working IMMEDIATELY after the update commits.
 * Scopes, name, and expiration are preserved as-is (the operator can
 * adjust them via revoke + create if they want a clean break).
 *
 * Emits `account.api_key.rotated` (personal) or `org.api_key.rotated`
 * (org).
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { protectedProcedure } from "../../../../orpc/procedures";
import { generateApiKey } from "./generate";
import { resolveAuditApiKeyTenant } from "./list";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	id: z.string().min(1),
});

const outputSchema = z.object({
	id: z.string(),
	keyPrefix: z.string(),
	rawKey: z.string(),
	rotatedAt: z.coerce.date(),
});

export const rotateAuditApiKeyProcedure = protectedProcedure
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const tenant = await resolveAuditApiKeyTenant(
			context,
			input.organizationId,
		);

		if (tenant.kind === "user") {
			// Confirm the key belongs to the caller before we burn entropy
			// on a new value.
			const existing = await db.userApiKey.findFirst({
				where: { id: input.id, userId: tenant.userId },
				select: { id: true, name: true, scopes: true, keyPrefix: true },
			});
			if (!existing) {
				throw new ORPCError("NOT_FOUND", {
					message: "API key not found",
				});
			}

			const { rawKey, keyHash, keyPrefix } = generateApiKey("fab");
			const updated = await db.userApiKey.update({
				where: { id: existing.id },
				data: { keyHash, keyPrefix, lastUsedAt: null, isActive: true },
			});

			recordAuditFromRequest(context, {
				action: "account.api_key.rotated",
				category: "account",
				outcome: "success",
				severity: "info",
				resource: {
					type: "api_key",
					id: updated.id,
					name: updated.name,
				},
				metadata: {
					scopes: updated.scopes,
					previousKeyPrefix: existing.keyPrefix,
					newKeyPrefix: updated.keyPrefix,
				},
			});

			return {
				id: updated.id,
				keyPrefix: updated.keyPrefix,
				rawKey,
				rotatedAt: new Date(),
			};
		}

		// org tenant
		const existing = await db.organizationApiKey.findFirst({
			where: { id: input.id, organizationId: tenant.orgId },
			select: { id: true, name: true, scopes: true, keyPrefix: true },
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "API key not found",
			});
		}

		const { rawKey, keyHash, keyPrefix } = generateApiKey("org");
		const updated = await db.organizationApiKey.update({
			where: { id: existing.id },
			data: { keyHash, keyPrefix, lastUsedAt: null, isActive: true },
		});

		recordAuditFromRequest(context, {
			action: "org.api_key.rotated",
			category: "org",
			organizationId: tenant.orgId,
			outcome: "success",
			severity: "info",
			resource: {
				type: "api_key",
				id: updated.id,
				name: updated.name,
			},
			metadata: {
				scopes: updated.scopes,
				previousKeyPrefix: existing.keyPrefix,
				newKeyPrefix: updated.keyPrefix,
			},
		});

		return {
			id: updated.id,
			keyPrefix: updated.keyPrefix,
			rawKey,
			rotatedAt: new Date(),
		};
	});
