/**
 * `audit.apiKeys.revoke` — flip `isActive=false` on an audit-log API
 * key, immediately invalidating it for the public REST API.
 *
 * The row is NOT hard-deleted so the audit trail of past usage
 * (`lastUsedAt`, `usageCount`, and the `audit.api_request` rows
 * referencing the prefix) remains intact for forensics.
 *
 * Emits `account.api_key.revoked` (personal) or `org.api_key.revoked`
 * (org).
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { protectedProcedure } from "../../../../orpc/procedures";
import { resolveAuditApiKeyTenant } from "./list";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	id: z.string().min(1),
});

const outputSchema = z.object({
	id: z.string(),
	revoked: z.boolean(),
});

export const revokeAuditApiKeyProcedure = protectedProcedure
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const tenant = await resolveAuditApiKeyTenant(
			context,
			input.organizationId,
		);

		if (tenant.kind === "user") {
			const existing = await db.userApiKey.findFirst({
				where: { id: input.id, userId: tenant.userId },
				select: { id: true, name: true, scopes: true, keyPrefix: true },
			});
			if (!existing) {
				throw new ORPCError("NOT_FOUND", {
					message: "API key not found",
				});
			}

			await db.userApiKey.update({
				where: { id: existing.id },
				data: { isActive: false },
			});

			recordAuditFromRequest(context, {
				action: "account.api_key.revoked",
				category: "account",
				outcome: "success",
				severity: "info",
				resource: {
					type: "api_key",
					id: existing.id,
					name: existing.name,
				},
				metadata: {
					scopes: existing.scopes,
					keyPrefix: existing.keyPrefix,
				},
			});

			return { id: existing.id, revoked: true };
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

		await db.organizationApiKey.update({
			where: { id: existing.id },
			data: { isActive: false },
		});

		recordAuditFromRequest(context, {
			action: "org.api_key.revoked",
			category: "org",
			organizationId: tenant.orgId,
			outcome: "success",
			severity: "info",
			resource: {
				type: "api_key",
				id: existing.id,
				name: existing.name,
			},
			metadata: {
				scopes: existing.scopes,
				keyPrefix: existing.keyPrefix,
			},
		});

		return { id: existing.id, revoked: true };
	});
