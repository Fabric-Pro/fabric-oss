import { ORPCError } from "@orpc/server";
import {
	clearFlagOverride,
	getAllFlagsDetailed,
	recordAuditDurable,
	setFlagOverride,
} from "@repo/database";
import {
	FEATURE_FLAG_REGISTRY,
	isFeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { z } from "zod";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * List every UI-editable flag with its resolved value and where that value
 * came from. `source` is load-bearing for the UI: an admin needs to
 * distinguish an explicit override from an inherited env-var or default.
 *
 * AUTHORIZATION: instance admin only (adminProcedure). Flags are global, not
 * tenant-scoped.
 */
export const listFeatureFlagsProcedure = adminProcedure
	// `adminProcedure` already gates on the instance-admin role. The explicit
	// permission decorator is additionally REQUIRED by packages/api/__tests__/
	// permission-coverage.test.ts, which fails any procedure file lacking one.
	// ORG_SETTINGS_* is the closest existing key; the same org-scoped-name /
	// global-procedure mismatch already exists in list-users.ts (ORG_READ).
	.use(requirePermission(Permissions.ORG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/admin/feature-flags",
		tags: ["Admin"],
		summary: "List feature flags",
		description:
			"List UI-editable feature flags with their resolved values and resolution source.",
	})
	.input(z.object({}))
	.handler(async () => {
		const resolved = await getAllFlagsDetailed();

		return {
			// Resolved values (`enabled`, `source`) must win over registry
			// metadata: registry fields are spread first so a future
			// registry field accidentally named `enabled` or `source` can
			// never silently overwrite the real resolved value shown in
			// the UI.
			flags: resolved.map((flag) => ({
				...FEATURE_FLAG_REGISTRY[flag.key],
				...flag,
			})),
		};
	});

/**
 * Flip one flag globally.
 *
 * The key is validated against the registry rather than trusted from input:
 * the override table must never hold a row for a flag that no longer exists,
 * since such a row is silently ignored on read (see `getFlagOverrides`) and
 * would look like a working toggle to whoever set it.
 */
export const setFeatureFlagProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/admin/feature-flags/{key}",
		tags: ["Admin"],
		summary: "Set a feature flag",
		description:
			"Enable or disable a feature flag for the whole deployment.",
	})
	.input(z.object({ key: z.string(), enabled: z.boolean() }))
	.output(z.object({ success: z.boolean(), enabled: z.boolean() }))
	.handler(async ({ input, context: { user } }) => {
		if (!isFeatureFlagKey(input.key)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown feature flag: ${input.key}`,
			});
		}

		const before = (await getAllFlagsDetailed()).find(
			(f) => f.key === input.key,
		);

		await setFlagOverride({
			key: input.key,
			enabled: input.enabled,
			updatedBy: user.id,
		});

		// Durable rather than fire-and-forget so a caller awaiting this
		// handler observes the audit write's outcome. This does NOT make the
		// change atomic: `setFlagOverride` above already committed, so if
		// this write throws, the flag has changed but the client is told the
		// request failed and the audit row is missing. `recordAuditTx`
		// (packages/database/prisma/queries/audit-log.ts) exists for
		// mutations that must not happen at all if the audit row can't be
		// persisted, by writing both inside the same transaction — using it
		// here would require `setFlagOverride` to accept a
		// `Prisma.TransactionClient`, which is out of scope for this change.
		await recordAuditDurable({
			action: "featureFlag.updated",
			severity: "warning",
			actor: { type: "user", userId: user.id },
			resource: { type: "featureFlag", id: input.key },
			metadata: {
				previousValue: before?.enabled ?? null,
				previousSource: before?.source ?? null,
				newValue: input.enabled,
			},
		});

		return { success: true, enabled: input.enabled };
	});

/**
 * Clear a flag's override, returning it to its env/registry-resolved default.
 *
 * This is the inverse of `set` and the ONLY way to move a flag's source back to
 * "env"/"default" from the UI: `set` always writes a row (source stays
 * "override"), so without this an admin could never undo a toggle to its
 * inherited value — cleanup would require raw SQL. `clearFlagOverride` is
 * idempotent, so resetting an already-default flag is a harmless no-op.
 */
export const resetFeatureFlagProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_SETTINGS_EDIT))
	.route({
		method: "DELETE",
		path: "/admin/feature-flags/{key}",
		tags: ["Admin"],
		summary: "Reset a feature flag to its default",
		description:
			"Delete a feature flag's override, returning it to its environment/registry-resolved value.",
	})
	.input(z.object({ key: z.string() }))
	.output(
		z.object({
			success: z.boolean(),
			enabled: z.boolean(),
			source: z.enum(["override", "env", "default"]),
		}),
	)
	.handler(async ({ input, context: { user } }) => {
		if (!isFeatureFlagKey(input.key)) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Unknown feature flag: ${input.key}`,
			});
		}

		const before = (await getAllFlagsDetailed()).find(
			(f) => f.key === input.key,
		);

		await clearFlagOverride(input.key);

		// Re-resolve AFTER the clear (clearFlagOverride busts the cache) so the
		// caller gets the authoritative post-reset value and source to patch
		// its UI with — mirroring how the panel patches from `set`'s result
		// rather than refetching, which on multi-replica deployments can race a
		// stale replica and flip the row back (see #2138 final review).
		const after = (await getAllFlagsDetailed()).find(
			(f) => f.key === input.key,
		);

		// Same durability/atomicity note as `set`: the delete has already
		// committed, so a failed audit write reports failure for a change that
		// happened. Recorded as a distinct `featureFlag.reset` action so the
		// trail shows an override being cleared, not merely toggled.
		await recordAuditDurable({
			action: "featureFlag.reset",
			severity: "warning",
			actor: { type: "user", userId: user.id },
			resource: { type: "featureFlag", id: input.key },
			metadata: {
				previousValue: before?.enabled ?? null,
				previousSource: before?.source ?? null,
				newValue: after?.enabled ?? null,
				newSource: after?.source ?? null,
			},
		});

		return {
			success: true,
			enabled: after?.enabled ?? false,
			source: after?.source ?? "default",
		};
	});
