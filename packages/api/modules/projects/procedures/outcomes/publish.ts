import { randomBytes } from "node:crypto";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { buildOutcomesShareUrl } from "../../../outcomes/lib/customer-outcomes";

function generateOutcomesShareToken(): string {
	return randomBytes(32).toString("base64url");
}

/**
 * AUTHORIZATION: `requireProjectPermission(PROJECT_GOVERNANCE_MANAGE)` —
 * project OWNER, org owner/admin. Publishing hands a capability URL to an
 * audience outside the tenant, so editors cannot do it.
 *
 * Idempotent: an already-published project keeps its token so shared links
 * stay valid; call `revoke` then `publish` to rotate.
 */
export const publishOutcomesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_GOVERNANCE_MANAGE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/outcomes/publish",
		tags: ["Projects", "Outcomes"],
		summary: "Publish customer outcomes page",
		description:
			"Create (or keep) the token-scoped customer outcomes link for this project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		const existing = await db.project.findUnique({
			where: { id: input.projectId },
			select: { outcomesShareToken: true },
		});
		let token = existing?.outcomesShareToken ?? null;
		if (!token) {
			token = generateOutcomesShareToken();
			await db.project.update({
				where: { id: input.projectId },
				data: { outcomesShareToken: token },
				select: { id: true },
			});
		}
		return {
			published: true as const,
			shareUrl: buildOutcomesShareUrl(token),
		};
	});
