import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * What deleting this organization would destroy (Fizzy #2462, AC-2).
 *
 * Shown in the confirmation dialog so the warning names real quantities rather
 * than saying "everything". The acceptance criteria call this a "platform-wide
 * impact check", a phrase carried over from the prompt-deletion surface where it
 * genuinely means platform-wide; for an organization the honest reading is
 * "everything in this organization, for everyone in it", which is what these
 * counts are.
 *
 * DELIBERATELY ADVISORY. These numbers inform the decision; they do not gate it.
 * The caller renders the dialog without them if this rejects — see the note on
 * the client — because a failed count must never trap someone inside an
 * organization they want gone.
 *
 * Gated on `ORG_DELETE` rather than a read permission: the counts describe a
 * destructive action, and only the people who could take that action have a
 * reason to see them.
 */
export const organizationDeletionImpactProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.ORG_DELETE))
	.route({
		method: "GET",
		path: "/organizations/deletion-impact",
		tags: ["Organizations"],
		summary: "Summarise what deleting this organization would remove",
	})
	.input(z.object({}).optional())
	.handler(async ({ context }) => {
		// The organization is the session's, never the caller's to name — a
		// caller-supplied id here would let someone count another tenant's rows.
		const organizationId = resolveOrganizationId(undefined, context.session);

		if (!organizationId) {
			return {
				projects: 0,
				members: 0,
				documents: 0,
				contexts: 0,
			};
		}

		const [projects, members, documents, contexts] = await Promise.all([
			db.project.count({ where: { organizationId, deletedAt: null } }),
			db.member.count({ where: { organizationId } }),
			db.projectDocument.count({
				where: { project: { organizationId, deletedAt: null } },
			}),
			db.projectContext.count({
				where: { project: { organizationId, deletedAt: null } },
			}),
		]);

		return { projects, members, documents, contexts };
	});
