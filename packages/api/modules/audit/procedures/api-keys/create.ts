/**
 * `audit.apiKeys.create` — mint a new audit-log API key.
 *
 * Personal scope (`organizationId: null`): creates a `UserApiKey` owned
 * by the caller.
 * Org scope: creates an `OrganizationApiKey` for the resolved org.
 * Owner/admin only.
 *
 * The raw key is returned ONCE. It is never re-derivable from storage —
 * only the SHA-256 hash is persisted. The UI must show the value to the
 * user immediately and warn that it cannot be retrieved later.
 *
 * Emits `account.api_key.created` (personal) or `org.api_key.created`
 * (org) per the audit-log taxonomy.
 */

import { ORPCError } from "@orpc/server";
import { createOrganizationApiKey, createUserApiKey } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { OBSERVABILITY_SCOPES } from "../../../../lib/observability-scopes";
import { protectedProcedure } from "../../../../orpc/procedures";
import { AUDIT_LOG_SCOPES } from "../../rest/verify-audit-key";
import { generateApiKey } from "./generate";
import { resolveAuditApiKeyTenant } from "./list";

/**
 * Scopes mintable from the audit-log settings drawer.
 *
 * Now the whole read-only observability set, not just the audit-log pair: the
 * drawer is where a customer provisions a key for an external monitor, and that
 * monitor usually wants platform status alongside the trail. Every scope here is
 * read-only, so widening the drawer cannot grant a write.
 */
const AUDIT_KEY_SCOPES = [
	AUDIT_LOG_SCOPES.READ,
	AUDIT_LOG_SCOPES.EXPORT,
	OBSERVABILITY_SCOPES.SYSTEM_HEALTH_READ,
	OBSERVABILITY_SCOPES.STATUS_UPDATES_READ,
] as const;

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(100, "Name too long"),
	scopes: z
		.array(z.enum(AUDIT_KEY_SCOPES))
		.min(1, "At least one scope is required"),
	/**
	 * Days until expiration. `null` means "never expires" — the create
	 * dialog warns the user when they pick this. Anything between 1 and
	 * 730 days (≈2 years) is accepted; 730 is a sane upper bound that
	 * encourages periodic rotation.
	 */
	expiresInDays: z.number().int().min(1).max(730).nullable(),
});

const outputSchema = z.object({
	id: z.string(),
	name: z.string(),
	keyPrefix: z.string(),
	rawKey: z.string(),
	scopes: z.array(z.string()),
	expiresAt: z.coerce.date().nullable(),
	createdAt: z.coerce.date(),
});

export const createAuditApiKeyProcedure = protectedProcedure
	.input(inputSchema)
	.output(outputSchema)
	.handler(async ({ input, context }) => {
		const tenant = await resolveAuditApiKeyTenant(
			context,
			input.organizationId,
		);
		const expiresAt = input.expiresInDays
			? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
			: undefined;

		if (tenant.kind === "user") {
			const { rawKey, keyHash, keyPrefix } = generateApiKey("fab");
			let created;
			try {
				created = await createUserApiKey({
					userId: tenant.userId,
					name: input.name,
					keyHash,
					keyPrefix,
					scopes: input.scopes,
					expiresAt,
				});
			} catch (err) {
				// Surface the prisma duplicate-keyHash collision (a 1-in-2^256
				// chance, but a flaky RNG would also land here) as a
				// retryable BAD_REQUEST rather than a 500.
				if (
					err &&
					typeof err === "object" &&
					"code" in err &&
					(err as { code: unknown }).code === "P2002"
				) {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message:
							"Key generation collision — retry the request.",
					});
				}
				throw err;
			}

			recordAuditFromRequest(context, {
				action: "account.api_key.created",
				category: "account",
				outcome: "success",
				severity: "info",
				resource: {
					type: "api_key",
					id: created.id,
					name: created.name,
				},
				metadata: {
					scopes: created.scopes,
					expiresAt: created.expiresAt?.toISOString() ?? null,
					keyPrefix: created.keyPrefix,
				},
			});

			return {
				id: created.id,
				name: created.name,
				keyPrefix: created.keyPrefix,
				rawKey,
				scopes: created.scopes,
				expiresAt: created.expiresAt,
				createdAt: created.createdAt,
			};
		}

		// org tenant
		const { rawKey, keyHash, keyPrefix } = generateApiKey("org");
		const created = await createOrganizationApiKey({
			organizationId: tenant.orgId,
			createdByUserId: context.user.id,
			name: input.name,
			keyHash,
			keyPrefix,
			scopes: input.scopes,
			expiresAt,
		});

		recordAuditFromRequest(context, {
			action: "org.api_key.created",
			category: "org",
			organizationId: tenant.orgId,
			outcome: "success",
			severity: "info",
			resource: {
				type: "api_key",
				id: created.id,
				name: created.name,
			},
			metadata: {
				scopes: created.scopes,
				expiresAt: created.expiresAt?.toISOString() ?? null,
				keyPrefix: created.keyPrefix,
			},
		});

		return {
			id: created.id,
			name: created.name,
			keyPrefix: created.keyPrefix,
			rawKey,
			scopes: created.scopes,
			expiresAt: created.expiresAt,
			createdAt: created.createdAt,
		};
	});
