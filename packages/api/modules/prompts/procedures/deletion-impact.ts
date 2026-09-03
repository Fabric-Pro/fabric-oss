import { ORPCError } from "@orpc/server";
import {
	getPlatformWidePromptDeletionImpact,
	getPromptById,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../lib/audit";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { assertPromptDeleteAuthority } from "../lib/scope-authority";

/**
 * What deleting a SYSTEM prompt would remove, across every tenant.
 *
 * This is the only door to `getPlatformWidePromptDeletionImpact`, which carries
 * no tenant predicate at all: a SYSTEM prompt's versions can be bound by any
 * organization and any individual, so an impact built from the ordinary
 * tenant-scoped read would report zero while the cascade removed several.
 * Reaching it is therefore a privileged act, and this procedure exists to put
 * exactly the deletion's own authority in front of it — nothing wider.
 *
 * THREE gates, and the second one is easy to mistake for redundant:
 *
 *  1. `requirePermission(PROMPT_DELETE)` — the same middleware the delete
 *     procedure carries, evaluated against the caller's ACTIVE ORGANIZATION
 *     role.
 *  2. An organization context must exist. Gate 1 returns `next()` without
 *     evaluating any role when `tenantContext` is absent or personal, so on its
 *     own it would wave a global admin with no active organization through to a
 *     cross-tenant read on the strength of gate 3 alone. Under
 *     `docs/adr/018-organization-is-the-only-tenant-context.md` a session with
 *     no organization means resolution FAILED, and a platform-wide read is not
 *     a capability worth offering from that state. `requireInputOrgPermission`
 *     solves the same problem with its `requireOrganization` option; this
 *     procedure takes no organization in its input, so it asks directly.
 *  3. The per-scope authority the deletion requires, shared with `delete.ts`
 *     via `assertPromptDeleteAuthority` rather than copied.
 *
 * And the read is SYSTEM-only. An ORG or USER prompt is refused before the
 * query runs even when the caller could legitimately delete it: the un-scoped
 * traversal is justified by the platform-operator role and nothing else, and a
 * single-tenant prompt has no cross-tenant impact to report.
 *
 * The figures are a SNAPSHOT, not a promise. A binding written between this
 * read and the deletion is not in them, which is why the deletion reports its
 * own totals rather than replaying these (R15). No caller may present this as a
 * guarantee about the moment of deletion.
 *
 * Returns counts and display labels only — no organization id, no user id,
 * nothing that lets an operator name a tenant or a person (R6).
 */
export const deletionImpactProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.PROMPT_DELETE))
	.route({
		method: "GET",
		path: "/prompts/:id/deletion-impact",
		tags: ["Prompts"],
		summary: "Preview what deleting a system prompt would remove",
		description:
			"Platform-wide, tenant-unscoped impact of deleting a SYSTEM prompt. Requires the deletion's own authority. Counts only — never identifies an organization or a person.",
	})
	.input(
		z.object({
			id: z.string(),
		}),
	)
	.output(
		z.object({
			promptRowCount: z.number(),
			bindingCount: z.number(),
			organizationCount: z.number(),
			personalOverrideUserCount: z.number(),
			documentTypeLabels: z.array(z.string()),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;

		// Gate 2 — see the doc-comment. This runs FIRST: a caller with no
		// organization has no business learning that a prompt id exists.
		const tenantContext = context.tenantContext;
		if (
			!tenantContext ||
			tenantContext.type !== "organization" ||
			!tenantContext.organizationId
		) {
			throw new ORPCError("FORBIDDEN", {
				message: "This operation requires an organization context",
			});
		}

		// Un-scoped by design, exactly as the delete handler reads it: the
		// per-scope check below is what decides access, not the read.
		const existing = await getPromptById(input.id);

		if (!existing) {
			throw new ORPCError("NOT_FOUND", {
				message: "Prompt not found",
			});
		}

		// Gate 3, shared with the deletion itself.
		await assertPromptDeleteAuthority(existing, user);

		if (existing.scope !== "SYSTEM") {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"A deletion impact is only reported for system prompts",
			});
		}

		try {
			const impact = await getPlatformWidePromptDeletionImpact({
				promptId: input.id,
			});

			if (!impact) {
				// The prompt was there a moment ago and is not now. Reporting
				// zero counts would present someone else's completed deletion
				// as "this removes nothing".
				throw new ORPCError("NOT_FOUND", {
					message: "Prompt not found",
				});
			}

			// Automatic activity capture drops GET-shaped routes
			// (`isCapturableMethod`), so without this emission the one
			// un-scoped cross-tenant read in this module would leave no trace
			// at all (R12). Category is explicitly "audit" — the same forensic
			// bucket as `audit.viewed` and `userActivity.viewed`, both of which
			// record a privileged READ rather than a change.
			recordAuditFromRequest(context, {
				action: "prompt.deletion_impact_viewed",
				category: "audit",
				organizationId: tenantContext.organizationId,
				resource: {
					type: "prompt",
					id: existing.id,
					name: existing.name ?? null,
				},
				metadata: {
					promptKey: existing.key,
					promptRowCount: impact.promptRowCount,
					bindingCount: impact.bindingCount,
					organizationCount: impact.organizationCount,
					personalOverrideUserCount: impact.personalOverrideUserCount,
					// The labels themselves, not just their number: "which
					// document types stop having a default" is the figure an
					// operator reviewing the decision afterwards asks for.
					documentTypeCount: impact.documentTypeLabels.length,
					documentTypes: impact.documentTypeLabels,
				},
			});

			return impact;
		} catch (error) {
			if (error instanceof ORPCError) {
				throw error;
			}
			const message =
				error instanceof Error ? error.message : String(error);
			const stack = error instanceof Error ? error.stack : undefined;
			logger.error(
				"[prompts.deletionImpact] Error computing deletion impact",
				{
					promptId: input.id,
					userId: user.id,
					error: message,
					stack,
				},
			);
			if (process.env.NODE_ENV === "development") {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to compute deletion impact: ${message}`,
				});
			}
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to compute deletion impact",
			});
		}
	});
