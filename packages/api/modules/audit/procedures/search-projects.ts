/**
 * `audit.searchProjects` — typeahead search over the caller's
 * organization projects, for the audit-log "Project" filter combobox.
 *
 * Authorization: same gate as `audit.list` — the caller must be an
 * org owner/admin OR a deployment admin (env-list bypass). Personal
 * context calls always return an empty list because the personal viewer
 * never shows the project combobox.
 *
 * Defense in depth: the SQL query is constrained to
 * `Project.organizationId = input.organizationId`, so no cross-org
 * project ever leaks. The result is capped at 50 rows.
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
	projects: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			icon: z.string().nullable(),
		}),
	),
});

export const searchAuditProjectsProcedure = protectedProcedure
	.input(inputSchema)
	.use(requireAuditLogReadOrDeploymentAdmin())
	.route({
		method: "POST",
		path: "/audit/search-projects",
		tags: ["Audit"],
		summary: "Search org projects for the audit-log project filter",
		description:
			"Typeahead search over the caller's organization projects. Returns up to 50 rows. Personal-context calls return an empty list.",
	})
	.output(outputSchema)
	.handler(async ({ input }) => {
		// Personal-context calls never show the combobox.
		if (!input.organizationId) {
			return { projects: [] };
		}

		const trimmed = (input.query ?? "").trim();

		const projects = await db.project.findMany({
			where: {
				// Hard tenant clamp — even if the gate let an attacker through,
				// they could never read a different org's projects from here.
				organizationId: input.organizationId,
				deletedAt: null,
				...(trimmed
					? {
							name: { contains: trimmed, mode: "insensitive" },
						}
					: {}),
			},
			take: input.limit ?? 20,
			orderBy: [{ name: "asc" }],
			select: {
				id: true,
				name: true,
				icon: true,
			},
		});

		return {
			projects: projects.map((p) => ({
				id: p.id,
				name: p.name,
				icon: p.icon ?? null,
			})),
		};
	});
