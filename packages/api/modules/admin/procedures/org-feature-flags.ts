import { ORPCError } from "@orpc/server";
import {
	clearOrgFlagOverride,
	getOrganizationById,
	getOrgFlagStateUncached,
	getOrgScopableFlagsDetailed,
	recordAuditDurable,
	setOrgFlagOverride,
} from "@repo/database";
import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
	isFeatureFlagKey,
	isOrgScopableFlag,
} from "@repo/utils/feature-flag-registry";
import { z } from "zod";
import { markCuratedAuditWritten } from "../../../orpc/middleware/audit-timing-middleware";
import {
	adminProcedure,
	Permissions,
	requirePermission,
} from "../../../orpc/procedures";

/**
 * Per-organization feature-flag overrides for the instance admin.
 *
 * The sibling `feature-flags.ts` writes the INSTANCE-WIDE row; this file
 * writes the per-organization one that outranks it. Together they are the
 * whole allowlist mechanism: hold the flag off globally, then enable it for
 * named organizations — or leave it on globally and exclude one.
 *
 * Before this existed, an override row could only be created by
 * `packages/database/prisma/seed-publishing-suite-orgs.ts`, which is
 * create-only: enrolling needed a deploy-time script and un-enrolling needed
 * raw SQL. That script's own header names this admin picker as its successor.
 */

/** Shape shared by every response so the UI patches one row consistently. */
const FLAG_STATE = z.object({
	enabled: z.boolean(),
	source: z.enum(["org-override", "override", "env", "default"]),
	/** `null` on the wire for "no row"; the client renders it as "Inherit". */
	orgOverride: z.boolean().nullable(),
});

/**
 * Validate the two things a caller can get wrong about a key, in the order
 * that gives the more specific answer first.
 *
 * The `orgScopable` check is the load-bearing one. `resolveFlag` ignores an
 * org-level value for any flag that does not declare it, so a row written for
 * one is inert: the admin console would show a switch that reads back its own
 * write and changes nothing anywhere else. Rejecting here keeps the write path
 * and the resolver agreeing about which rows can exist.
 */
