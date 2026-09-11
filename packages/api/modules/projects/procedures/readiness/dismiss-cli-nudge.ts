import { ORPCError } from "@orpc/server";
import { db, isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { gatherReadinessEvidence } from "../../lib/readiness/evidence";

/**
 * Record that this person has declined the CLI-connection prompt (Fizzy #2457,
 * R5).
 *
 * **Per organization, not per project.** The fact the prompt reports — whether
 * anybody has a CLI reaching Fabric — is organization-shaped, so the decline
 * that answers it has to be too. One "no" answers the question across the
 * tenant's whole portfolio; otherwise a member of a ten-project organization
 * would be asked the same question ten times and the prompt would become the
 * interruption it was designed not to be. That is why the row's key is
 * `(organizationId, userId)` with no project in it, and why dismissing here
 * silences the prompt on a project this person has never opened.
 *
 * **Permanent, and the checklist row is what makes that safe.** Nothing clears
 * this. The reminder is not lost with it: the "API Key for CLI" readiness row
 * stays in the panel either way, so only the interruption is spent.
 *
 * **Called on the dismiss action ONLY, never on render.** The neighbouring
 * attention marker records the same discipline for the same reason: a marker
 * that clears itself without anyone acting teaches the reader to distrust the
 * next one. The prompt's own render is not an answer to it.
 *
 * The organization comes from the evidence gatherer — the project's own tenant
 * columns — and never from caller input. Pairing a project you may read with an
 * organization you may not is how a cross-tenant write gets in, and the row
 * this writes is keyed on nothing but the organization and the caller.
 *
 * No audit row: a per-person interface preference is not a security event, and
 * the closed set of audit actions is not the place to record one.
 *
 * The rollout gate is deliberately NOT consulted here. Readiness is, because
 * with readiness off the prompt has no payload to ride on and this would be
 * recording an answer to a question nobody was asked. `CLI_CONNECTION_NUDGE` is
 * a different kind of switch — it decides where the surfaces exist during a
 * per-organization rollout — and a decline given while it was on stays valid
 * however the rollout moves afterwards.
 */
export const dismissCliNudgeProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "POST",
		path: "/projects/{projectId}/readiness/dismiss-cli-nudge",
		tags: ["Projects", "Readiness"],
		summary: "Dismiss the CLI connection prompt",
		description:
			"Records that the caller has declined the CLI connection prompt for the project's organization. Permanent, and it applies to every project of that organization.",
	})
	.input(
		z.object({
			projectId: z.string(),
			/**
			 * Accepted for shape-consistency with the rest of the readiness
			 * namespace and ignored: the organization written below is the
			 * project's own, resolved server-side.
			 */
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ ok: z.literal(true) }))
	.handler(async ({ input, context }) => {
		if (!(await isFeatureEnabled("PROJECT_READINESS"))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Project readiness is not enabled.",
			});
		}

		const gathered = await gatherReadinessEvidence(input.projectId);
		if (!gathered) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found." });
		}

		const { organizationId } = gathered.tenant;
		if (!organizationId) {
			// Fail closed. Every account has an organization, so a project
			// without one means something upstream failed to resolve a tenant
			// — a defect, not a context to support (ADR 018). There is also
			// nothing to write: the dismissal is keyed on an organization, and
			// the prompt cannot render for such a project anyway, since
			// eligibility needs an organization role.
			throw new ORPCError("NOT_FOUND", {
				message: "This project has no organization.",
			});
		}

		// Upserting rather than creating: the row is the answer's home, and the
		// timestamp — not the row's existence — carries the answer, so a row
		// already sitting there with a null `dismissedAt` still reads as NOT
		// dismissed and must be stamped. That is also why the update writes the
		// timestamp unconditionally instead of leaving an existing one alone. A
		// second dismissal is therefore idempotent in the way that matters:
		// still one row, still dismissed, no error.
		const dismissedAt = new Date();
		await db.cliConnectionPromptDismissal.upsert({
			where: {
				organizationId_userId: {
					organizationId,
					userId: context.user.id,
				},
			},
			create: { organizationId, userId: context.user.id, dismissedAt },
			update: { dismissedAt },
		});

		return { ok: true as const };
	});
