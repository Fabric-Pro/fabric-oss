/**
 * `audit.searchMembers` — typeahead search over the caller's organization
 * members, for the audit-log "Actor" filter combobox.
 *
 * Authorization: same gate as `audit.list` — the caller must be an
 * org owner/admin OR a deployment admin (env-list bypass). Personal
 * context calls always return an empty list because the personal viewer
 * never shows the actor combobox.
 *
 * Defense in depth: the SQL query is constrained to
 * `Member.organizationId = input.organizationId`, so even if the gate
 * were bypassed, no cross-org member would be returned. The result is
 * capped at 50 rows.
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import { db } from "@repo/database";
import { z } from "zod";
import { requireAuditLogReadOrDeploymentAdmin } from "../../../orpc/middleware/require-audit-log-read";
import { protectedProcedure } from "../../../orpc/procedures";

const inputSchema = z.object({
	organizationId: z.string().nullable().optional(),
	query: z.string().optional().default(""),
	limit: z.number().int().min(1).max(50).optional().default(20),
});

const outputSchema = z.object({
	members: z.array(
		z.object({
			id: z.string(),
			name: z.string().nullable(),
			email: z.string(),
			image: z.string().nullable(),
			role: z.string(),
		}),
	),
});

export const searchAuditActorMembersProcedure = protectedProcedure
	.input(inputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/search-members",
		tags: ["Audit"],
		summary: "Search org members for the audit-log actor filter",
		description:
			"Typeahead search over the caller's organization members. Returns up to 50 rows. Personal-context calls return an empty list.",
	})
	.output(outputSchema)
	.handler(async ({ input }) => {
		// Personal-context calls never show the combobox — short-circuit
		// even if a client somehow invoked the procedure.
		if (!input.organizationId) {
			return { members: [] };
		}

		const trimmed = (input.query ?? "").trim();

		const members = await db.member.findMany({
			where: {
				// Hard tenant clamp — even if the gate let an attacker through,
				// they could never read a different org's members from here.
				organizationId: input.organizationId,
				...(trimmed
					? {
							OR: [
								{
									user: {
										name: {
											contains: trimmed,
											mode: "insensitive",
										},
									},
								},
								{
									user: {
										email: {
											contains: trimmed,
											mode: "insensitive",
										},
									},
								},
							],
						}
					: {}),
			},
			take: input.limit ?? 20,
			orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }],
			include: {
				user: {
					select: {
						id: true,
						name: true,
						email: true,
						image: true,
					},
				},
			},
		});

		return {
			members: members.map((member) => ({
				id: member.user.id,
				name: member.user.name,
				email: member.user.email,
				image: member.user.image,
				role: member.role,
			})),
		};
	});