function assertOrgScopableKey(key: string): asserts key is FeatureFlagKey {
	if (!isFeatureFlagKey(key)) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Unknown feature flag: ${key}`,
		});
	}

	if (!isOrgScopableFlag(key)) {
		throw new ORPCError("BAD_REQUEST", {
			message: `Feature flag ${key} is not organization-scopable; it can only be set for the whole deployment.`,
		});
	}
}

/**
 * Reject an organization id that does not resolve.
 *
 * The row's foreign key would reject it anyway, but as a P2003 surfacing as a
 * 500 long after the audit `before` read. A cheap explicit lookup turns that
 * into the 404 the client can act on.
 */
async function assertOrganizationExists(organizationId: string) {
	const organization = await getOrganizationById(organizationId);
	if (!organization) {
		throw new ORPCError("NOT_FOUND", {
			message: "Organization not found",
		});
	}
}

/**
 * Every org-scopable flag as THIS organization resolves it.
 *
 * Deliberately not the whole registry: a flag the resolver ignores at the org
 * level has no per-organization variant to show, and rendering one would
 * misrepresent what the switch does.
 */
export const listOrgFeatureFlagsProcedure = adminProcedure
	// AUTHORIZATION IS `adminProcedure` — the instance-admin gate. The
	// `requirePermission` decorators in this file are INERT: the builder
	// supplies no tenant context, so the check returns `next()` regardless of
	// role. They are here because permission-coverage.test.ts fails any
	// procedure file without one, and the file is listed in the ACCEPTED map
	// of orpc/__tests__/inert-permission-guard.test.ts with the reason.
	//
	// Do not "fix" this by moving to `requireInputOrgPermission`: the
	// organizationId below is the SUBJECT of the edit, not the caller's
	// tenant, and demanding a role in it would let an operator enrol only the
	// organizations they already belong to.
	.use(requirePermission(Permissions.ORG_SETTINGS_READ))
	.route({
		method: "GET",
		path: "/admin/organizations/{organizationId}/feature-flags",
		tags: ["Admin"],
		summary: "List an organization's feature flags",
		description:
			"List the organization-scopable feature flags with the values this organization resolves and whether each is inherited or overridden.",
	})
	.input(z.object({ organizationId: z.string() }))
	.handler(async ({ input }) => {
		await assertOrganizationExists(input.organizationId);

		const resolved = await getOrgScopableFlagsDetailed(
			input.organizationId,
		);

		return {
			// Registry metadata first so resolved fields always win: a future
			// registry field named `enabled` or `source` must never overwrite
			// the real value shown in the UI.
			flags: resolved.map((flag) => ({
				...FEATURE_FLAG_REGISTRY[flag.key],
				...flag,
				orgOverride: flag.orgOverride ?? null,
			})),
		};
	});

/**
 * Set one flag for one organization — the enrolment (and exclusion) control.
 *
 * `enabled: false` is not a deletion. It stores an explicit exclusion that
 * outranks a globally-enabled flag, which is the only way to hold one
 * organization out of a deployment-wide rollout. `clear` is the inverse.
 */
export const setOrgFeatureFlagProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_SETTINGS_EDIT))
	.route({
		method: "PUT",
		path: "/admin/organizations/{organizationId}/feature-flags/{key}",
		tags: ["Admin"],
		summary: "Set a feature flag for one organization",
		description:
			"Enable or disable a feature flag for a single organization, overriding the deployment-wide value.",
	})
	.input(
		z.object({
			organizationId: z.string(),
			key: z.string(),
			enabled: z.boolean(),
		}),
	)
	.output(FLAG_STATE.extend({ success: z.boolean() }))
	.handler(async ({ input, context: { user } }) => {
		assertOrgScopableKey(input.key);
		await assertOrganizationExists(input.organizationId);

		const before = await getOrgFlagStateUncached(
			input.key,
			input.organizationId,
		);

		await setOrgFlagOverride({
			key: input.key,
			organizationId: input.organizationId,
			enabled: input.enabled,
			updatedBy: user.id,
		});

		// Re-resolve AFTER the write, and UNCACHED on both levels. The panel
		// patches its query cache from this response and never refetches — the
		// web service runs at `replicas: 2` with an independent 10s flag cache
		// each, so a refetch right after a write can land on a replica that has
		// not caught up and visibly flip the control back (#2138). That makes
		// this value the only thing correcting the UI, so it cannot itself come
		// from a cache: an org entry can be refilled by a read that started
		// before the eviction, and the global entry is not evicted by an org
		// write at all.
		const after = await getOrgFlagStateUncached(
			input.key,
			input.organizationId,
		);

		// Durable rather than fire-and-forget. ACCEPTED LIMITATION, same as the
		// instance-wide `set` next door: the override row has already
		// committed, so if this write throws the flag has changed while the
		// client is told the request failed and no audit row exists. Retrying
		// is safe (the upsert is idempotent). Making it atomic needs
		// `recordAuditTx` inside a transaction, which means `setOrgFlagOverride`
		// must accept a `Prisma.TransactionClient` — worth doing for BOTH
		// halves of this control at once, not for one of them.
		//
		// `organizationId` is top-level, not merely in metadata: the
		// organization audit log filters STRICTLY on that column, so a
		// metadata-only reference would hide the change from the very tenant
		// whose features it altered.
		await recordAuditDurable({
			action: "featureFlag.orgUpdated",
			severity: "warning",
			actor: { type: "user", userId: user.id },
			organizationId: input.organizationId,
			resource: { type: "featureFlag", id: input.key },
			metadata: {
				previousValue: before.enabled,
				previousSource: before.source,
				previousOrgOverride: before.orgOverride ?? null,
				newValue: after.enabled,
				newSource: after.source,
			},
		});

		// Tell the activity middleware a curated row already exists for this
		// call, or it appends a second, generic `activity.*` event for every
		// successful mutation — differently scoped, and a breach of its
		// documented no-duplicate contract.
		markCuratedAuditWritten();

		return {
			success: true,
			enabled: after.enabled,
			source: after.source,
			orgOverride: after.orgOverride ?? null,
		};
	});

/**
 * Clear one organization's override, returning it to inheriting the
 * deployment-wide value.
 *
 * The ONLY way back to "inherit" from the UI: `set` always writes a row, so
 * without this an operator who enrolled or excluded an organization could
 * never undo it without raw SQL. Idempotent — clearing an organization that
 * has no row is a harmless no-op.
 */
export const clearOrgFeatureFlagProcedure = adminProcedure
	.use(requirePermission(Permissions.ORG_SETTINGS_EDIT))
	.route({
		method: "DELETE",
		path: "/admin/organizations/{organizationId}/feature-flags/{key}",
		tags: ["Admin"],
		summary: "Clear an organization's feature-flag override",
		description:
			"Delete one organization's feature-flag override so it inherits the deployment-wide value again.",
	})
	.input(z.object({ organizationId: z.string(), key: z.string() }))
	.output(FLAG_STATE.extend({ success: z.boolean() }))
	.handler(async ({ input, context: { user } }) => {
		assertOrgScopableKey(input.key);
		await assertOrganizationExists(input.organizationId);

		const before = await getOrgFlagStateUncached(
			input.key,
			input.organizationId,
		);

		await clearOrgFlagOverride({
			key: input.key,
			organizationId: input.organizationId,
		});

		// Uncached for the same reason `set` is, and here it matters more: the
		// post-clear source is decided by the GLOBAL row, which an org write
		// never evicts, so a cached read could report "env" for a flag an
		// instance admin turned off seconds ago on another replica.
		const after = await getOrgFlagStateUncached(
			input.key,
			input.organizationId,
		);

		// Same accepted atomicity limitation and same top-level
		// `organizationId` reasoning as `set` above.
		await recordAuditDurable({
			action: "featureFlag.orgReset",
			severity: "warning",
			actor: { type: "user", userId: user.id },
			organizationId: input.organizationId,
			resource: { type: "featureFlag", id: input.key },
			metadata: {
				previousValue: before.enabled,
				previousSource: before.source,
				previousOrgOverride: before.orgOverride ?? null,
				newValue: after.enabled,
				newSource: after.source,
			},
		});

		markCuratedAuditWritten();

		return {
			success: true,
			enabled: after.enabled,
			source: after.source,
			orgOverride: after.orgOverride ?? null,
		};
	});
